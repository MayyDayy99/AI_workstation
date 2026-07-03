/* ============================================================
 * EDTI STUDIO — MOCK ROUTE-OK: PPT csoport
 * ------------------------------------------------------------
 * Lefedett oldalak:
 *   • ppt_narrate.html        (egy-fájlos 4-lépéses wizard)
 *   • ppt_narrate_batch.html  (tömeges lista + SSE diff-stream)
 *   • ppt_replace.html        (PPT háttércsere, 3 mód)
 *
 * A mock_core.js UTÁN töltődik be minden oldalon; a globális MOCK
 * API-ra regisztrál. A feldolgozás a MOCK.sim idő-alapú
 * szimulátorán fut (ppt_narrate / ppt_replace fázistáblák).
 *
 * FONTOS — nem-fetch elérések (ezeket a mock NEM tudja elfogni,
 * valódi statikus fájlnak kell léteznie ezeken az útvonalakon):
 *   api/ppt_narrate/download/{id}                (<a download> + iframe)
 *   api/ppt_narrate/preview/{id}/video.mp4       (<video src>)
 *   api/ppt_narrate/preview/{id}/thumbnail.jpg   (<img src> + poster)
 *   api/ppt_replace/download/{id}                (<a download>)
 * Ezért a user-feltöltések FIX 3 elemű id-poolból kapnak azonosítót
 * (demo-ppt-live-1..3, ill. demo-pptr-live-1..3), így a statikus
 * fájlok előre legenerálhatók.
 * ============================================================ */
(function () {
    'use strict';
    if (!window.MOCK) { console.warn('[MOCK/ppt] mock_core.js hiányzik'); return; }
    const M = window.MOCK;

    // ─── Csoport-specifikus perzisztens állapot ─────────────────
    function ext() {
        if (!M.state.extra.ppt) {
            M.state.extra.ppt = { pnPool: 0, prPool: 0, voices: null, seeded: false, histSeeded: false };
        }
        return M.state.extra.ppt;
    }

    const H = 3600 * 1000;

    // ─── Fixture-ök: ppt_replace kész job + history-sidebar seed ──
    (function seed() {
        const E = ext();
        if (!E.seeded) {
            // Kész háttércsere-job, hogy a ppt_replace oldalon legyen mit nézni.
            if (!M.sim.get('demo-pptr-1')) {
                M.sim.create('ppt_replace', { id: 'demo-pptr-1', filename: 'Halozatok_eloadas.mp4', durationSec: 1 });
                const j = M.sim.get('demo-pptr-1');
                j.startTs = Date.now() - 4 * H;
                j.created_at = M.ts(Date.now() - 4 * H);
            }
            E.seeded = true;
            M.save();
        }
        // A history-sidebar-ok localStorage-vezéreltek — üresen "Nincs korábbi
        // feladat"-ot mutatnának. Egyszer beleírjuk a fixture-öket (idempotens,
        // user-törlés után nem támad fel).
        if (!E.histSeeded) {
            try {
                const pn = JSON.parse(localStorage.getItem('pptNarrateJobs') || '[]');
                if (!pn.find(x => x.id === 'demo-ppt-1')) {
                    pn.unshift({ id: 'demo-ppt-1', name: 'Logikai_kapuk.pptx', date: new Date(Date.now() - 3 * H).toISOString() });
                    localStorage.setItem('pptNarrateJobs', JSON.stringify(pn.slice(0, 50)));
                }
                const pr = JSON.parse(localStorage.getItem('pptReplaceJobs') || '[]');
                if (!pr.find(x => x.id === 'demo-pptr-1')) {
                    pr.unshift({ id: 'demo-pptr-1', name: 'Halozatok_eloadas.mp4', date: new Date(Date.now() - 4 * H).toISOString() });
                    localStorage.setItem('pptReplaceJobs', JSON.stringify(pr.slice(0, 20)));
                }
            } catch (_) { /* localStorage tiltva — nem kritikus */ }
            E.histSeeded = true;
            M.save();
        }
    })();

    // ─── Fix id-pool a user-feltöltésekhez (max 3, körben) ──────
    function poolId(prefix, counterKey) {
        const E = ext();
        E[counterKey] = ((E[counterKey] || 0) % 3) + 1;
        const id = prefix + E[counterKey];
        // Újrahasznosítás: a korábbi azonos id-jú szimulált job-ot eldobjuk.
        if (M.sim.get(id)) M.sim.remove(id);
        M.save();
        return id;
    }

    // ═════════════════════════════════════════════════════════════
    //  PPT NARRATE  (/api/ppt_narrate)
    // ═════════════════════════════════════════════════════════════

    // 5 demó-dia a Logikai_kapuk.pptx-hez — a slides-lista, a fejezetek
    // és a "n/5 dia" detail is ebből dolgozik. A 4. dia szándékosan üres
    // (az UI '(üres)' + empty_slide_dur viselkedését mutatja).
    const DEMO_SLIDES = [
        {
            slide: 1,
            notes: 'Üdvözlöm Önöket a mai előadáson. Ma a logikai kapukkal ismerkedünk meg, amelyek minden digitális áramkör építőkövei.',
            notes_raw: 'Üdv! Téma: logikai kapuk = digitális áramkörök építőkövei (ld. jegyzet 3.1)',
            has_wav: true, wav_size_kb: 412,
        },
        {
            slide: 2,
            notes: 'Az ÉS kapu kimenete csak akkor lesz igaz, ha minden bemenete igaz. Az igazságtáblázatban ez az utolsó sor.',
            notes_raw: 'AND kapu — igazságtábla, kimenet=1 csak ha A=1 és B=1',
            has_wav: true, wav_size_kb: 388,
        },
        {
            slide: 3,
            notes: 'A VAGY kapu ezzel szemben már akkor igazat ad, ha legalább az egyik bemenete igaz. Figyeljék meg a különbséget az előző diához képest.',
            notes_raw: 'OR kapu — kimenet=1 ha A=1 vagy B=1; összevetés az AND-del',
            has_wav: true, wav_size_kb: 431,
        },
        {
            slide: 4,
            notes: '',
            notes_raw: '',
            has_wav: false, wav_size_kb: 0,
        },
        {
            slide: 5,
            notes: 'Összefoglalva: az ÉS, VAGY és NEM kapukból bármilyen logikai függvény felépíthető. A jövő heti gyakorlaton ezt áramkörökön is kipróbáljuk.',
            notes_raw: 'Összefoglalás + kitekintés: teljes rendszer {AND, OR, NOT}; gyakorlat jövő héten',
            has_wav: true, wav_size_kb: 402,
        },
    ];

    // Fejezetek — az 5 diához illeszkedő kezdőidők (a 4. dia üres → 3 mp).
    const DEMO_CHAPTERS = [
        { start: 0.0,  title: '1. Bevezetés' },
        { start: 16.2, title: '2. ÉS kapu' },
        { start: 39.8, title: '3. VAGY kapu' },
        { start: 66.4, title: '4. NEM kapu' },
        { start: 69.4, title: '5. Összefoglalás' },
    ];

    // A sim-státusz leképezése PONTOSAN azokra a mezőnevekre, amiket a
    // ppt_narrate oldalak olvasnak (status endpoint + /jobs listaelem).
    function pnStatus(id) {
        const s = M.sim.status(id);
        const o = {
            id: s.id,
            job_id: s.job_id,
            stage: s.stage,
            progress: s.progress,
            detail: s.detail,
            error_detail: s.error || null,
            status: s.status,
            owner: s.owner,
            original_filename: s.original_filename,
            created_at: s.created_at,
            updated_at: s.updated_at,
            can_modify: true,
        };
        // Élethűbb narrálás-detail: "k/5 dia szintetizálása…"
        if (o.stage === 'narrating') {
            const k = Math.max(1, Math.min(5, 1 + Math.floor((o.progress - 20) / 13)));
            o.detail = k + '/5 dia szintetizálása (XTTS)…';
        }
        return o;
    }

    function pnJobsList() {
        return M.sim.list('ppt_narrate').map(j => pnStatus(j.id));
    }

    // ── Feltöltés (single: fetch FormData · batch: nyers XHR) ──
    M.route('POST', 'api/ppt_narrate/upload', (m, req) => {
        let fname = 'eloadas.pptx';
        if (req.form) {
            const f = req.form.get('file');
            if (f && f.name) fname = f.name;
        }
        const id = poolId('demo-ppt-live-', 'pnPool');
        M.sim.create('ppt_narrate', {
            id: id,
            filename: fname,
            mode: 'ppt_narrate',
            durationSec: 50 + Math.floor(Math.random() * 25),
            autostart: false, // 'uploaded' stádiumban vár a /process-re
        });
        return { job_id: id, status: 'uploaded' };
    });

    // ── Feldolgozás indítása (single start + batch bulk-start) ──
    M.route('POST', 'api/ppt_narrate/process/([^/]+)', (m, req) => {
        const j = M.sim.get(m[1]);
        if (!j) return M.resp(404, { detail: 'A feladat nem található (demo).' });
        const st = M.sim.status(m[1]);
        if (st.status === 'running') return M.resp(423, { detail: 'A feladat már fut vagy sorban áll.' });
        // Konfiguráció eltárolása (voice_key / language / empty_slide_dur)
        if (req.body) { j.extra = Object.assign({}, j.extra, req.body); }
        if (j.cancelled || j.doneAt) M.sim.retry(m[1]);
        else M.sim.start(m[1]);
        M.save();
        return { status: 'queued' };
    });

    // ── Státusz (2 mp-es poll + history-enrich + history-click) ──
    M.route('GET', 'api/ppt_narrate/status/([^/]+)', (m) => {
        if (!M.sim.get(m[1])) return M.resp(404, { detail: 'A feladat nem található (demo).' });
        return pnStatus(m[1]);
    });

    // ── SSE: egy job élő státusza — event: 'status', teljes JSON ──
    M.sse('api/ppt_narrate/status/([^/]+)/stream', (es, m) => {
        es.every(1000, () => {
            const st = pnStatus(m[1]);
            es.emit('status', st);
            // Terminális állapot után lezárjuk a streamet (timer-takarítás).
            if (st.stage === 'done' || st.stage === 'error' || st.stage === 'cancelled') {
                setTimeout(() => es.close(), 50);
            }
        });
    });

    // ── Job-lista (batch oldal, ?limit=500) ──
    M.route('GET', 'api/ppt_narrate/jobs', (m, req) => {
        let items = pnJobsList();
        const lim = parseInt(req.query.get('limit') || '500', 10);
        if (lim > 0) items = items.slice(0, lim);
        return items;
    });

    // ── SSE: batch diff-stream — snapshot → update/delete frame-ek ──
    M.sse('api/ppt_narrate/jobs/stream', (es) => {
        let last = null; // id → render-szignatúra (stage:progress:detail)
        const sigOf = (it) => it.stage + ':' + it.progress + ':' + (it.detail || '') + ':' + (it.error_detail || '');
        es.every(2000, () => {
            const items = pnJobsList();
            const cur = {};
            items.forEach(it => { cur[it.id] = sigOf(it); });
            if (last === null) {
                // Első frame: teljes snapshot — ettől áll le az 5 mp-es polling.
                es.emit('snapshot', { items: items });
                last = cur;
                return;
            }
            for (const it of items) {
                if (last[it.id] !== cur[it.id]) es.emit('update', { item: it });
            }
            for (const id of Object.keys(last)) {
                if (!(id in cur)) es.emit('delete', { id: id });
            }
            last = cur;
        });
    });

    // ── Letöltés / előnézet — az UI <a href>/<video src>/<img src>/iframe
    //    útján éri el ezeket (statikus fájl kell!), de fetch-elérésre is
    //    válaszolunk biztonsági hálóként. ──
    M.route('GET', 'api/ppt_narrate/download/([^/]+)', () => M.file(M.ASSET_VIDEO));
    M.route('GET', 'api/ppt_narrate/preview/([^/]+)/video\\.mp4', () => M.file(M.ASSET_VIDEO));
    M.route('GET', 'api/ppt_narrate/preview/([^/]+)/thumbnail\\.jpg', () => M.file(M.ASSET_THUMB));

    // ── Fejezetek a preview-modal alá (fetch — mockolható) ──
    M.route('GET', 'api/ppt_narrate/preview/([^/]+)/chapters', (m) => {
        if (!M.sim.get(m[1])) return []; // backend-viselkedés: probléma esetén []
        return DEMO_CHAPTERS;
    });

    // ── Dia-lista (lazy, a "Slide-regen" panel nyitásakor) ──
    M.route('GET', 'api/ppt_narrate/slides/([^/]+)', (m) => {
        if (!M.sim.get(m[1])) return M.resp(404, { detail: 'A feladat nem található (demo).' });
        return DEMO_SLIDES;
    });

    // ── Egy dia újragenerálása — a valódi backend 1-3 percig blokkol,
    //    a demó 6 mp alatt "végez". ──
    M.route('POST', 'api/ppt_narrate/regenerate-slide/([^/]+)', (m, req) => {
        const j = M.sim.get(m[1]);
        if (!j) return M.resp(404, { detail: 'A feladat nem található (demo).' });
        if (M.sim.status(m[1]).status === 'running') {
            return M.resp(423, { detail: 'A feladat éppen fut — a dia-újragenerálás csak kész állapotban indítható.' });
        }
        const slide = (req.body && req.body.slide) || 1;
        return new Promise(resolve => {
            setTimeout(() => resolve({ status: 'regenerated', slide: slide }), 6000);
        });
    });

    // ── Retry (single + history + batch) ──
    M.route('POST', 'api/ppt_narrate/retry/([^/]+)', (m) => {
        if (!M.sim.get(m[1])) return M.resp(404, { detail: 'A feladat nem található (demo).' });
        M.sim.retry(m[1]);
        return { status: 'retrying', job_id: m[1] };
    });

    // ── Törlés / leállítás (mindkét oldal ugyanezt hívja) ──
    M.route('DELETE', 'api/ppt_narrate/job/([^/]+)', (m) => {
        if (M.sim.get(m[1])) M.sim.remove(m[1]);
        return { status: 'deleted' };
    });

    // ── Voice-library (voice_picker.js) ────────────────────────
    function voices() {
        const E = ext();
        if (!E.voices) {
            E.voices = [
                { voice_key: 'anna-tanarno',   display_name: 'Anna tanárnő',   uploader: 'demo',  language_hint: 'hu', created_at: M.ts(Date.now() - 21 * 24 * H), size_kb: 812 },
                { voice_key: 'gabor-mernok',   display_name: 'Gábor mérnök',   uploader: 'demo',  language_hint: 'hu', created_at: M.ts(Date.now() - 9 * 24 * H),  size_kb: 754 },
                { voice_key: 'emily-lecturer', display_name: 'Emily lecturer', uploader: 'peter', language_hint: 'en', created_at: M.ts(Date.now() - 3 * 24 * H),  size_kb: 690 },
            ];
            M.save();
        }
        return E.voices;
    }

    function slugify(name) {
        return String(name || 'voice')
            .normalize('NFD').replace(/[̀-ͯ]/g, '') // ékezet-leszedés
            .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
            || 'voice';
    }

    M.route('GET', 'api/ppt_narrate/voices', () => voices());

    M.route('POST', 'api/ppt_narrate/voices', (m, req) => {
        const list = voices();
        let displayName = 'Új hangminta', langHint = '';
        if (req.form) {
            displayName = String(req.form.get('display_name') || displayName);
            langHint = String(req.form.get('language_hint') || '');
        }
        let key = slugify(displayName);
        while (list.find(v => v.voice_key === key)) key += '-2'; // ütközés-kerülés
        const v = {
            voice_key: key,
            display_name: displayName,
            uploader: 'demo',
            language_hint: langHint,
            created_at: M.ts(),
            size_kb: 700 + Math.floor(Math.random() * 200),
        };
        list.push(v);
        M.save();
        return { voice_key: v.voice_key, display_name: v.display_name };
    });

    M.route('DELETE', 'api/ppt_narrate/voices/([^/]+)', (m) => {
        const E = ext();
        const list = voices();
        const key = decodeURIComponent(m[1]);
        if (!list.find(v => v.voice_key === key)) {
            return M.resp(404, { detail: 'Nincs ilyen hangminta (demo).' });
        }
        E.voices = list.filter(v => v.voice_key !== key);
        M.save();
        return { status: 'deleted', voice_key: key };
    });

    // ═════════════════════════════════════════════════════════════
    //  PPT REPLACE  (/api/ppt_replace)
    // ═════════════════════════════════════════════════════════════

    // A ppt_replace checkStatus() res.ok-ot NEM néz és vakon JSON-t parse-ol
    // → ismert id-re MINDIG 200 + valid JSON megy (a stage/progress/detail/
    // error_detail/error mezőkkel); ismeretlenre 404 JSON (a history-click
    // útvonal res.ok-ot néz és visszalép az upload-lépésre).
    function prStatus(id) {
        const s = M.sim.status(id);
        return {
            id: s.id,
            job_id: s.job_id,
            stage: s.stage,
            progress: s.progress,
            detail: s.detail,
            error_detail: s.error || null,
            error: s.error || null,
            status: s.status,
            owner: s.owner,
            original_filename: s.original_filename,
            created_at: s.created_at,
            updated_at: s.updated_at,
        };
    }

    M.route('POST', 'api/ppt_replace/upload', (m, req) => {
        let fname = 'eloadas_video.mp4';
        if (req.form) {
            const f = req.form.get('file');
            if (f && f.name) fname = f.name;
            // reconstruct módban nincs pptx_file — mindkettő érvényes demó-eset.
        }
        const id = poolId('demo-pptr-live-', 'prPool');
        M.sim.create('ppt_replace', {
            id: id,
            filename: fname,
            mode: 'ppt_replace',
            durationSec: 55 + Math.floor(Math.random() * 30),
            autostart: false,
        });
        return { job_id: id };
    });

    M.route('POST', 'api/ppt_replace/process/([^/]+)', (m, req) => {
        const j = M.sim.get(m[1]);
        if (!j) return M.resp(404, { detail: 'A feladat nem található (demo).' });
        if (M.sim.status(m[1]).status === 'running') {
            return M.resp(423, { detail: 'A korábbi feldolgozó-szál még fut.' });
        }
        if (req.body) { j.extra = Object.assign({}, j.extra, req.body); }
        // Resume-flow: cancelled/hibás/kész állapotból újraindítás.
        if (j.cancelled || j.error || j.doneAt) M.sim.retry(m[1]);
        else M.sim.start(m[1]);
        M.save();
        return { status: 'queued' };
    });

    M.route('GET', 'api/ppt_replace/status/([^/]+)', (m) => {
        if (!M.sim.get(m[1])) return M.resp(404, { detail: 'A feladat nem található (demo).' });
        return prStatus(m[1]);
    });

    // Globális cancel-endpoint — a ppt_replace "Szüneteltetés" ezt hívja.
    // (Más csoport is regisztrálhatja; az első regisztráció nyer, a
    // viselkedés — MOCK.sim.cancel — mindenhol ugyanaz.)
    M.route('POST', 'api/cancel/([^/]+)', (m) => {
        M.sim.cancel(m[1]);
        return { status: 'cancelling' };
    });

    M.route('POST', 'api/ppt_replace/retry/([^/]+)', (m) => {
        if (!M.sim.get(m[1])) return M.resp(404, { detail: 'A feladat nem található (demo).' });
        M.sim.retry(m[1]);
        return { status: 'queued_retry' };
    });

    // Letöltés — dinamikus <a download> navigáció (statikus fájl kell),
    // fetch-biztonsági háló itt is:
    M.route('GET', 'api/ppt_replace/download/([^/]+)', () => M.file(M.ASSET_VIDEO));

    M.route('DELETE', 'api/ppt_replace/job/([^/]+)', (m) => {
        if (M.sim.get(m[1])) M.sim.remove(m[1]);
        return { status: 'deleted' };
    });

    // ═════════════════════════════════════════════════════════════
    //  QUICK-COMBO (batch oldal: "Intro/Outro mindre" + soronkénti gomb)
    // ═════════════════════════════════════════════════════════════
    // A kliens r.flow_run_id.slice(0,8)-at hív — a flow_run_id KÖTELEZŐEN
    // string. (Ha a flow-csoport is regisztrálja, az első nyer — mindkettő
    // string flow_run_id-t ad, így a viselkedés azonos.)
    M.route('POST', 'api/flow/quick-combo', () => {
        return { flow_run_id: String(M.uid('flow-run')) };
    });
})();
