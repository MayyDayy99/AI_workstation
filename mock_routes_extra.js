/* ============================================================
 * mock_routes_extra.js — a stúdió újabb funkcióinak mockja
 * ------------------------------------------------------------
 *  - Fájlkonvertáló (convert.html): célformátumok, indítás,
 *    élő haladás (a HTML → MP4 motoroknál valódi százalékkal),
 *    előzmények, törlés. A letöltés statikus fájl
 *    (api/convert/download/demo-conv-N), mert <a href> navigáció.
 *  - Kapcsolódó szolgáltatások csempéi a kezdőlapon: élő állapot,
 *    de cím nélkül — a valódi tunnel-címek nem kerülnek a demóba.
 *  - Kisebb új végpontok: sor elejére vétel, dia-újragenerálás
 *    megszakítása, PPTX utólagos csatolása, köztes fájlok takarítása.
 * A célformátum-kínálat a backend szabályait követi
 * (backend/convert/formats.py).
 * ============================================================ */
(function () {
    'use strict';
    const M = window.MOCK;
    if (!M) return;

    /* ─── Fájlkonvertáló ─────────────────────────────────────── */
    const TARGETS = [
        ['pdf', 'PDF', 'Dokumentum'], ['docx', 'Word (DOCX)', 'Dokumentum'], ['odt', 'OpenDocument szöveg (ODT)', 'Dokumentum'],
        ['txt', 'Egyszerű szöveg (TXT)', 'Dokumentum'], ['md', 'Markdown', 'Dokumentum'], ['html', 'Weblap (HTML)', 'Dokumentum'],
        ['epub', 'E-könyv (EPUB)', 'Dokumentum'], ['pptx', 'PowerPoint (PPTX)', 'Bemutató'], ['odp', 'OpenDocument bemutató (ODP)', 'Bemutató'],
        ['xlsx', 'Excel (XLSX)', 'Táblázat'], ['ods', 'OpenDocument táblázat (ODS)', 'Táblázat'], ['csv', 'CSV', 'Táblázat'],
        ['png', 'PNG', 'Kép'], ['jpg', 'JPG', 'Kép'], ['webp', 'WebP', 'Kép'], ['avif', 'AVIF', 'Kép'], ['tiff', 'TIFF', 'Kép'],
        ['gif', 'GIF', 'Kép'], ['svg', 'SVG', 'Kép'], ['mp4', 'MP4 (H.264)', 'Videó'], ['webm', 'WebM', 'Videó'], ['mov', 'MOV', 'Videó'],
        ['mkv', 'MKV', 'Videó'], ['mp3', 'MP3', 'Hang'], ['m4a', 'M4A (AAC)', 'Hang'], ['wav', 'WAV', 'Hang'], ['flac', 'FLAC', 'Hang'],
        ['ogg', 'OGG', 'Hang'], ['opus', 'Opus', 'Hang'], ['srt', 'SRT', 'Felirat'], ['vtt', 'WebVTT', 'Felirat'], ['ass', 'ASS', 'Felirat'],
    ];
    const set = (a) => new Set(a);
    const DOC = ['pdf', 'docx', 'odt', 'txt', 'md', 'html', 'epub'], SLIDES = ['pptx', 'odp'], SHEETS = ['xlsx', 'ods', 'csv'];
    const IMAGES = ['png', 'jpg', 'webp', 'avif', 'tiff', 'gif', 'svg'], VIDEO = ['mp4', 'webm', 'mov', 'mkv'];
    const AUDIO = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'], SUBS = ['srt', 'vtt', 'ass'];
    const RULES = {
        document: set(DOC.concat(SLIDES, ['png', 'jpg', 'webp', 'tiff'])),
        presentation: set(DOC.filter(x => x !== 'epub').concat(SLIDES, ['png', 'jpg', 'webp', 'tiff'])),
        spreadsheet: set(SHEETS.concat(['pdf', 'html'])),
        image: set(IMAGES.concat(['pdf'])),
        audio: set(AUDIO),
        video: set(VIDEO.concat(AUDIO, SUBS, ['gif', 'png', 'jpg'])),
        subtitle: set(SUBS),
    };
    const GROUP = {};
    [['document', 'pdf docx doc odt rtf txt md html htm epub'], ['presentation', 'pptx ppt odp'], ['spreadsheet', 'xlsx xls ods csv'],
     ['image', 'png jpg jpeg webp avif tif tiff bmp gif heic heif svg'], ['audio', 'mp3 wav m4a aac flac ogg opus wma'],
     ['video', 'mp4 mov mkv webm avi wmv m4v mpg mpeg'], ['subtitle', 'srt vtt ass ssa']]
        .forEach(([g, list]) => list.split(' ').forEach(e => { GROUP[e] = g; }));
    const ALIAS = { jpeg: 'jpg', tif: 'tiff', htm: 'html' };
    const CAPTURE = { ext: 'mp4', label: 'MP4 videó (oldalfelvétel — bármilyen HTML)', group: 'Videó HTML-ből', engine: 'capture' };
    const RENDER = { ext: 'mp4', label: 'MP4 videó (HyperFrames-kompozíció)', group: 'Videó HTML-ből', engine: 'hyperframes' };

    function offered(ext) {
        ext = String(ext || '').toLowerCase().replace(/^\./, '');
        const html2video = ext === 'html' || ext === 'htm' || ext === 'zip';
        if (ext === 'zip') return [Object.assign({}, CAPTURE), Object.assign({}, RENDER)];   // ZIP-et a Filee nem kap
        const allowed = RULES[GROUP[ext]] || new Set();
        const src = ALIAS[ext] || ext;
        const out = TARGETS.filter(t => allowed.has(t[0]) && t[0] !== src)
            .map(t => ({ ext: t[0], label: t[1], group: t[2], engine: 'filee' }));
        if (html2video) out.push(Object.assign({}, CAPTURE), Object.assign({}, RENDER));
        return out;
    }
    function labelFor(ext) { const t = TARGETS.find(x => x[0] === ext); return t ? t[1] : String(ext || '').toUpperCase(); }

    if (!M.state.extra.convert) M.state.extra.convert = { pool: 0, jobs: {} };
    const C = M.state.extra.convert;
    const POOL = ['demo-conv-1', 'demo-conv-2', 'demo-conv-3'];   // a statikus letöltő-fájlok miatt fix id-k

    function extOf(name) { const i = String(name || '').lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }

    // A job állapota a valós eltelt időből számolódik (nincs háttér-időzítő).
    function view(j) {
        const out = {
            id: j.id, original_filename: j.filename, target: j.target || null, owner: j.owner || 'demo',
            created_at: j.created_at, updated_at: M.ts(), outputs: null, error_detail: null,
            engine: j.engine || null, render_options: j.options || null, render_gpu: null, render_seconds: null,
            target_label: j.engine === 'capture' ? CAPTURE.label : j.engine === 'hyperframes' ? RENDER.label : (j.target ? labelFor(j.target) : null),
            expires_at: Math.round(new Date(j.created_at.replace(' ', 'T') + 'Z').getTime() / 1000) + 24 * 3600,
            can_modify: true,
        };
        if (!j.startTs) return Object.assign(out, { stage: 'uploaded', progress: 0, detail: 'Feltöltve — célformátumra vár' });
        const el = (Date.now() - j.startTs) / 1000, h2v = j.engine === 'capture' || j.engine === 'hyperframes';
        const queue = 1.5, dur = j.durationSec;
        if (el < queue) return Object.assign(out, { stage: 'queued', progress: 5, detail: 'Sorban áll…' });
        const pct = Math.min(100, ((el - queue) / dur) * 100);
        if (pct >= 100) {
            return Object.assign(out, {
                stage: 'done', progress: 100, detail: 'Kész ✔', outputs: [j.target],
                render_seconds: h2v ? Math.round(dur * 7) : null,
                render_gpu: h2v ? { encode: 'nvenc', browser: 'software' } : null,
            });
        }
        if (!h2v) return Object.assign(out, { stage: 'converting', progress: 50, detail: 'Konvertálás (Filee)…' });
        const word = j.engine === 'capture' ? 'Felvétel' : 'Renderelés';
        const phase = pct < 8 ? 'betöltés' : pct < 85 ? 'képkockák' : pct < 96 ? 'kódolás' : 'összefűzés';
        return Object.assign(out, { stage: 'converting', progress: Math.round(12 + pct * 0.86), detail: word + ': ' + Math.round(pct) + '% (' + phase + ')' });
    }

    // a darabolt feltöltés finalize-a hívja (purpose: 'convert')
    M.route('POST', 'api/convert/__upload', (m, req) => {
        const f = req.form ? req.form.get('file') : null;
        const id = POOL[C.pool % POOL.length];
        C.pool += 1;
        C.jobs[id] = { id: id, filename: (f && f.name) || 'dokumentum.docx', owner: 'demo', created_at: M.ts(), startTs: null };
        M.save();
        return { job_id: id, status: 'uploaded' };
    });
    M.route('GET', 'api/convert/formats', (m, req) => {
        const ext = String(req.query.get('ext') || '').toLowerCase().replace(/^\./, '');
        if (!GROUP[ext] && ext !== 'zip') return M.resp(400, { detail: 'Ez a fájltípus nem konvertálható.' });
        return { from: ext, targets: offered(ext) };
    });
    M.route('POST', 'api/convert/start/([^/]+)', (m, req) => {
        const j = C.jobs[m[1]];
        if (!j) return M.resp(409, { detail: 'A feltöltött fájl már nincs meg — töltsd fel újra.' });
        const v = view(j);
        if (v.stage === 'queued' || v.stage === 'converting') return M.resp(423, { detail: 'A konverzió már fut vagy sorban áll.' });
        const b = req.body || {};
        const list = offered(extOf(j.filename));
        const t = list.find(x => x.ext === b.target && (!b.engine || x.engine === b.engine));
        if (!t) return M.resp(400, { detail: 'Erre a formátumra ez a fájl nem konvertálható.' });
        const h2v = t.engine === 'capture' || t.engine === 'hyperframes';
        j.target = t.ext; j.engine = t.engine; j.startTs = Date.now();
        j.options = h2v ? { quality: b.quality || 'standard', fps: b.fps || 30, seconds: b.seconds || 0, hide_controls: b.hide_controls !== false } : null;
        j.durationSec = h2v ? 14 + Math.random() * 6 : 3 + Math.random() * 3;
        M.save();
        return { status: 'queued', target: t.ext, engine: t.engine };
    });
    M.route('GET', 'api/convert/status/([^/]+)', (m) => {
        const j = C.jobs[m[1]];
        return j ? view(j) : M.resp(404, { detail: 'Job not found' });
    });
    M.route('GET', 'api/convert/jobs', (m, req) => {
        const limit = Math.max(1, Math.min(200, Number(req.query.get('limit') || 50)));
        return Object.values(C.jobs).sort((a, b) => (b.created_at > a.created_at ? 1 : -1)).slice(0, limit).map(view);
    });
    M.route('DELETE', 'api/convert/job/([^/]+)', (m) => {
        if (!C.jobs[m[1]]) return M.resp(404, { detail: 'Job not found' });
        delete C.jobs[m[1]]; M.save();
        return { status: 'deleted' };
    });

    /* ─── Letöltések neve ───────────────────────────────────────
     * A letöltés statikus fájl (navigáció, fetch-csel nem fogható el), és a
     * kiterjesztés nélküli statikus fájlnak nincs neve — az éles szerver a
     * Content-Disposition fejlécben adja. Itt a kattintás pillanatában kapja meg:
     * felhasználói kattintásnál és a lapok programozott a.click()-jénél is. */
    const DL = [
        [/api\/convert\/download\/([^/?#]+)$/, (id) => { const j = C.jobs[id]; return stem(j && j.filename, 'konvertalt') + '_demo.zip'; }],
        [/api\/intro_outro\/download\/([^/?#]+)$/, (id) => stem(jobName(id), 'video') + '_intro_outro.mp4'],
        [/api\/ppt_narrate\/download\/([^/?#]+)$/, (id) => stem(jobName(id), 'eloadas') + '_narralt.mp4'],
        [/api\/ppt_replace\/download\/([^/?#]+)$/, (id) => stem(jobName(id), 'video') + '_ppt_csere.mp4'],
        [/api\/course\/download\/([^/?#]+)$/, (id) => 'kurzus_' + id + '.mp4'],
    ];
    function stem(name, dflt) { return String(name || dflt).replace(/\.[^.]+$/, '') || dflt; }
    function jobName(id) { const j = M.sim.get(id); return j && j.filename; }
    function nameFor(a) {
        if (!a || a.tagName !== 'A' || a.getAttribute('download')) return;      // a lap már adott nevet
        const href = (a.getAttribute('href') || '').split('?')[0];
        for (const [re, fn] of DL) {
            const m = href.match(re);
            if (m) { a.setAttribute('download', fn(decodeURIComponent(m[1]))); return; }
        }
    }
    document.addEventListener('click', function (e) {
        nameFor(e.target && e.target.closest ? e.target.closest('a[href*="api/"]') : null);
    }, true);
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { try { nameFor(this); } catch (_) {} return origClick.apply(this, arguments); };

    /* ─── Kapcsolódó szolgáltatások (kezdőlap, csak admin) ──────
     * Cím nélkül: a csempe mutatja az állapotot, de nem visz sehova. */
    M.route('GET', 'api/services/status', () => ({
        services: [
            { key: 'n8n', label: 'n8n', subtitle: 'Workflow automatizálás', icon: '🔗', url: '', ui: false, state: 'up' },
            { key: 'comfyui', label: 'ComfyUI', subtitle: 'Kép-generálás', icon: '🎨', url: '', ui: false, state: 'up' },
            { key: 'converter', label: 'Fájlkonvertáló motor', subtitle: 'Filee — dokumentum, kép, hang, videó', icon: '🔄', url: '', ui: false, state: 'up' },
            { key: 'html2video', label: 'HTML → MP4 renderelő', subtitle: 'Oldalfelvétel és HyperFrames-kompozíció', icon: '🎬', url: '', ui: false, state: 'up' },
            { key: 'crawl4ai', label: 'Crawl4AI', subtitle: 'Web-scraping képesség', icon: '🕸️', url: '', ui: false, state: 'up' },
        ],
    }));

    /* ─── Kisebb új végpontok ────────────────────────────────── */
    M.route('POST', 'api/queue/([^/]+)/prioritize', (m) => {
        const j = M.sim.get(m[1]);
        if (j) { j.bumped = true; M.save(); }
        return { status: 'prioritized', queue_position: 1 };
    });
    M.route('POST', 'api/ppt_narrate/regen-cancel/([^/]+)', () => ({ status: 'cancel_requested' }));
    M.route('POST', 'api/ppt_replace/upload-pptx/([^/]+)', (m) => {
        const j = M.sim.get(m[1]);
        if (j) { j.extra = Object.assign({}, j.extra, { pptx: true }); M.save(); }
        return { status: 'uploaded' };
    });
    // Előbb próbafuttatás (dry_run), aztán a valódi: a demóban mindkettő ugyanazt mondja.
    M.route('POST', 'api/admin/storage/cleanup-intermediates', (m, req) => {
        const b = req.body || {};
        const n = b.mode === 'dub_full' ? 3 : 4;
        const mb = b.mode === 'dub_full' ? 2184.6 : 1873.2;
        return { mode: b.mode || '', dry_run: !!b.dry_run, jobs_touched: n, bytes_freed: Math.round(mb * 1048576),
                 bytes_freed_human: (mb / 1024).toFixed(2) + ' GB', errors: [] };
    });
})();
