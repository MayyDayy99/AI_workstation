/* ============================================================
 * EDTI STUDIO — DEMÓ MOCK ROUTE-OK: FELIRAT + LEIRAT (subtitle)
 * ------------------------------------------------------------
 * A subtitle.html / transcribe.html egyoldalas varázslóit és a
 * hozzájuk tartozó export/letöltés végpontokat szolgálja ki.
 * A batch-hármast (init/chunk/finalize), a /api/batch/* listákat
 * és a /api/batch/stream SSE-t a batch modul birtokolja — itt
 * szándékosan NINCSENEK regisztrálva.
 *
 * Folyamat (subtitle): upload → start → status-poll → edit_ready
 *   (60%-os megálló) → szegmens-szerkesztő → export → done →
 *   letöltési rács + minőségi riport.
 * Folyamat (transcribe): upload → start → status-poll → done →
 *   TXT/SRT/JSON letöltés.
 *
 * FONTOS: a tényleges fájlletöltések <a>.click() navigációval
 * mennek (shared.js downloadFileFromJob) — azokat a mock nem tudja
 * elfogni, ezért a demó repóban VALÓDI statikus fájloknak kell
 * létezniük az api/download/<id>/<fájl> útvonalakon (lásd a
 * static_files_needed listát az integrációs jegyzetben).
 * A fetch-alapú fallback route-ok itt ettől függetlenül valódi
 * SRT/VTT/TXT/JSON tartalmat adnak vissza.
 * ============================================================ */
(function () {
    'use strict';
    if (!window.MOCK) { console.error('[MOCK/subtitle] mock_core.js hiányzik!'); return; }
    const M = window.MOCK;

    // ─── Csoport-specifikus perzisztens állapot ─────────────────
    const ex = M.state.extra.subtitle = M.state.extra.subtitle || {};
    if (!ex.segments) ex.segments = {};   // job_id → szerkesztett szegmensek
    if (!ex.poolIdx) ex.poolIdx = {};     // fix id-pool körforgás számlálói

    // Core-fixture id-k: ezeket DELETE-nél nem irtjuk ki a sim-ből,
    // hogy a dashboard/lista oldalak ne ürüljenek ki.
    const FIXTURE_IDS = {
        'demo-dub-1': 1, 'demo-sub-1': 1, 'demo-ppt-1': 1,
        'demo-dub-bg': 1, 'demo-tr-1': 1,
    };

    // ─── Kezdő fixture + sidebar-história seed (egyszer) ────────
    if (!ex.seeded) {
        // Kész leirat-fixture, hogy a transcribe oldalon is legyen élet.
        if (!M.sim.get('demo-tr-1')) {
            const H = 3600 * 1000;
            const j = M.sim.create('transcribe', {
                id: 'demo-tr-1', filename: 'Halozatok_eloadas_2.mp4',
                mode: 'transcript_only', durationSec: 1,
            });
            j.startTs = Date.now() - 4 * H;           // rég kész
            j.created_at = M.ts(Date.now() - 4 * H);
        }
        // Sidebar-história a single oldalakon localStorage-ból jön —
        // csak akkor seedelünk, ha a látogatónál még üres.
        try {
            if (!localStorage.getItem('subtitleJobs')) {
                localStorage.setItem('subtitleJobs', JSON.stringify([
                    { id: 'demo-sub-1', name: 'Aramkorok_bevezeto.mp4', date: new Date().toISOString() },
                ]));
            }
            if (!localStorage.getItem('transcribeJobs')) {
                localStorage.setItem('transcribeJobs', JSON.stringify([
                    { id: 'demo-tr-1', name: 'Halozatok_eloadas_2.mp4', date: new Date().toISOString() },
                ]));
            }
        } catch (_) {}
        ex.seeded = true;
        M.save();
    }

    // ─── Fix id-pool (max 3/folyam) — a statikus letöltő-fájlok
    // így előre legyárthatók a repóban. Körforgásos újrahasznosítás.
    function poolId(kind) {
        const idx = ex.poolIdx[kind] || 0;
        ex.poolIdx[kind] = idx + 1;
        M.save();
        return 'demo-' + kind + '-live-' + ((idx % 3) + 1);
    }

    // ─── Minta-szegmensek (magyar + angol, "Áramkörök bevezető") ─
    // FIGYELEM: start/end KÖTELEZŐEN szám — a szerkesztő .toFixed(2)-t hív!
    const DEFAULT_SEGMENTS = [
        { start: 0.00,  end: 3.80,  hu: 'Üdvözlök mindenkit a mai előadáson.',                              en: 'Welcome everyone to today\'s lecture.' },
        { start: 3.80,  end: 8.40,  hu: 'A mai témánk az egyenáramú áramkörök alapjai.',                    en: 'Today\'s topic is the basics of DC circuits.' },
        { start: 8.40,  end: 13.20, hu: 'Először nézzük meg az Ohm-törvényt.',                              en: 'First, let\'s take a look at Ohm\'s law.' },
        { start: 13.20, end: 18.90, hu: 'A feszültség egyenlő az áramerősség és az ellenállás szorzatával.', en: 'Voltage equals current multiplied by resistance.' },
        { start: 18.90, end: 24.50, hu: 'Ez a képlet az elektronika egyik legfontosabb alapköve.',           en: 'This formula is one of the most important cornerstones of electronics.' },
        { start: 24.50, end: 29.80, hu: 'Vegyünk egy egyszerű példát: egy 9 voltos elem és egy ellenállás.', en: 'Let\'s take a simple example: a 9-volt battery and a resistor.' },
        { start: 29.80, end: 35.10, hu: 'Ha az ellenállás 100 ohm, az áram 90 milliamper lesz.',             en: 'If the resistance is 100 ohms, the current will be 90 milliamps.' },
        { start: 35.10, end: 40.60, hu: 'Soros kapcsolásban az ellenállások egyszerűen összeadódnak.',       en: 'In a series connection, the resistances simply add up.' },
        { start: 40.60, end: 46.20, hu: 'Párhuzamos kapcsolásnál a reciprok értékeket kell összeadni.',      en: 'For parallel connections, you add the reciprocal values.' },
        { start: 46.20, end: 52.00, hu: 'A következő alkalommal mindezt megmérjük a laborban.',              en: 'Next time we will measure all of this in the lab.' },
    ];

    function getSegments(id) {
        return ex.segments[id] || DEFAULT_SEGMENTS;
    }

    // Beérkező szegmensek fertőtlenítése — a start/end maradjon szám.
    function sanitizeSegments(segs) {
        return segs.map(s => ({
            start: Number(s && s.start) || 0,
            end: Number(s && s.end) || 0,
            hu: String((s && s.hu) || ''),
            en: String((s && s.en) || ''),
        }));
    }

    // ─── SRT/VTT/TXT építők ─────────────────────────────────────
    function pad2(n) { return String(n).padStart(2, '0'); }
    function fmtTime(sec, msSep) {
        sec = Math.max(0, Number(sec) || 0);
        const h = Math.floor(sec / 3600), mn = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        const ms = Math.round((sec - Math.floor(sec)) * 1000) % 1000;
        return pad2(h) + ':' + pad2(mn) + ':' + pad2(s) + msSep + String(ms).padStart(3, '0');
    }
    function cueText(seg, lang) {
        if (lang === 'bilingual') return (seg.hu || '') + '\n' + (seg.en || '');
        return seg[lang] || '';
    }
    function buildSRT(segs, lang) {
        return segs.map((s, i) =>
            (i + 1) + '\n' + fmtTime(s.start, ',') + ' --> ' + fmtTime(s.end, ',') + '\n' + cueText(s, lang)
        ).join('\n\n') + '\n';
    }
    function buildVTT(segs, lang) {
        return 'WEBVTT\n\n' + segs.map((s, i) =>
            (i + 1) + '\n' + fmtTime(s.start, '.') + ' --> ' + fmtTime(s.end, '.') + '\n' + cueText(s, lang)
        ).join('\n\n') + '\n';
    }
    function buildTranscript(segs, filename) {
        const lines = segs.map(s => '[' + fmtTime(s.start, '.').slice(0, 8) + '] ' + (s.hu || ''));
        return 'LEIRAT — ' + (filename || 'demo_video.mp4') + '\n' +
            '========================================\n\n' +
            lines.join('\n') +
            '\n\n(Automatikus leirat — Whisper large-v3 · EDTI Studio demó)\n';
    }
    function textResponse(body, mime) {
        return new Response(body, { status: 200, headers: { 'Content-Type': mime } });
    }

    // ============================================================
    // 1) FELTÖLTÉS — egy multipart POST (single oldalak)
    // ------------------------------------------------------------
    // Mód-generikus: a subtitle/transcribe módokat fix pool-id-vel,
    // minden mást (pl. dub_full) alap sim-viselkedéssel kezel, így a
    // betöltési sorrend a többi route-modullal szemben nem kritikus.
    // ============================================================
    M.route('POST', 'api/upload', (m, req) => {
        const mode = req.query.get('mode') || 'dub_full';
        const owner = req.query.get('owner') || 'demo';
        const f = (req.form && typeof req.form.get === 'function') ? req.form.get('file') : null;
        const filename = (f && f.name) || 'feltoltott_video.mp4';

        const opts = { filename: filename, mode: mode, owner: owner, autostart: false };
        let type;
        if (mode === 'subtitles_only') {
            type = 'subtitle';
            opts.id = poolId('sub');
            opts.pausedStage = 'edit_ready';                       // 60%-nál megáll → szerkesztő
            opts.durationSec = 30 + Math.floor(Math.random() * 12); // edit_ready ~20 mp múlva
        } else if (mode === 'transcript_only') {
            type = 'transcribe';
            opts.id = poolId('tr');
            opts.durationSec = 22 + Math.floor(Math.random() * 10);
        } else {
            // Idegen mód (pl. dub_full) — generikus fallback, ha ez a
            // modul kapja el a kérést a dub modul helyett.
            type = 'dub';
            opts.pausedStage = 'edit_ready';
        }
        // Pool-újrahasznosítás: a korábbi kör szerkesztései törlendők.
        if (opts.id && ex.segments[opts.id]) { delete ex.segments[opts.id]; M.save(); }

        const job = M.sim.create(type, opts);
        return { job_id: job.id, status: 'uploaded' };
    });

    // ============================================================
    // 2) INDÍTÁS + STÁTUSZ + ÉLETCIKLUS
    // ============================================================
    M.route('POST', 'api/start/([^/]+)', (m, req) => {
        const j = M.sim.get(m[1]);
        if (j && req.body && req.body.mode) { j.mode = req.body.mode; }
        M.sim.start(m[1]);
        M.save();
        return { status: 'started', job_id: m[1] };
    });

    // Státusz — a sim időalapú értékét adjuk a kontraktus mezőnevein.
    // A 'cancelled' állapotot error-ként tálaljuk, hogy a single
    // oldalak Retry-panele használható legyen (különben örök poll).
    M.route('GET', 'api/status/([^/]+)', (m) => {
        let st = M.sim.status(m[1]);
        if (st.stage === 'cancelled') {
            st = Object.assign({}, st, {
                stage: 'error', status: 'error',
                detail: 'A feladat meg lett szakítva.',
                error: 'Megszakítva',
            });
        }
        // Felirat-jobnál az edit_ready szöveg a feliratokról szóljon.
        const j = M.sim.get(m[1]);
        if (j && j.type === 'subtitle' && st.stage === 'edit_ready') {
            st = Object.assign({}, st, { detail: 'Szerkesztésre kész — ellenőrizd a feliratokat' });
        }
        st.error_detail = st.error_detail || st.error || null;
        return st;
    });

    // Hiba utáni / kész utáni újrafeldolgozás. Felirat-jobnál mindig
    // visszaállítjuk az edit_ready megállót, hogy a látogató a kész
    // fixture-ből is eljusson a szegmens-szerkesztőig.
    M.route('POST', 'api/retry/([^/]+)', (m) => {
        const j = M.sim.get(m[1]);
        if (!j) return M.resp(404, { detail: 'Ismeretlen feladat (demo)' });
        if (j.type === 'subtitle') {
            j.pausedStage = 'edit_ready';
            j.phase2 = false;
            if (!j.durationSec || j.durationSec < 20) j.durationSec = 28 + Math.floor(Math.random() * 8);
        } else if (!j.durationSec || j.durationSec < 15) {
            // Az 1 mp-es fixture-öknél legyen látható progress.
            j.durationSec = 20 + Math.floor(Math.random() * 8);
        }
        M.sim.retry(m[1]);
        return {};
    });

    // Megszakítás. (Ismert frontend-bug: a subtitle.html Mégse gombja
    // '/api/cancel/[object PointerEvent]'-et POST-ol — arra a sim.get
    // null-t ad, csendben lenyeljük.)
    M.route('POST', 'api/cancel/([^/]+)', (m) => {
        if (M.sim.get(m[1])) M.sim.cancel(m[1]);
        return {};
    });

    // Feladat törlése — a fixture-öket csak "színleg" töröljük, hogy a
    // többi oldal listái ne ürüljenek ki; a kliens úgyis kitakarítja a
    // saját localStorage-históriáját 2xx után.
    M.route('DELETE', 'api/job/([^/]+)', (m) => {
        const id = m[1];
        delete ex.segments[id];
        if (!FIXTURE_IDS[id]) M.sim.remove(id);
        M.save();
        return {};
    });

    // ============================================================
    // 3) SZEGMENS-SZERKESZTŐ (subtitle, edit_ready után)
    // ============================================================
    M.route('GET', 'api/job/([^/]+)', (m) => {
        return { job_id: m[1], segments: getSegments(m[1]) };
    });

    M.route('POST', 'api/job/([^/]+)/update', (m, req) => {
        const segs = req.body && req.body.segments;
        if (Array.isArray(segs)) { ex.segments[m[1]] = sanitizeSegments(segs); M.save(); }
        return {};
    });

    // Újrafordítás: elmentjük a szerkesztést, majd a job a fordítás
    // fázis közepéről (~56%) fut újra az edit_ready megállóig.
    M.route('POST', 'api/job/([^/]+)/retranslate', (m, req) => {
        const segs = req.body && req.body.segments;
        if (Array.isArray(segs)) ex.segments[m[1]] = sanitizeSegments(segs);
        const j = M.sim.get(m[1]);
        if (j) {
            j.cancelled = false; j.error = null; j.doneAt = null; j.phase2 = false;
            j.pausedStage = 'edit_ready';
            if (!j.durationSec || j.durationSec < 20) j.durationSec = 30;
            j.startTs = Date.now() - Math.round(j.durationSec * 1000 * 0.56);
        }
        M.save();
        return {};
    });

    // ============================================================
    // 4) EXPORTOK
    // ============================================================
    // Felirat-export: a job befutott állapotba kerül (done), a kliens
    // a letöltő-rácsra vált és lekéri a minőségi riportot.
    M.route('POST', 'api/job/([^/]+)/export_subtitles', (m) => {
        const j = M.sim.get(m[1]);
        if (j) {
            j.phase2 = true;
            j.doneAt = null;
            j.startTs = Date.now() - (j.durationSec + 2) * 1000; // → 100%
            M.save();
        }
        return { status: 'ok', detail: 'Feliratok exportálva (demo)' };
    });

    // Leirat-export (transcribe TXT gomb 1. lépése) — a "generálás".
    M.route('POST', 'api/job/([^/]+)/export_transcript', (m) => {
        M.sim.start(m[1]); // no-op ha már fut/kész
        return { status: 'ok' };
    });

    // Leirat-export GET (transcribe_batch TXT linkje <a>-val navigál,
    // de fetch-hívásra is adjunk valódi tartalmat).
    M.route('GET', 'api/job/([^/]+)/export_transcript', (m) => {
        const j = M.sim.get(m[1]);
        return textResponse(
            buildTranscript(getSegments(m[1]), j && j.filename),
            'text/plain; charset=utf-8'
        );
    });

    // ============================================================
    // 5) LETÖLTÉSEK (fetch-alapú útvonalak + fallbackek)
    // ------------------------------------------------------------
    // Minőségi riport — az EGYETLEN download-útvonal, amit a kliens
    // ténylegesen fetch-csel kér (subtitle.js, ?preview=true).
    // A számok a tényleges (esetleg szerkesztett) szegmensekből jönnek.
    // ============================================================
    M.route('GET', 'api/download/([^/]+)/subtitles_report\\.json', (m) => {
        const segs = getSegments(m[1]);
        let dur = 0, chars = 0;
        segs.forEach(s => { dur += (s.end - s.start); chars += (s.hu || '').length; });
        const n = Math.max(1, segs.length);
        return {
            total_cues: segs.length,
            avg_dur: Math.round(dur / n * 10) / 10,
            avg_chars: Math.round(chars / n),
            merges: 2,
        };
    });

    // Feliratfájlok (hu/en/bilingual + a batch-oldali 'dubbed' aliasa).
    // Az <a>-navigációt ez nem fogja el — arra valók a statikus fájlok —
    // de minden fetch-alapú letöltés valódi SRT/VTT szöveget kap.
    M.route('GET', 'api/download/([^/]+)/(hu|en|bilingual|dubbed)\\.(srt|vtt)', (m) => {
        const segs = getSegments(m[1]);
        const lang = m[2] === 'dubbed' ? 'hu' : m[2];
        const body = m[3] === 'vtt' ? buildVTT(segs, lang) : buildSRT(segs, lang);
        return textResponse(body, m[3] === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8');
    });

    M.route('GET', 'api/download/([^/]+)/segments\\.json', (m) => {
        return textResponse(
            JSON.stringify({ job_id: m[1], segments: getSegments(m[1]) }, null, 2),
            'application/json; charset=utf-8'
        );
    });

    M.route('GET', 'api/download/([^/]+)/transcript\\.txt', (m) => {
        const j = M.sim.get(m[1]);
        return textResponse(
            buildTranscript(getSegments(m[1]), j && j.filename),
            'text/plain; charset=utf-8'
        );
    });
})();
