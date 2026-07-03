/* ============================================================
 * EDTI STUDIO — PORTFÓLIÓ DEMÓ: BATCH route-modul
 * ------------------------------------------------------------
 * A mock_core.js UTÁN töltődik be minden oldalon. A batch-oldalak
 * (batch.html [dub_full], transcribe_batch.html [transcript_only],
 * subtitle_batch.html [subtitles_only]) teljes API-felületét adja:
 *
 *   GET    /api/batch/status          → {queue_counts:{...}}
 *   GET    /api/batch/items?limit=N   → CSUPASZ TÖMB (nem objektum!)
 *   SSE    /api/batch/stream          → 'state' event: {queue_counts, items}
 *   POST   /api/batch/cancel/{itemId}
 *   DELETE /api/batch/item/{itemId}
 *   POST   /api/batch/retry/{itemId}
 *   POST   /api/batch/reset-stuck
 *   POST   /api/batch/cleanup-storage → {freed_mb, deleted_jobs}
 *   POST   /api/flow/quick-combo      → {flow_run_id} (quick_combo.js)
 *
 * FONTOS: az upload-trió (/api/batch/upload/init|chunk|finalize) a CORE
 * modul tulajdona — itt szándékosan NINCS regisztrálva. A finalize által
 * létrehozott MOCK.sim job automatikusan megjelenik az itteni listákban,
 * mert a lista a sim-jobokból ÉLŐBEN épül (típus → mode leképezéssel).
 *
 * Letöltő linkek (<a href> / rejtett iframe): ezeket a mock NEM tudja
 * elfogni — valódi statikus fájloknak kell létezniük a repo-ban a
 * megfelelő api/download/... útvonalakon (lásd az integrátori listát).
 * ============================================================ */
(function () {
    'use strict';

    if (!window.MOCK) {
        console.error('[MOCK/batch] mock_core.js nem töltődött be — a batch route-ok kimaradnak.');
        return;
    }
    const M = window.MOCK;

    // ─── Csoport-specifikus perzisztens állapot ─────────────────
    // MOCK.state.extra.batch:
    //   ids       — job_id (string) → numerikus batch_queue id (int)
    //   nextId    — következő kiosztható int id
    //   attempts  — job_id → próbálkozás-számláló (retry növeli)
    //   deleted   — job_id → true (a batch-listából törölt tételek)
    //   seeded    — saját transcribe-fixture egyszeri seed-flagje
    //   qcSeq     — quick-combo id-pool körforgó indexe (demo-qc-1..3)
    //   flow_runs — quick-combo indítások naplója (max 20)
    const EX = (M.state.extra.batch = M.state.extra.batch || {});
    EX.ids = EX.ids || {};
    EX.nextId = EX.nextId || 1;
    EX.attempts = EX.attempts || {};
    EX.deleted = EX.deleted || {};
    EX.qcSeq = EX.qcSeq || 0;
    EX.flow_runs = EX.flow_runs || [];

    // A core-fixture-ök, amiket törléskor csak ELREJTÜNK (más oldalak —
    // dub/subtitle/jobs — továbbra is látják őket), nem sim.remove-oljuk.
    const FIXTURE_IDS = {
        'demo-dub-1': true, 'demo-sub-1': true, 'demo-ppt-1': true,
        'demo-dub-bg': true, 'demo-tr-1': true,
    };

    // sim-jobtípus → batch mode. Ami nincs itt (ppt_narrate, intro_outro,
    // course …), az NEM batch-tétel — más oldal/modul listázza.
    const MODE_BY_TYPE = {
        dub: 'dub_full',
        transcribe: 'transcript_only',
        subtitle: 'subtitles_only',
    };

    // ─── Saját fixture: kész transcribe-job, hogy a transcribe_batch
    // oldal se legyen üres első látogatáskor ─────────────────────
    (function seedBatchFixtures() {
        if (EX.seeded) return;
        const H = 3600 * 1000;
        if (!M.sim.get('demo-tr-1')) {
            const j = M.sim.create('transcribe', {
                id: 'demo-tr-1',
                filename: 'Vizsgafelkeszito_konzultacio.mp4',
                mode: 'transcript_only',
                durationSec: 1,
            });
            j.startTs = Date.now() - 4 * H;      // rég kész
            j.created_at = M.ts(Date.now() - 4 * H);
        }
        EX.seeded = true;
        M.save();
    })();

    // ─── Segédek ────────────────────────────────────────────────
    // Stabil numerikus batch_queue-id a job_id-hoz (a frontend int-ként
    // interpolálja onclick-be: deleteItem(3) — string prefix itt tilos!).
    function intId(jobId) {
        if (!EX.ids[jobId]) {
            EX.ids[jobId] = EX.nextId++;
            M.save();
        }
        return EX.ids[jobId];
    }

    function jobIdByInt(n) {
        n = Number(n);
        for (const k in EX.ids) {
            if (EX.ids[k] === n) return k;
        }
        return null;
    }

    // Egy sim-job → batch-item leképezés PONTOSAN a frontend által olvasott
    // mezőnevekkel. job_status CSAK running állapotban kap objektumot
    // (queued/done sorban null — különben a '⚠️ Beragadt' ág renderelne).
    function toItem(j, s, mode) {
        let status;
        let jobStatus = null;
        let updatedAt = j.created_at;

        if (s.status === 'pending') {
            status = 'queued';
        } else if (s.status === 'cancelled') {
            status = 'cancelled';
        } else if (s.status === 'error') {
            status = 'error';
        } else if (s.status === 'done') {
            status = 'done';
            updatedAt = M.ts(j.doneAt || Date.now());
        } else if (s.stage === 'queued') {
            // A fázistábla eleje ("Sorban áll…") → a batch-sorban ez még
            // 'queued' státusz, job_status nélkül (Mégse gombbal).
            status = 'queued';
        } else {
            status = 'running';
            updatedAt = M.ts();
            jobStatus = {
                stage: s.stage,                        // DUB_STAGE_HU kulcs
                progress: s.progress,                  // szám, 0-100 (CSS width!)
                detail: s.detail,
                created_at: M.ts(j.startTs || Date.now()), // ETA-bázis
                updated_at: M.ts(),                    // friss → nincs Beragadt-badge
            };
        }

        return {
            id: intId(j.id),                           // int — cancel/retry/delete URL-ekhez
            job_id: String(j.id),                      // string — download URL + localStorage
            status: status,
            mode: mode,
            owner: j.owner || 'demo',
            original_filename: j.filename,
            attempts: EX.attempts[j.id] || 1,
            error_message: j.error || null,
            created_at: j.created_at,                  // 'YYYY-MM-DD HH:MM:SS' (UTC)
            updated_at: updatedAt,
            job_status: jobStatus,
        };
    }

    // A teljes batch-lista: minden batch-módú sim-job (fixture + user által
    // feltöltött), a törölt és a kétfázisú (edit_ready megállós, single-
    // oldalas) jobok nélkül. Frissesség: minden hívás újraszámolja a
    // progress-t a sim-ből — nincs cache-elt állapot.
    function buildItems() {
        const out = [];
        for (const j of M.sim.list()) {
            const mode = MODE_BY_TYPE[j.type];
            if (!mode) continue;                       // nem batch-típus
            if (EX.deleted[j.id]) continue;            // törölt tétel
            if (j.pausedStage) continue;               // single-oldalas kétfázisú dub
            out.push(toItem(j, M.sim.status(j.id), mode));
        }
        return out;                                    // sim.list() már created_at DESC
    }

    function queueCounts(items) {
        const c = { queued: 0, running: 0, done: 0, error: 0, cancelled: 0 };
        for (const it of items) {
            if (c[it.status] !== undefined) c[it.status] += 1;
        }
        return c;
    }

    // ─── GET /api/batch/status ──────────────────────────────────
    // A JS csak a queue_counts.{queued,running,done,error}-t olvassa;
    // a running_item mező a valódi backend-parity kedvéért van itt.
    M.route('GET', 'api/batch/status', () => {
        const items = buildItems();
        const running = items.find(i => i.status === 'running') || null;
        return {
            queue_counts: queueCounts(items),
            running_item: running ? { id: running.id, job_id: running.job_id, original_filename: running.original_filename } : null,
        };
    });

    // ─── GET /api/batch/items ───────────────────────────────────
    // FIGYELEM: csupasz tömböt ad vissza (NEM {items:[...]}) — a kliens
    // közvetlenül .filter()-t hív rá. A ?limit=N query-t tiszteletben
    // tartjuk, bár a demóban sosem érjük el.
    M.route('GET', 'api/batch/items', (m, req) => {
        const items = buildItems();
        const limit = parseInt(req.query.get('limit') || '1000', 10);
        return isFinite(limit) && limit > 0 ? items.slice(0, limit) : items;
    });

    // ─── SSE /api/batch/stream ──────────────────────────────────
    // value_stream minta: 1 mp-enként újraszámoljuk a teljes payload-ot,
    // és CSAK változáskor emit-elünk 'state' eventet — pont mint a backend
    // (backend/utils/sse.py). Futó job alatt ez ~másodpercenkénti frissítés
    // (a progress + updated_at úgyis változik), üresjáratban néma stream.
    M.sse('api/batch/stream', (es) => {
        let last = '';
        es.every(1000, () => {
            const items = buildItems();
            const payload = { queue_counts: queueCounts(items), items: items };
            const str = JSON.stringify(payload);
            if (str !== last) {
                last = str;
                es.emit('state', payload);
            }
        });
    });

    // ─── POST /api/batch/cancel/{itemId} ────────────────────────
    // itemId = numerikus batch_queue id (item.id), NEM job_id!
    M.route('POST', 'api/batch/cancel/(\\d+)', (m) => {
        const jobId = jobIdByInt(m[1]);
        if (jobId) M.sim.cancel(jobId);
        return {};                                     // a kliens nem olvassa
    });

    // ─── DELETE /api/batch/item/{itemId} ────────────────────────
    // Fixture-t csak elrejtünk (más oldalak listái élnek tovább);
    // user-jobot ténylegesen eltávolítunk a sim-ből is.
    M.route('DELETE', 'api/batch/item/(\\d+)', (m) => {
        const jobId = jobIdByInt(m[1]);
        if (jobId) {
            EX.deleted[jobId] = true;
            if (!FIXTURE_IDS[jobId]) M.sim.remove(jobId);
            M.save();
        }
        return {};
    });

    // ─── POST /api/batch/retry/{itemId} ─────────────────────────
    // Újraindítja a szimulációt (progress nulláról), attempts +1.
    M.route('POST', 'api/batch/retry/(\\d+)', (m) => {
        const jobId = jobIdByInt(m[1]);
        if (jobId) {
            EX.attempts[jobId] = (EX.attempts[jobId] || 1) + 1;
            M.sim.retry(jobId);
            M.save();
        }
        return {};
    });

    // ─── POST /api/batch/reset-stuck ────────────────────────────
    // A demóban a jobok sosem ragadnak be (az updated_at mindig friss),
    // így ez no-op — a kliens a választ amúgy sem olvassa.
    M.route('POST', 'api/batch/reset-stuck', () => ({ reset: 0 }));

    // ─── POST /api/batch/cleanup-storage ────────────────────────
    // A "Letöltöttem mindent" megerősítés után fut. A kész tételeket
    // eltakarítja a batch-sorból, és élethű MB-összeget jelent vissza
    // (a kliens alert-ben mutatja: freed_mb + deleted_jobs).
    M.route('POST', 'api/batch/cleanup-storage', () => {
        let freed = 0;
        let n = 0;
        for (const it of buildItems()) {
            if (it.status !== 'done') continue;
            n += 1;
            // Determinisztikus-ízű pszeudo-méret: 600-1500 MB / job.
            freed += 600 + ((it.id * 137) % 900);
            EX.deleted[it.job_id] = true;
            if (!FIXTURE_IDS[it.job_id]) M.sim.remove(it.job_id);
        }
        M.save();
        return { freed_mb: freed, deleted_jobs: n };
    });

    // ─── POST /api/flow/quick-combo ─────────────────────────────
    // quick_combo.js: kész job-ra fűzött mini-flow ("Folytasd intro/
    // outro-val / felirattal / szinkronnal"). A demóban egy ÚJ sim-jobot
    // indítunk a lánc-típusnak megfelelő fázistáblával, FIX id-poolból
    // (demo-qc-1..3, körforgó) — így a letöltő-linkekhez előre létező
    // statikus fájlok tartozhatnak.
    // A kliens a flow_run_id-n .slice(0,8)-at hív → mindig string, 8+ kar.
    M.route('POST', 'api/flow/quick-combo', (m, req) => {
        const b = req.body || {};
        const src = b.source_job_id ? M.sim.get(String(b.source_job_id)) : null;
        const chain = (Array.isArray(b.chain_after) && b.chain_after[0]) ? b.chain_after[0] : {};

        // chain-típus → sim-jobtípus + élethű futásidő
        let type = 'intro_outro', dur = 45 + Math.floor(Math.random() * 30);
        if (chain.type === 'dub') { type = 'dub'; dur = 90 + Math.floor(Math.random() * 60); }
        else if (chain.type === 'subtitle') { type = 'subtitle'; dur = 60 + Math.floor(Math.random() * 40); }

        // Körforgó id-pool: demo-qc-1 → 2 → 3 → 1 …
        EX.qcSeq = (EX.qcSeq % 3) + 1;
        const nodeId = 'demo-qc-' + EX.qcSeq;
        M.sim.remove(nodeId);                          // pool-újrahasznosítás
        delete EX.deleted[nodeId];
        delete EX.attempts[nodeId];

        M.sim.create(type, {
            id: nodeId,
            filename: src ? src.filename : 'demo_video.mp4',
            mode: MODE_BY_TYPE[type] || 'intro_outro',
            owner: (src && src.owner) || 'demo',
            durationSec: dur,
            extra: { via: 'quick_combo', source_job_id: b.source_job_id || null, config: chain.config || {} },
        });

        const flowRunId = M.uid('demo-flow');          // string, biztosan 8+ karakter
        EX.flow_runs.push({
            flow_run_id: flowRunId,
            source_job_id: b.source_job_id || null,
            source_node_type: b.source_node_type || null,
            node_job_id: nodeId,
            chain_after: b.chain_after || [],
            created_at: M.ts(),
        });
        if (EX.flow_runs.length > 20) EX.flow_runs = EX.flow_runs.slice(-20);
        M.save();

        return { flow_run_id: flowRunId, status: 'started', node_job_id: nodeId };
    });

    // ─── /api/health/stats dúsítás ──────────────────────────────
    // A mock_core beépített health-route-ja nem ad vram_total_mb / ram
    // MB-mezőket, a batch.html INLINE monitora viszont ezekből ír ki
    // szöveget ("7400 / 12288 MB") — enélkül "undefined MB" jelenne meg.
    // A core route-ot nem lehet felülregisztrálni (először illeszkedik),
    // ezért a fetch-láncba csomagolva egészítjük ki a választ. A shared.js
    // 401-wrapper később erre csomagolódik rá — a lánc sértetlen marad.
    const _prevFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = (input && input.url) ? input.url : String(input);
        const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const p = _prevFetch(input, init);
        if (method !== 'GET' || !/(^|\/)api\/health\/stats(\?|$)/.test(url)) return p;
        return p.then(async (r) => {
            try {
                const d = await r.clone().json();
                if (d && d.gpu && d.gpu.available && d.gpu.vram_total_mb == null) {
                    d.gpu.vram_total_mb = 12288;       // 12 GB demó-GPU
                    d.gpu.vram_used_mb = Math.round(12288 * (d.gpu.vram_percent || 0) / 100);
                }
                if (d && d.ram && d.ram.used_mb == null) {
                    d.ram.total_mb = 32768;            // 32 GB demó-RAM
                    d.ram.used_mb = Math.round(32768 * (d.ram.used_percent || 0) / 100);
                }
                return new Response(JSON.stringify(d), {
                    status: r.status,
                    headers: { 'Content-Type': 'application/json' },
                });
            } catch (e) {
                return r;                              // dúsítás-hiba → eredeti válasz
            }
        });
    };
})();
