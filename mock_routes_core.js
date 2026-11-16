/* ============================================================
 * EDTI STUDIO — MOCK ROUTE-OK: CORE (dub single-file flow)
 * ------------------------------------------------------------
 * A mock_core.js UTÁN töltődik be minden oldalon. Az index/dub
 * oldalak (app.js + upload_queue.js + dedup.js) által használt
 * "egy-videós szinkron" flow-t fedi le:
 *
 *   feltöltés (chunked init/chunk/finalize VAGY sima /api/upload)
 *     → hangminta (upload_voice_ref)
 *     → /api/start/{id}  — 1. fázis (extract…refine), 60%-nál megáll
 *     → edit_ready       — szegmens-szerkesztő (/api/job/{id})
 *     → /api/generate/{id} — 2. fázis (tts…mux) → done → letöltések
 *
 * A user-feltöltések FIX, 3 elemű job-id poolt kapnak
 * (demo-live-1..3, körben forogva), hogy a letöltési <a href>
 * navigációkhoz előre létezhessenek statikus fájlok.
 * ============================================================ */
(function () {
    'use strict';

    if (!window.MOCK) {
        console.error('[MOCK/core] mock_core.js nem töltődött be — a core route-ok kimaradnak.');
        return;
    }
    const M = window.MOCK;

    // ─── Csoport-állapot (perzisztens, localStorage-ba mentve) ──
    if (!M.state.extra.core) {
        M.state.extra.core = {
            uploads: {},   // upload_id → {filename, mode, purpose, total_size}
            itemSeq: 17,   // batch-item sorszám (finalize .id mező)
            pool: 0,       // demo-live-1..3 pool körforgás indexe
            segments: {},  // job_id → mentett szegmenslista (szerkesztő)
        };
        M.save();
    }
    const CORE = M.state.extra.core;

    // Fix job-id pool a user-feltöltéseknek — a letöltési statikus
    // fájlok (api/download/demo-live-N/…) így előre legyárthatók.
    const POOL = ['demo-live-1', 'demo-live-2', 'demo-live-3'];
    function nextPoolId() {
        const id = POOL[CORE.pool % POOL.length];
        CORE.pool += 1;
        // Régi lenyomatok takarítása (a pool-id újrahasznosítódik):
        delete CORE.segments[id];
        M.save();
        return id;
    }

    // ─── Minta-szegmensek: 8 mondatos magyar előadás-részlet ────
    // (numerikus start/end KELL — a renderSegments .toFixed(2)-t hív!)
    const SAMPLE_SEGMENTS = [
        { start: 0.00,  end: 6.48,  hu: 'Üdvözlök mindenkit a digitális technika harmadik előadásán.',                                en: 'Welcome everyone to the third lecture of Digital Technology.' },
        { start: 6.72,  end: 14.10, hu: 'A mai témánk a kombinációs hálózatok, ezen belül a logikai kapuk működése.',                 en: 'Today\'s topic is combinational networks, in particular how logic gates work.' },
        { start: 14.55, end: 22.30, hu: 'Először nézzük meg az ÉS kaput: a kimenet csak akkor egy, ha minden bemenet egy.',           en: 'First, let us look at the AND gate: the output is one only if every input is one.' },
        { start: 22.75, end: 30.90, hu: 'A VAGY kapu ezzel szemben már egyetlen egyes bemenetre is egyet ad a kimenetén.',            en: 'The OR gate, by contrast, outputs one even for a single high input.' },
        { start: 31.20, end: 39.85, hu: 'Az inverter, vagyis a NEM kapu egyszerűen megfordítja a bemeneti jelet.',                    en: 'The inverter, that is the NOT gate, simply reverses the input signal.' },
        { start: 40.10, end: 48.62, hu: 'A NAND és NOR kapuk univerzálisak: belőlük bármilyen logikai függvény felépíthető.',         en: 'NAND and NOR gates are universal: any logic function can be built from them.' },
        { start: 49.00, end: 57.44, hu: 'A táblán látható igazságtáblázat mind a négy bemeneti kombinációt összefoglalja.',           en: 'The truth table on the board summarizes all four input combinations.' },
        { start: 57.80, end: 64.20, hu: 'A következő alkalommal ezekből építünk fel egy egyszerű összeadó áramkört.',                 en: 'Next time, we will build a simple adder circuit from these.' },
    ];

    function getSegments(jobId) {
        const saved = CORE.segments[jobId];
        if (Array.isArray(saved) && saved.length) return saved;
        // Mély másolat, hogy a kliens-oldali szerkesztés ne piszkálja a mintát:
        return SAMPLE_SEGMENTS.map(s => ({ start: s.start, end: s.end, hu: s.hu, en: s.en }));
    }

    // A kliens felől jövő szegmensek fertőtlenítése (numerikus idők!).
    function sanitizeSegments(list) {
        if (!Array.isArray(list)) return null;
        const out = [];
        for (const s of list) {
            if (!s) continue;
            const start = Number(s.start), end = Number(s.end);
            out.push({
                start: isFinite(start) ? Math.round(start * 100) / 100 : 0,
                end: isFinite(end) ? Math.round(end * 100) / 100 : 0,
                hu: s.hu == null ? '' : String(s.hu),
                en: s.en == null ? '' : String(s.en),
            });
        }
        return out.length ? out : null;
    }

    // ─── Felirat-generátorok (fetch-alapú exportokhoz) ──────────
    function pad2(n) { return String(n).padStart(2, '0'); }
    function fmtTime(t, sep) {
        t = Math.max(0, Number(t) || 0);
        const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
        const ms = Math.round((t - Math.floor(t)) * 1000);
        return pad2(h) + ':' + pad2(m) + ':' + pad2(s) + sep + String(ms).padStart(3, '0');
    }
    // filename dönti el, mi kerül a cue-ba: hu / en / kétnyelvű.
    function cueText(seg, filename) {
        const f = String(filename).toLowerCase();
        if (f.indexOf('bilingual') !== -1) return seg.hu + '\n' + seg.en;
        if (/^hu[._]/.test(f)) return seg.hu;
        return seg.en;
    }
    function buildVtt(segs, filename) {
        let out = 'WEBVTT\n\n';
        segs.forEach(seg => {
            out += fmtTime(seg.start, '.') + ' --> ' + fmtTime(seg.end, '.') + '\n' + cueText(seg, filename) + '\n\n';
        });
        return out;
    }
    function buildSrt(segs, filename) {
        let out = '';
        segs.forEach((seg, i) => {
            out += (i + 1) + '\n' + fmtTime(seg.start, ',') + ' --> ' + fmtTime(seg.end, ',') + '\n' + cueText(seg, filename) + '\n\n';
        });
        return out;
    }

    // Egyszerű VTT/SRT parser az import_vtt-hez (fail-soft: ha nem
    // sikerül értelmezni, a minta-szegmenseket adjuk vissza).
    function parseVtt(text) {
        const segs = [];
        const blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
        const timeRe = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
        for (const block of blocks) {
            const lines = block.split('\n').filter(l => l.trim() !== '');
            const ti = lines.findIndex(l => l.indexOf('-->') !== -1);
            if (ti === -1) continue;
            const m = lines[ti].match(timeRe);
            if (!m) continue;
            const toSec = (h, mi, s, ms) =>
                (parseInt(h || '0', 10) * 3600) + (parseInt(mi, 10) * 60) + parseInt(s, 10) +
                parseInt(String(ms).padEnd(3, '0'), 10) / 1000;
            const start = Math.round(toSec(m[1], m[2], m[3], m[4]) * 100) / 100;
            const end = Math.round(toSec(m[5], m[6], m[7], m[8]) * 100) / 100;
            const txt = lines.slice(ti + 1).join(' ').trim();
            if (!txt) continue;
            segs.push({ start: start, end: end, hu: txt, en: txt });
        }
        return segs;
    }

    // ─── Job-létrehozás a feltöltésekhez ────────────────────────
    // purpose 'dub_single' → interaktív flow: NEM indul automatikusan,
    // és 60%-nál megáll (edit_ready), amíg a Generate el nem indítja
    // a 2. fázist. Minden más purpose: sima, végigfutó dub-job.
    function createUploadJob(filename, mode, purpose) {
        const single = purpose === 'dub_single';
        // Batch-feltöltés (purpose nélkül): a job azonnal sorba áll, és a batch-lap
        // módja szerinti típust kap — a felirat/leirat batch a saját id-poolját, hogy
        // a letöltő linkek statikus fájljai (api/download/demo-sub|tr-live-N/…) létezzenek.
        if (!single && (mode === 'subtitles_only' || mode === 'transcript_only')) {
            const sub = mode === 'subtitles_only';
            const key = sub ? 'batchSubPool' : 'batchTrPool';
            CORE[key] = (CORE[key] || 0) + 1;
            const pid = (sub ? 'demo-sub-live-' : 'demo-tr-live-') + (((CORE[key] - 1) % 3) + 1);
            if (M.sim.get(pid)) M.sim.remove(pid);
            const bj = M.sim.create(sub ? 'subtitle' : 'transcribe', {
                id: pid, filename: filename || 'demo_video.mp4', mode: mode,
                durationSec: 25 + Math.floor(Math.random() * 15), autostart: true,
            });
            M.save();
            return bj;
        }
        const id = nextPoolId();
        const job = M.sim.create('dub', {
            id: id,
            filename: filename || 'demo_video.mp4',
            mode: mode || 'dub_full',
            durationSec: 40 + Math.floor(Math.random() * 15),
            autostart: !single,                          // dub_single: Start gombra vár
            pausedStage: single ? 'edit_ready' : null,   // 60%-os megálló
        });
        job.phase2 = false;
        M.save();
        return job;
    }

    // Öngyógyítás: elavult (pl. régebbi localStorage-history-ból jövő)
    // job-id-khez legyártunk egy friss szimulált jobot, hogy a demó
    // sose ragadjon be "Nem található" hibába retry/start esetén.
    function ensureJob(id, autostart) {
        let j = M.sim.get(id);
        if (!j) {
            j = M.sim.create('dub', {
                id: id, filename: 'video.mp4', mode: 'dub_full',
                durationSec: 40 + Math.floor(Math.random() * 15),
                autostart: autostart !== false,
                pausedStage: 'edit_ready',
            });
            j.phase2 = false;
            M.save();
        }
        return j;
    }

    /* ============================================================
     * 1) CHUNKED FELTÖLTÉS — upload_queue.js (elsődleges út)
     * ========================================================== */

    // INIT — {upload_id, chunk_size, received_chunks, status, existing_job_id}
    // Nagy chunk_size-t adunk vissza, hogy nagy fájlnál is kevés
    // (szimulált) chunk-POST legyen — a kliens ezt szeleteléshez használja.
    M.route('POST', 'api/batch/upload/init', (m, req) => {
        const b = req.body || {};
        const uploadId = M.uid('up');
        CORE.uploads[uploadId] = {
            filename: b.filename || 'demo_video.mp4',
            mode: b.mode || 'dub_full',
            purpose: b.purpose || null,
            total_size: b.total_size || 0,
        };
        M.save();
        return {
            upload_id: uploadId,
            chunk_size: 64 * 1024 * 1024,   // 64 MiB → gyors demó-feltöltés
            received_chunks: [],            // resume nincs a demóban
            status: null,
            existing_job_id: null,
        };
    });

    // CHUNK — nyers Blob body XHR-en át; csak a 2xx státusz számít.
    // (A mock XHR ~600 ms alatt "tolja fel" a progress-t chunkonként.)
    M.route('POST', 'api/batch/upload/chunk', () => ({}));

    // FINALIZE — a dub_single flow-nak KÖTELEZŐ a job_id, különben az
    // app.js "nem adott vissza job-azonosítót" hibát ír ki.
    M.route('POST', 'api/batch/upload/finalize', async (m, req) => {
        const uploadId = req.query.get('upload_id') || '';
        const up = CORE.uploads[uploadId] || { filename: 'demo_video.mp4', mode: 'dub_full', purpose: 'dub_single' };
        delete CORE.uploads[uploadId];
        M.save();
        // A darabolt feltöltés célja (purpose) dönti el, milyen job születik — a valódi
        // backendben is (upload_chunked.py). A modulok saját upload-route-ját hívjuk,
        // így a job ugyanaz, mintha a régi, egyben feltöltős végpontra jött volna.
        const fd = new FormData();
        fd.append('file', new File([new Blob(['demo'])], up.filename || 'demo_video.mp4'));
        if (up.mode) fd.append('mode', up.mode);
        const viaRoute = async (url) => {
            const r = await M.call('POST', url, fd);
            return r.json();
        };
        const p = up.purpose || '';
        if (p === 'intro_outro') { const j = await viaRoute('api/intro_outro/upload'); return { job_id: j.job_id, status: 'uploaded' }; }
        if (p === 'ppt_narrate') { const j = await viaRoute('api/ppt_narrate/upload'); return { job_id: j.job_id, status: 'uploaded' }; }
        if (p === 'ppt_replace') { const j = await viaRoute('api/ppt_replace/upload'); return { job_id: j.job_id, status: 'uploaded' }; }
        if (p === 'convert') { const j = await viaRoute('api/convert/__upload'); return { job_id: j.job_id, status: 'uploaded' }; }
        if (p === 'course_zip') { return viaRoute('api/course/upload?mode=' + encodeURIComponent(up.mode || 'dub_full')); }
        if (p === 'dub_single' && (up.mode === 'subtitles_only' || up.mode === 'transcript_only')) {
            const j = await viaRoute('api/upload?mode=' + encodeURIComponent(up.mode));
            return { job_id: j.job_id, status: 'uploaded' };
        }
        const job = createUploadJob(up.filename, up.mode, up.purpose);
        CORE.itemSeq += 1;
        M.save();
        if (p === 'dub_single') return { job_id: job.id, status: 'uploaded' };
        return {
            id: CORE.itemSeq,
            job_id: job.id,
            path: '/data/uploads/' + job.id + '/input.mp4',
            flow_run_id: null,
        };
    });

    // A megszakadt feltöltés folytatása (upload_queue.js): a demó nem őriz félkész
    // feltöltést, ezért mindig újrakezdést kér — csendben, route-hiba nélkül.
    M.route('GET', 'api/batch/upload/status/([^/]+)', () => M.resp(404, { detail: 'Nincs folytatható feltöltés (demo).' }));

    /* ============================================================
     * 2) FALLBACK FELTÖLTÉS + HANGMINTA
     * ========================================================== */

    // Egyszeri multipart POST (ha az UploadQueue nem töltődött be).
    M.route('POST', 'api/upload', (m, req) => {
        const mode = req.query.get('mode') || (req.form && req.form.get('mode')) || 'dub_full';
        if (mode === 'subtitles_only' || mode === 'transcript_only') {
            return M.call('POST', 'api/upload/__modes?mode=' + encodeURIComponent(mode), req.form)
                .then(r => r.json());
        }
        let name = 'demo_video.mp4';
        try {
            const f = req.form && req.form.get('file');
            if (f && f.name) name = f.name;
        } catch (_) {}
        const job = createUploadJob(name, 'dub_full', 'dub_single');
        return { job_id: job.id, detail: null };
    });

    // Hangminta (voice ref) — a siker-body-t a kliens nem olvassa.
    M.route('POST', 'api/upload_voice_ref', (m, req) => {
        const jobId = req.query.get('job_id');
        if (jobId) {
            const j = M.sim.get(jobId);
            if (j) { j.extra.voice_ref = true; M.save(); }
        }
        return {};
    });

    /* ============================================================
     * 3) PIPELINE VEZÉRLÉS — start / generate / cancel / retry
     * ========================================================== */

    // START — 1. fázis indítása. Body: {auto_extract, enhance_ref, mode?, force?}
    M.route('POST', 'api/start/([^/]+)', (m, req) => {
        const j = ensureJob(m[1], false);
        const b = req.body || {};
        if (b.mode) { j.mode = b.mode; }
        j.cancelled = false; j.error = null;
        M.sim.start(m[1]);       // csak akkor állít startTs-t, ha még nincs
        M.save();
        return {};
    });

    // GENERATE — 2. fázis (TTS) az edit_ready megálló után. A progress
    // pontosan 60%-ról folytatódik, hogy a csík ne ugorjon.
    M.route('POST', 'api/generate/([^/]+)', (m) => {
        const j = ensureJob(m[1]);
        j.phase2 = true;
        j.doneAt = null;
        j.cancelled = false; j.error = null;
        j.startTs = Date.now() - Math.round(0.60 * j.durationSec * 1000);
        M.save();
        return {};
    });

    // CANCEL — shared.js cancelJob (csak res.ok számít).
    M.route('POST', 'api/cancel/([^/]+)', (m) => {
        M.sim.cancel(m[1]);
        return {};
    });

    // RETRY — teljes újrafutás: a kétfázisú megálló is visszaáll.
    M.route('POST', 'api/retry/([^/]+)', (m) => {
        const j = ensureJob(m[1]);
        j.phase2 = false;
        M.sim.retry(m[1]);
        return {};
    });

    /* ============================================================
     * 4) STÁTUSZ + SZEGMENS-SZERKESZTŐ
     * ========================================================== */

    // STATUS — a 2 mp-es poll. MINDIG JSON-t kell adnia (a kliens nem
    // nézi a res.ok-ot); a MOCK.sim._wrap pontosan a várt mezőket adja:
    // stage / progress / detail / job_mode / error (+ id, created_at…).
    // A sorban álló job a helyét is megkapja (adminnak „⚡ Sor elejére" gomb jár hozzá).
    M.route('GET', 'api/status/([^/]+)', (m) => {
        const st = M.sim.status(m[1]);
        if (st.stage === 'queued') st.queue_position = (M.sim.get(m[1]) || {}).bumped ? 1 : 2;
        return st;
    });

    // JOB GET — a szerkesztő szegmensei. start/end SZÁM (toFixed hívódik rá!).
    M.route('GET', 'api/job/([^/]+)', (m) => {
        const j = M.sim.get(m[1]);
        return {
            job_id: m[1],
            original_filename: j ? j.filename : 'demo_video.mp4',
            mode: j ? j.mode : 'dub_full',
            segments: getSegments(m[1]),
        };
    });

    // SZEGMENS MENTÉS — {segments:[{start,end,hu,en},…]}; body-t nem olvassák.
    M.route('POST', 'api/job/([^/]+)/update', (m, req) => {
        const segs = sanitizeSegments(req.body && req.body.segments);
        if (segs) { CORE.segments[m[1]] = segs; M.save(); }
        return {};
    });

    // ÚJRAFORDÍTÁS — elmentjük a szöveget, majd a jobot visszatekerjük a
    // 'translate' fázisba (~46%); pár mp múlva magától újra edit_ready lesz.
    M.route('POST', 'api/job/([^/]+)/retranslate', (m, req) => {
        const segs = sanitizeSegments(req.body && req.body.segments);
        if (segs) { CORE.segments[m[1]] = segs; }
        const j = ensureJob(m[1]);
        j.phase2 = false;
        j.doneAt = null;
        j.startTs = Date.now() - Math.round(0.46 * j.durationSec * 1000);
        M.save();
        return {};
    });

    // FELIRAT-EXPORT (subtitles_only mód) — siker után a kliens rögtön a
    // letöltési nézetet mutatja, ezért a jobot azonnal késszé tesszük.
    M.route('POST', 'api/job/([^/]+)/export_subtitles', (m) => {
        const j = ensureJob(m[1]);
        j.phase2 = true;
        j.startTs = Date.now() - (j.durationSec + 5) * 1000; // → 100%, done
        M.save();
        return {};
    });

    // VTT IMPORT — multipart 'file'; a cue-kat valóban beolvassuk, hogy a
    // demó élethű legyen. Értelmezhetetlen fájlnál minta-szegmensek jönnek.
    M.route('POST', 'api/job/([^/]+)/import_vtt', async (m, req) => {
        let segs = null;
        try {
            const f = req.form && req.form.get('file');
            if (f && typeof f.text === 'function') {
                segs = parseVtt(await f.text());
                if (!segs.length) segs = null;
            }
        } catch (_) { segs = null; }
        if (!segs) segs = getSegments(m[1]);
        CORE.segments[m[1]] = segs;
        M.save();
        return { segments: segs, detail: null };
    });

    /* ============================================================
     * 5) EXPORT / TÖRLÉS / LETÖLTÉS
     * ========================================================== */

    // "Mentés lemezre" — kamu, de hihető Windows-útvonalakkal.
    M.route('POST', 'api/export_local/([^/]+)', (m) => {
        const j = M.sim.get(m[1]);
        const base = (j && j.filename ? j.filename : 'video.mp4').replace(/\.[^/.]+$/, '');
        return {
            ok: true,
            saved_paths: [
                'D:/EDTI_export/' + base + '.mp4',
                'D:/EDTI_export/' + base + '.vtt',
            ],
            detail: null,
        };
    });

    // JOB TÖRLÉS — a fixture-öket nem bántjuk (a portfólió-dashboard
    // rájuk épül); a kliens a lokális history-t res.ok esetén takarítja.
    M.route('DELETE', 'api/job/([^/]+)', (m) => {
        const id = m[1];
        const FIXTURES = { 'demo-dub-1': 1, 'demo-sub-1': 1, 'demo-ppt-1': 1, 'demo-dub-bg': 1 };
        if (!FIXTURES[id]) {
            M.sim.remove(id);
            delete CORE.segments[id];
            M.save();
        }
        return {};
    });

    // MINŐSÉGI RIPORT — fetch-alapú (?preview=true), a query-t a router
    // levágja. A számokat a tényleges szegmenslistából származtatjuk.
    // FONTOS: a generikus download-route ELŐTT kell regisztrálni!
    M.route('GET', 'api/download/([^/]+)/subtitles_report\\.json', (m) => {
        const segs = getSegments(m[1]);
        const durs = segs.map(s => s.end - s.start);
        const chars = segs.map(s => (s.en || s.hu || '').length);
        const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        return {
            total_cues: segs.length,
            avg_dur: Math.round(avg(durs) * 10) / 10,
            avg_chars: Math.round(avg(chars)),
            merges: 2,
        };
    });

    // GENERIKUS LETÖLTÉS (csak fetch-en át elérhető eset!) — a valódi
    // <a download> kattintás és a window.open NAVIGÁCIÓ, azt a mock nem
    // tudja elfogni: azokhoz statikus fájlok kellenek a repóban
    // (api/download/demo-dub-1/… és api/download/demo-live-1..3/…).
    M.route('GET', 'api/download/([^/]+)/([^/]+)', (m) => {
        const jobId = m[1], filename = m[2];
        const lower = filename.toLowerCase();
        const segs = getSegments(jobId);
        if (lower.slice(-4) === '.mp4' || lower.slice(-4) === '.wav') {
            return M.file(M.ASSET_VIDEO);
        }
        if (lower.slice(-4) === '.vtt') {
            return new Response(buildVtt(segs, filename), {
                status: 200, headers: { 'Content-Type': 'text/vtt; charset=utf-8' },
            });
        }
        if (lower.slice(-4) === '.srt') {
            return new Response(buildSrt(segs, filename), {
                status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            });
        }
        if (lower.slice(-5) === '.json') {
            return new Response(JSON.stringify({ segments: segs }, null, 2), {
                status: 200, headers: { 'Content-Type': 'application/json' },
            });
        }
        return M.resp(404, { detail: 'Demo mód: ez a fájl itt nem elérhető.' });
    });
})();
