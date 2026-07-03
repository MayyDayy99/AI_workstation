/* ============================================================
 * EDTI STUDIO — DEMÓ MOCK ROUTE-OK: "misc" csoport
 * ------------------------------------------------------------
 * Lefedett oldalak / modulok:
 *   - admin.html / admin.js        (user-kezelés, audit, kuka, tárhely)
 *   - profile.html / profile.js    (jelszócsere)
 *   - scan.js                      (Intelligens Tallózás varázsló)
 *   - course.html                  (kurzus ZIP feltöltés + státusz)
 *   - intro_outro.html/.js + intro_outro_batch.html (upload/process/
 *     status/SSE/jobs lista/retry/törlés)
 *   - voice_picker.js              (hangminta-könyvtár)
 *   - shared.js alap action-ök     (cancel/retry/job törlés/metadata)
 *
 * A fájl a mock_core.js UTÁN töltődik be, és a globális MOCK API-ra
 * regisztrál. Minden feldolgozás idő-alapú szimuláció (MOCK.sim),
 * minden extra állapot a MOCK.state.extra.misc alatt perzisztens.
 * ============================================================ */
(function () {
    'use strict';

    if (!window.MOCK) { console.warn('[mock_routes_misc] MOCK core hiányzik!'); return; }
    const M = window.MOCK;

    // ─── Segédek ────────────────────────────────────────────────
    function cookie(n) {
        const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
    }
    function currentUser() { return cookie('currentUser') || 'demo'; }
    function agoTs(ms) { return M.ts(Date.now() - ms); }
    const MIN = 60 * 1000, H = 3600 * 1000, D = 24 * H;

    // Ékezet-mentes slug (voice_key-hez) — a kombináló ékezeteket
    // explicit unicode-tartománnyal szedjük ki (encoding-biztos).
    const COMBINING_RE = new RegExp('[\\u0300-\\u036f]', 'g');
    function slug(s) {
        return String(s || 'voice')
            .normalize('NFD').replace(COMBINING_RE, '')
            .toLowerCase().replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'voice';
    }

    // ─── Csoport-állapot (perzisztens) ──────────────────────────
    if (!M.state.extra.misc) M.state.extra.misc = {};
    const X = M.state.extra.misc;

    const SEED_V = 1;
    if (X.seeded !== SEED_V) {
        // — Felhasználók (admin panel) —
        X.users = [
            { username: 'demo', role: 'admin',  workspaces: ['Alapértelmezett', 'Portfólió'], created_at: agoTs(29 * D), password_changed_at: agoTs(8 * D) },
            { username: 'anna', role: 'editor', workspaces: ['Alapértelmezett'],              created_at: agoTs(27 * D), password_changed_at: agoTs(13 * D) },
            { username: 'bela', role: 'editor', workspaces: ['Alapértelmezett'],              created_at: agoTs(21 * D), password_changed_at: null },
        ];
        // — Audit log (legfrissebb elöl) —
        X.audit = [
            { ts: agoTs(22 * MIN),      user: 'demo', user_role: 'admin',  action: 'auth.login',           target_kind: 'user',  target_id: 'demo',            ip: '127.0.0.1' },
            { ts: agoTs(3 * H),         user: 'anna', user_role: 'editor', action: 'job.create',           target_kind: 'batch', target_id: 'demo-dub-bg',     ip: '192.168.1.34' },
            { ts: agoTs(26 * H),        user: 'demo', user_role: 'admin',  action: 'job.soft_delete',      target_kind: 'batch', target_id: '1042',            ip: '127.0.0.1' },
            { ts: agoTs(2 * D),         user: 'demo', user_role: 'admin',  action: 'storage.cleanup_mode', target_kind: 'mode',  target_id: 'transcript_only', ip: '127.0.0.1' },
            { ts: agoTs(8 * D),         user: 'demo', user_role: 'admin',  action: 'user.password_change', target_kind: 'user',  target_id: 'demo',            ip: '127.0.0.1' },
            { ts: agoTs(21 * D),        user: 'demo', user_role: 'admin',  action: 'user.create',          target_kind: 'user',  target_id: 'bela',            ip: '127.0.0.1' },
        ];
        // — Kuka (soft-deleted batch rekordok; id NUMERIKUS!) —
        X.trash = [
            { id: 1042, mode: 'dub_full',       owner: 'anna', status: 'done',  deleted_at: agoTs(26 * H), original_filename: 'Regi_eloadas_felvetel.mp4' },
            { id: 1057, mode: 'subtitles_only', owner: 'demo', status: 'error', deleted_at: agoTs(4 * D),  original_filename: 'Konferencia_osszefoglalo.mp4' },
        ];
        // — Tárhely-statisztika (a cleanup gombok ténylegesen nullázzák) —
        X.storage = {
            per_mode: [
                { mode: 'dub_full',        total: 14, finished: 9, reclaimable_gb: 18.4 },
                { mode: 'subtitles_only',  total: 6,  finished: 5, reclaimable_gb: 2.1 },
                { mode: 'transcript_only', total: 3,  finished: 3, reclaimable_gb: 0.4 },
                { mode: 'intro_outro',     total: 7,  finished: 4, reclaimable_gb: 6.8 },
                { mode: 'ppt_narrate',     total: 5,  finished: 3, reclaimable_gb: 3.9 },
                { mode: 'ppt_replace',     total: 2,  finished: 1, reclaimable_gb: 1.2 },
            ],
            batch_inbox_mb: 700,
            exports_mb: 5222,
        };
        // — Hangminta-könyvtár (voice_picker.js) —
        X.voices = [
            { voice_key: 'anna_tanarno_hu',  display_name: 'Anna tanárnő',     language_hint: 'hu', uploader: 'demo' },
            { voice_key: 'gabor_mernok_hu',  display_name: 'Gábor mérnök',     language_hint: 'hu', uploader: 'anna' },
            { voice_key: 'sarah_lecturer_en', display_name: 'Sarah (lecturer)', language_hint: 'en', uploader: 'demo' },
        ];
        // — Kurzusok: 1 kész fixture (letölthető statikus ZIP-pel) —
        X.courses = [{
            course_id: 'demo-course-1',
            original_zip_name: 'Digitalis_technika_kurzus.zip',
            mode: 'dub_full',
            video_count: 8,
            created_at: agoTs(2 * D),
            startTs: Date.now() - 2 * D,
            perVideoSec: 20,
            videos: [
                'modul1/01_bevezetes.mp4', 'modul1/02_alapfogalmak.mp4',
                'modul1/03_kombinacios_halozatok.mp4', 'modul2/04_szekvencialis_halozatok.mp4',
                'modul2/05_flip_flopok.mp4', 'modul2/06_szamlalok.mp4',
                'modul3/07_memoriak.mp4', 'modul3/08_osszefoglalas.mp4',
            ],
        }];
        X.coursePoolIdx = 0;   // user-feltöltések: demo-course-live-1..3 körforgás
        X.ioPoolIdx = 1;       // intro/outro feltöltések: demo-io-2-vel indul
        X.scans = {};          // futó Intelligens Tallózás munkamenetek
        X.seeded = SEED_V;
        M.save();
    }

    // — Intro/outro fixture-job: 1 kész, letölthető elem a batch listán —
    if (!M.sim.get('demo-io-1')) {
        M.sim.create('intro_outro', {
            id: 'demo-io-1',
            filename: 'Halozati_ismeretek_2_ora.mp4',
            mode: 'intro_outro',
            durationSec: 1,
            autostart: true,
        });
        const fj = M.sim.get('demo-io-1');
        fj.startTs = Date.now() - 90 * MIN;
        fj.created_at = agoTs(90 * MIN);
        M.save();
    }

    function addAudit(action, kind, id) {
        X.audit.unshift({
            ts: M.ts(), user: currentUser(), user_role: 'admin',
            action: action, target_kind: kind, target_id: String(id), ip: '127.0.0.1',
        });
        if (X.audit.length > 200) X.audit.length = 200;
        M.save();
    }

    /* ============================================================
     * ADMIN — felhasználók
     * ============================================================ */
    // A backend CSUPASZ tömböt ad (admin.js számít rá, {users} csak fallback).
    M.route('GET', 'api/admin/users', () => X.users);

    M.route('POST', 'api/admin/users', (m, req) => {
        const b = req.body || {};
        const name = (b.username || '').trim();
        if (!name) return M.resp(400, { detail: 'Felhasználónév kötelező.' });
        if (X.users.some(u => u.username.toLowerCase() === name.toLowerCase())) {
            return M.resp(409, { detail: 'A felhasználónév már létezik.' });
        }
        X.users.push({
            username: name,
            role: b.role || 'editor',
            workspaces: ['Alapértelmezett'],
            created_at: M.ts(),
            password_changed_at: M.ts(),
        });
        addAudit('user.create', 'user', name);
        return {};
    });

    M.route('POST', 'api/admin/users/([^/]+)/password', (m) => {
        const name = decodeURIComponent(m[1]);
        const u = X.users.find(x => x.username === name);
        if (!u) return M.resp(404, { detail: 'Nincs ilyen felhasználó.' });
        u.password_changed_at = M.ts();
        addAudit('user.password_reset', 'user', name);
        return {};
    });

    M.route('POST', 'api/admin/users/([^/]+)/role', (m, req) => {
        const name = decodeURIComponent(m[1]);
        const u = X.users.find(x => x.username === name);
        if (!u) return M.resp(404, { detail: 'Nincs ilyen felhasználó.' });
        const old = u.role;
        u.role = (req.body && req.body.role) || 'editor';
        addAudit('user.role_change', 'user', name);
        return { old_role: old };  // admin.js: 'Szerepkör: old → new'
    });

    M.route('DELETE', 'api/admin/users/([^/]+)', (m) => {
        const name = decodeURIComponent(m[1]);
        if (name === currentUser()) {
            return M.resp(400, { detail: 'Demo mód: a saját fiókod nem törölhető.' });
        }
        X.users = X.users.filter(x => x.username !== name);
        addAudit('user.delete', 'user', name);
        return {};
    });

    /* ============================================================
     * ADMIN — audit log
     * ============================================================ */
    M.route('GET', 'api/admin/audit', (m, req) => {
        const limit = parseInt(req.query.get('limit') || '50', 10) || 50;
        return { entries: X.audit.slice(0, limit) };
    });

    /* ============================================================
     * ADMIN — kuka (soft-deleted batch rekordok)
     * ============================================================ */
    M.route('GET', 'api/admin/batch/trash', (m, req) => {
        const limit = parseInt(req.query.get('limit') || '500', 10) || 500;
        return X.trash.slice(0, limit);  // csupasz tömb
    });

    M.route('POST', 'api/admin/batch/trash/([^/]+)/restore', (m) => {
        const id = Number(m[1]);
        X.trash = X.trash.filter(t => t.id !== id);
        addAudit('trash.restore', 'batch', id);
        return {};
    });

    M.route('DELETE', 'api/admin/batch/trash/([^/]+)/purge', (m) => {
        const id = Number(m[1]);
        X.trash = X.trash.filter(t => t.id !== id);
        addAudit('trash.purge', 'batch', id);
        return {};
    });

    /* ============================================================
     * ADMIN — tárhely
     * ============================================================ */
    function humanGb(gb) {
        if (gb <= 0) return '0 B';
        if (gb < 1) return Math.round(gb * 1024) + ' MB';
        return gb.toFixed(1) + ' GB';
    }
    function humanMb(mb) {
        if (mb <= 0) return '0 B';
        if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
        return mb.toFixed(1) + ' MB';
    }

    M.route('GET', 'api/admin/storage/stats', () => {
        const totalB = 2000 * 1024 * 1024 * 1024;              // 2 TB
        const usedB = Math.round(totalB * 0.655);
        return {
            disk: {
                total: totalB,
                used: usedB,
                used_human: '1.28 TB',
                total_human: '1.95 TB',
                free_human: '689 GB',
            },
            per_mode: X.storage.per_mode.map(p => ({
                mode: p.mode,
                total: p.total,
                finished: p.finished,
                reclaimable_human: humanGb(p.reclaimable_gb),
            })),
            scratch: [
                { name: 'batch_inbox', exists: true, bytes: Math.round(X.storage.batch_inbox_mb * 1024 * 1024), human: humanMb(X.storage.batch_inbox_mb) },
                { name: 'exports',     exists: true, bytes: Math.round(X.storage.exports_mb * 1024 * 1024),     human: humanMb(X.storage.exports_mb) },
            ],
        };
    });

    M.route('POST', 'api/admin/storage/cleanup-mode', (m, req) => {
        const mode = (req.body && req.body.mode) || '';
        const p = X.storage.per_mode.find(x => x.mode === mode);
        if (!p) return M.resp(404, { detail: 'Ismeretlen mode: ' + mode });
        const freedHuman = humanGb(p.reclaimable_gb);
        const rows = p.finished;
        p.total = Math.max(0, p.total - p.finished);
        p.finished = 0;
        p.reclaimable_gb = 0;
        addAudit('storage.cleanup_mode', 'mode', mode);
        return { rows_deleted: rows, bytes_freed_human: freedHuman, errors: [] };
    });

    M.route('POST', 'api/admin/storage/cleanup-batch-inbox', () => {
        const freed = humanMb(X.storage.batch_inbox_mb);
        const rows = X.storage.batch_inbox_mb > 0 ? 3 : 0;
        X.storage.batch_inbox_mb = 0;
        addAudit('storage.cleanup_batch_inbox', 'scratch', 'batch_inbox');
        return { rows_deleted: rows, bytes_freed_human: freed };
    });

    M.route('POST', 'api/admin/storage/cleanup-exports', () => {
        const freed = humanMb(X.storage.exports_mb);
        const rows = X.storage.exports_mb > 0 ? 5 : 0;
        X.storage.exports_mb = 0;
        addAudit('storage.cleanup_exports', 'scratch', 'exports');
        return { rows_deleted: rows, bytes_freed_human: freed };
    });

    /* ============================================================
     * PROFIL — jelszócsere
     * ============================================================ */
    M.route('POST', 'api/me/password', (m, req) => {
        const b = req.body || {};
        if (!b.new_password) return M.resp(400, { detail: 'Az új jelszó kötelező.' });
        const u = X.users.find(x => x.username === currentUser());
        if (u) u.password_changed_at = M.ts();
        addAudit('user.password_change', 'user', currentUser());
        M.save();
        return {};  // profile.js csak r.ok-ot néz → siker toast
    });

    /* ============================================================
     * SCAN — Intelligens Tallózás (médiatár + idő-alapú szimuláció)
     * ============================================================ */
    // Fix "médiatár": ezt adja vissza a preview, és ebből fut a scan.
    const SCAN_ROOTS = [
        { path: 'D:/oktatas/videok',    display: 'D:/oktatas/videok',    exists: true },
        { path: 'E:/archiv/kurzusok',   display: 'E:/archiv/kurzusok',   exists: true },
        { path: 'F:/regi_anyagok',      display: 'F:/regi_anyagok',      exists: false },
    ];
    const SCAN_FILES = [
        { name: '01_bevezetes.mp4',        dir: 'modul1', ext: 'mp4', size_bytes: 241172480 },
        { name: '02_alapfogalmak.mp4',     dir: 'modul1', ext: 'mp4', size_bytes: 187694513 },
        { name: '03_gyakorlat_demo.mp4',   dir: 'modul2', ext: 'mp4', size_bytes: 322122547 },
        { name: '04_osszefoglalo.mp4',     dir: 'modul2', ext: 'mp4', size_bytes: 156237824 },
        { name: 'jegyzet_hanganyag.mp3',   dir: '.',      ext: 'mp3', size_bytes: 24117248 },
        { name: 'serult_letoltes.mp4',     dir: 'modul2', ext: 'mp4', size_bytes: 512 },
    ];
    // Mode → mock_core fázistábla kulcs
    const SCAN_TABLE_KEY = {
        dub_full: 'dub', subtitles_only: 'subtitle',
        transcript_only: 'transcribe', intro_outro: 'intro_outro',
    };

    M.route('GET', 'api/scan/roots', () => ({ roots: SCAN_ROOTS }));

    M.route('POST', 'api/scan/preview', () => ({ files: SCAN_FILES }));

    M.route('POST', 'api/scan/start', (m, req) => {
        const b = req.body || {};
        const id = 'sc-' + Date.now().toString(36);
        X.scans[id] = {
            id: id,
            mode: b.mode || 'dub_full',
            files: SCAN_FILES,
            startTs: Date.now(),
            perFileSec: 22,     // egy fájl feldolgozási ideje
            conc: 2,            // párhuzamosság ("hullámokban" indulnak)
            canceledAt: null,
        };
        M.save();
        return { scan_id: id, queued: SCAN_FILES.length };
    });

    function scanStatus(sc) {
        const now = Date.now();
        const table = M.STAGE_TABLES[SCAN_TABLE_KEY[sc.mode] || 'dub'];
        const items = [];
        let done = 0, error = 0, canceled = 0, queued = 0, running = 0;

        sc.files.forEach((f, i) => {
            const wave = Math.floor(i / sc.conc);
            const startAt = sc.startTs + wave * sc.perFileSec * 1000;
            let status, job_status = null, error_message = '';

            if (sc.canceledAt && startAt > sc.canceledAt) {
                // A cancel pillanatában még el sem indult → leállítva.
                // (A már futók "befejeződnek" — pont mint az igazi backend.)
                status = 'canceled';
            } else {
                const el = (now - startAt) / 1000;
                if (el < 0) {
                    status = 'queued';
                } else if (el >= sc.perFileSec) {
                    // A gyanúsan kicsi fájl hibára fut — élethű demó.
                    if ((f.size_bytes || 0) < 1024) {
                        status = 'error';
                        error_message = 'A fájl sérült vagy üres (demo)';
                    } else {
                        status = 'done';
                    }
                } else {
                    status = 'running';
                    const pct = Math.min(99, Math.round(100 * el / sc.perFileSec));
                    let stage = 'queued', detail = '';
                    for (const [limit, st, dt] of table) {
                        if (pct <= limit) { stage = st; detail = dt; break; }
                    }
                    job_status = { stage: stage, progress: pct, detail: detail };
                }
            }

            if (status === 'done') done++;
            else if (status === 'error') error++;
            else if (status === 'canceled') canceled++;
            else if (status === 'queued') queued++;
            else running++;

            items.push({
                original_filename: f.name,
                status: status,
                error_message: error_message,
                job_status: job_status,
            });
        });

        return {
            total: sc.files.length,
            done: done, error: error, canceled: canceled,
            queued: queued, running: running,
            items: items,
        };
    }

    M.route('GET', 'api/scan/([^/]+)', (m) => {
        const sc = X.scans[m[1]];
        if (!sc) return M.resp(404, { detail: 'Ismeretlen scan (demo).' });
        return scanStatus(sc);
    });

    M.route('DELETE', 'api/scan/([^/]+)', (m) => {
        const sc = X.scans[m[1]];
        if (sc && !sc.canceledAt) { sc.canceledAt = Date.now(); M.save(); }
        return {};
    });

    /* ============================================================
     * KURZUS — ZIP feltöltés, lista, per-kurzus státusz
     * ============================================================ */
    // A letöltés window.location.href navigáció → NEM elfogható; a
    // course_id-k FIX POOL-ból jönnek, hogy a statikus ZIP előre létezzen.
    const COURSE_POOL = ['demo-course-live-1', 'demo-course-live-2', 'demo-course-live-3'];

    function makeCourseVideos(n) {
        const out = [];
        for (let i = 1; i <= n; i++) {
            const mod = 'modul' + Math.ceil(i / 3);
            out.push(mod + '/' + String(i).padStart(2, '0') + '_lecke.mp4');
        }
        return out;
    }

    function courseView(c) {
        const el = (Date.now() - c.startTs) / 1000;
        const per = c.perVideoSec || 20;
        const doneN = Math.max(0, Math.min(c.video_count, Math.floor(el / per)));
        const finished = doneN >= c.video_count;
        const videos = c.videos.map((rel, i) => {
            if (i < doneN) return { relative_path: rel, status: 'done', progress: 100 };
            if (i === doneN && !finished) {
                const pct = Math.min(99, Math.round(100 * (el - doneN * per) / per));
                return { relative_path: rel, status: 'running', progress: pct };
            }
            return { relative_path: rel, status: 'queued', progress: 0 };
        });
        return {
            course_id: c.course_id,
            status: finished ? 'done' : 'processing',
            original_zip_name: c.original_zip_name,
            mode: c.mode,
            video_count: c.video_count,
            done_count: doneN,
            error_count: 0,
            created_at: c.created_at,
            videos: videos,
        };
    }

    M.route('POST', 'api/course/upload', (m, req) => {
        const f = req.form ? req.form.get('file') : null;
        const zipName = (f && f.name) ? f.name : 'kurzus.zip';
        const mode = (req.form && req.form.get('mode')) || 'dub_full';
        const id = COURSE_POOL[X.coursePoolIdx % COURSE_POOL.length];
        X.coursePoolIdx += 1;
        // Ha a pool-id már foglalt (körbeértünk), a régit lecseréljük.
        X.courses = X.courses.filter(c => c.course_id !== id);
        const count = 5 + (X.coursePoolIdx % 3);   // 5-7 "videó" a csomagban
        X.courses.unshift({
            course_id: id,
            original_zip_name: zipName,
            mode: mode,
            video_count: count,
            created_at: M.ts(),
            startTs: Date.now(),
            perVideoSec: 18,
            videos: makeCourseVideos(count),
        });
        M.save();
        return { video_count: count };
    });

    M.route('GET', 'api/course/list', () => ({ courses: X.courses.map(courseView) }));

    M.route('GET', 'api/course/status/([^/]+)', (m) => {
        const c = X.courses.find(x => x.course_id === m[1]);
        if (!c) return M.resp(404, { detail: 'Ismeretlen kurzus (demo).' });
        return courseView(c);
    });

    M.route('DELETE', 'api/course/([^/]+)', (m) => {
        X.courses = X.courses.filter(x => x.course_id !== m[1]);
        M.save();
        return {};
    });

    /* ============================================================
     * INTRO / OUTRO — upload, process, status (+SSE), jobs lista
     * ============================================================ */
    // A letöltés <a href> / <a download> → NEM elfogható; a job_id-k FIX
    // POOL-ból jönnek (demo-io-1..3), hogy a statikus MP4 előre létezzen.
    const IO_POOL = ['demo-io-1', 'demo-io-2', 'demo-io-3'];

    // MOCK.sim státusz → az intro_outro kontraktus stage-nevei.
    // A batch lista {uploaded,queued,processing,done,error,canceled}
    // halmazt számol, a single oldal done/uploaded/error/canceled-re ágazik.
    function ioView(j) {
        const s = M.sim.status(j.id);
        let stage, detail, progress = s.progress || 0;
        if (s.status === 'pending') {
            stage = 'uploaded'; progress = 0;
            detail = 'Feltöltve — beállításra vár';
        } else if (s.status === 'cancelled') {
            stage = 'canceled'; detail = 'Megszakítva';
        } else if (s.status === 'error') {
            stage = 'error'; detail = s.error || 'Ismeretlen hiba';
        } else if (s.status === 'done') {
            stage = 'done'; progress = 100; detail = 'Kész ✔';
        } else if (progress <= 6) {
            stage = 'queued'; detail = 'Sorban áll…';
        } else {
            stage = 'processing';
            detail = 'Feldolgozás: ' + progress + '% — ' + (s.detail || '');
        }
        return {
            id: j.id,
            job_id: j.id,
            stage: stage,
            progress: progress,
            detail: detail,
            error_detail: s.status === 'error' ? (s.error || detail) : null,
            original_filename: j.filename,
            owner: j.owner,
            created_at: j.created_at,
            updated_at: M.ts(),
            can_modify: true,
        };
    }

    M.route('POST', 'api/intro_outro/upload', (m, req) => {
        const f = req.form ? req.form.get('file') : null;
        const owner = req.query.get('owner') || currentUser();
        const id = IO_POOL[X.ioPoolIdx % IO_POOL.length];
        X.ioPoolIdx += 1;
        M.save();
        if (M.sim.get(id)) M.sim.remove(id);   // pool-újrahasznosítás
        M.sim.create('intro_outro', {
            id: id,
            filename: (f && f.name) ? f.name : 'video.mp4',
            mode: 'intro_outro',
            owner: owner,
            autostart: false,                  // 'uploaded' állapotban vár
        });
        return { job_id: id, status: 'uploaded' };
    });

    M.route('POST', 'api/intro_outro/upload-asset/([^/]+)', (m, req) => {
        const f = req.form ? req.form.get('file') : null;
        const type = req.query.get('type') || 'intro';
        return { filename: (f && f.name) ? f.name : ('custom_' + type + '.mp4') };
    });

    M.route('POST', 'api/intro_outro/process/([^/]+)', (m, req) => {
        const j = M.sim.get(m[1]);
        if (!j) return M.resp(404, { detail: 'Ismeretlen feladat (demo).' });
        j.cancelled = false;
        j.error = null;
        j.doneAt = null;
        j.startTs = Date.now();
        j.durationSec = 45 + Math.floor(Math.random() * 30);
        j.extra = j.extra || {};
        j.extra.process_opts = req.body || {};
        M.save();
        return {};
    });

    M.route('GET', 'api/intro_outro/jobs', (m, req) => {
        const limit = parseInt(req.query.get('limit') || '500', 10) || 500;
        return M.sim.list('intro_outro').map(ioView).slice(0, limit); // csupasz tömb
    });

    M.route('GET', 'api/intro_outro/status/([^/]+)', (m) => {
        const j = M.sim.get(m[1]);
        if (!j) return M.resp(404, { detail: 'Ismeretlen feladat (demo).' });
        return ioView(j);
    });

    M.route('POST', 'api/intro_outro/retry/([^/]+)', (m) => {
        const j = M.sim.get(m[1]);
        if (!j) return M.resp(404, { detail: 'Ismeretlen feladat (demo).' });
        M.sim.retry(m[1]);
        return {};
    });

    M.route('DELETE', 'api/intro_outro/job/([^/]+)', (m) => {
        M.sim.remove(m[1]);
        return {};
    });

    // — SSE: single-oldal státusz-stream ('status' nevű event) —
    M.sse('api/intro_outro/status/([^/]+)/stream', (es, m) => {
        const id = m[1];
        if (!M.sim.get(id)) { es.close(); return; }
        es.every(1500, () => {
            const j = M.sim.get(id);
            if (!j) { es.close(); return; }
            es.emit('status', ioView(j));
        });
    });

    // — SSE: batch lista stream ('snapshot' teljes listával; a kliens ettől
    //   leállítja az 5 mp-es pollingot, és a stream frissíti a cache-t) —
    M.sse('api/intro_outro/jobs/stream', (es) => {
        es.every(2500, () => {
            es.emit('snapshot', { items: M.sim.list('intro_outro').map(ioView) });
        });
    });

    /* ============================================================
     * SHARED alap action-ök (cancel/retry/törlés/metadata)
     * ------------------------------------------------------------
     * Generikus végpontok — ha egy másik route-modul is regisztrálja
     * őket, az elsőként betöltött nyer; a viselkedés mindkettőnél a
     * MOCK.sim-re épül, így az eredmény azonos.
     * ============================================================ */
    M.route('GET', 'api/job/([^/]+)/metadata', (m) => {
        const j = M.sim.get(m[1]);
        if (!j) return M.resp(404, { detail: 'Ismeretlen feladat (demo).' });
        return { original_filename: j.filename };
    });

    M.route('POST', 'api/cancel/([^/]+)', (m) => { M.sim.cancel(m[1]); return {}; });
    M.route('POST', 'api/retry/([^/]+)',  (m) => { M.sim.retry(m[1]);  return {}; });
    M.route('DELETE', 'api/job/([^/]+)',  (m) => { M.sim.remove(m[1]); return {}; });

    /* ============================================================
     * HANGMINTA-KÖNYVTÁR (voice_picker.js)
     * ============================================================ */
    M.route('GET', 'api/ppt_narrate/voices', () => X.voices);   // csupasz tömb

    M.route('POST', 'api/ppt_narrate/voices', (m, req) => {
        const form = req.form;
        const name = (form && form.get('display_name')) || 'Új hangminta';
        const lang = (form && form.get('language_hint')) || '';
        const key = slug(name) + '_' + Date.now().toString(36);
        const voice = {
            voice_key: key,
            display_name: name,
            language_hint: lang,
            uploader: currentUser(),
        };
        X.voices.push(voice);
        M.save();
        return voice;   // a teljes objektum megy a 'voiceLibraryChanged' event-be
    });

    M.route('DELETE', 'api/ppt_narrate/voices/([^/]+)', (m) => {
        const key = decodeURIComponent(m[1]);
        X.voices = X.voices.filter(v => v.voice_key !== key);
        M.save();
        return {};
    });
})();
