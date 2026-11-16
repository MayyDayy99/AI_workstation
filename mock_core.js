/* ============================================================
 * EDTI STUDIO — PORTFÓLIÓ DEMÓ MOCK MOTOR
 * ------------------------------------------------------------
 * Ez a fájl MINDEN oldal első scriptje. Elfogja a fetch-et, az
 * XMLHttpRequest-et és az EventSource-t, és egy determinisztikus,
 * idő-alapú szimulációval játssza el a teljes backendet: feltöltés,
 * feldolgozási fázisok, százalékok, szerverterhelés — valódi munka
 * nélkül. A route-okat a mock_routes_*.js modulok regisztrálják.
 *
 * Publikus API a route-moduloknak:
 *   MOCK.route(method, pathPattern, handler)
 *       pathPattern: regex-string a QUERY NÉLKÜLI útvonalra, mindig
 *       'api/...' alakban (vezető perjel nélkül!). Csoportok mehetnek.
 *       handler(match, req) →
 *           sima objektum/tömb  → 200 JSON
 *           MOCK.resp(st, obj) → tetszőleges státusz + JSON
 *           MOCK.file(relUrl)  → valódi statikus fájl proxy-zása
 *           Promise            → bevárjuk
 *       req: {method, path, query(URLSearchParams), body(JSON|null),
 *             form(FormData|null), raw(string|null), url}
 *   MOCK.sse(pathPattern, starter)
 *       starter(es, match): es.emit(name, obj), es.every(ms, fn),
 *       es.close(). Az es.every timerek close-kor takarodnak.
 *   MOCK.sim  — job-szimulátor (lásd lent), MOCK.state — perzisztens
 *   állapot (localStorage), MOCK.save(), MOCK.ts(), MOCK.uid(), stb.
 * ============================================================ */
(function () {
    'use strict';

    const VERSION = 'demo';           // KONSTANS — különben reload-loop
    const STORE_KEY = 'MOCK_STATE_v1';
    // Hibakereséshez: localStorage.MOCK_DEBUG = '1' → minden elfogott API-hívás a konzolra kerül.
    let DEBUG = false;
    try { DEBUG = !!localStorage.getItem('MOCK_DEBUG'); } catch (_) {}

    // A version-check első-látogatásos reloadját is megelőzzük:
    try { localStorage.setItem('_appVersion', VERSION); } catch (_) {}

    // ─── Demo session: minden oldalon be vagyunk "jelentkezve", kivéve
    // a login oldalt (azt meg lehessen nézni; bármilyen jelszó jó).
    const IS_LOGIN_PAGE = /login\.html?$/i.test(location.pathname);
    function setCookieRaw(n, v) {
        document.cookie = n + '=' + v + '; path=/; max-age=' + (365 * 24 * 3600) + '; SameSite=Lax';
    }
    function getCookieRaw(n) {
        const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + n + '=([^;]*)'));
        return m ? m[1] : null;
    }
    if (!IS_LOGIN_PAGE && !getCookieRaw('currentUser')) {
        setCookieRaw('currentUser', 'demo');
        setCookieRaw('currentWorkspace', 'Alapértelmezett');
        setCookieRaw('dubOwner', 'demo');
        try { localStorage.setItem('dubOwner', 'demo'); } catch (_) {}
    }

    // ─── Segédek ────────────────────────────────────────────────
    function pad(n) { return String(n).padStart(2, '0'); }
    // SQLite-stílusú UTC timestamp: 'YYYY-MM-DD HH:MM:SS' (NO 'T', NO 'Z')
    function ts(d) {
        d = d instanceof Date ? d : new Date(d || Date.now());
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) +
            ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
    }
    let _uidCounter = 0;
    function uid(prefix) {
        _uidCounter += 1;
        return (prefix || 'demo') + '-' + Date.now().toString(36) + '-' + _uidCounter;
    }
    function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

    // ─── Perzisztens állapot ────────────────────────────────────
    let state = null;
    try { state = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (_) {}
    if (!state || state.__v !== 1) state = { __v: 1, jobs: {}, extra: {} };
    function save() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
    }

    // ─── Fázistáblák: [felső %-határ, stage-kulcs, detail] ──────
    const STAGE_TABLES = {
        dub: [
            [4, 'queued', 'Sorban áll…'],
            [10, 'extract', 'Hang kivonása a videóból…'],
            [18, 'isolate', 'Beszéd leválasztása (Demucs)…'],
            [38, 'asr', 'Szöveg felismerése (Whisper large-v3)…'],
            [52, 'translate', 'Fordítás magyarról angolra (NLLB)…'],
            [62, 'refine', 'Szöveg finomítása…'],
            [82, 'tts', 'Beszéd szintézise (XTTS-v2)…'],
            [90, 'timefit', 'Időzítés a videóhoz…'],
            [95, 'mix', 'Hangkeverés…'],
            [100, 'mux', 'Videó összerakása…'],
        ],
        subtitle: [
            [6, 'queued', 'Sorban áll…'],
            [16, 'extract', 'Hang kivonása…'],
            [55, 'asr', 'Szöveg felismerése…'],
            [80, 'translate', 'Fordítás…'],
            [100, 'subtitles', 'Feliratfájlok generálása…'],
        ],
        transcribe: [
            [8, 'queued', 'Sorban áll…'],
            [20, 'extract', 'Hang kivonása…'],
            [85, 'asr', 'Szöveg felismerése…'],
            [100, 'export', 'Leirat exportálása…'],
        ],
        ppt_narrate: [
            [8, 'extracting_notes', 'Jegyzetek kinyerése a PPTX-ből…'],
            [20, 'rendering_slides', 'Diák renderelése (PDF → PNG)…'],
            [85, 'narrating', 'Narráció szintézise (XTTS)…'],
            [100, 'composing', 'Videó összeállítása…'],
        ],
        intro_outro: [
            [30, 'intro_outro_analyze', 'Videó elemzése…'],
            [100, 'intro_outro_render', 'Intro/outro render…'],
        ],
        ppt_replace: [
            [15, 'ppt_analyze', 'PPT elemzés…'],
            [35, 'ppt_detect', 'Dia-felismerés a videóban…'],
            [60, 'ppt_match', 'Dia-illesztés…'],
            [85, 'ppt_composite', 'Videó összerakása…'],
            [100, 'ppt_export', 'Export…'],
        ],
        course: [
            [10, 'queued', 'Sorban áll…'],
            [30, 'extract', 'Kurzus kicsomagolása…'],
            [80, 'asr', 'Videók feldolgozása…'],
            [100, 'mux', 'Csomag összeállítása…'],
        ],
    };

    // ─── Job-szimulátor ─────────────────────────────────────────
    // A progress a (startTs, durationSec) párból SZÁMÍTOTT érték — nem
    // kell háttér-timer, minden lekérdezés a valós eltelt időből dolgozik.
    const sim = {
        create(type, opts) {
            opts = opts || {};
            const id = opts.id || uid(type === 'dub' ? 'demo-dub' : 'demo-' + type);
            const dur = opts.durationSec || (90 + Math.floor(Math.random() * 60));
            const job = {
                id: id,
                type: type,
                filename: opts.filename || 'demo_video.mp4',
                mode: opts.mode || 'dub_full',
                owner: opts.owner || 'demo',
                created_at: ts(),
                startTs: opts.autostart === false ? null : Date.now(),
                durationSec: dur,
                pausedStage: opts.pausedStage || null, // pl. 'edit_ready' megálló
                doneAt: null,
                error: null,
                extra: opts.extra || {},
            };
            state.jobs[id] = job;
            save();
            return job;
        },
        start(id) {
            const j = state.jobs[id];
            if (j && !j.startTs) { j.startTs = Date.now(); save(); }
            return j;
        },
        get(id) { return state.jobs[id] || null; },
        remove(id) { delete state.jobs[id]; save(); },
        list(type) {
            return Object.values(state.jobs)
                .filter(j => !type || j.type === type)
                .sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
        },
        cancel(id) {
            const j = state.jobs[id];
            if (j) { j.error = null; j.cancelled = true; save(); }
        },
        retry(id) {
            const j = state.jobs[id];
            if (j) {
                j.cancelled = false; j.error = null;
                j.startTs = Date.now(); j.doneAt = null;
                save();
            }
        },
        // Élő státusz — {stage, progress, detail, status}
        status(id) {
            const j = state.jobs[id];
            if (!j) return { stage: 'error', progress: 0, detail: 'Ismeretlen feladat (demo)', error: 'Nem található', status: 'error' };
            if (j.cancelled) return this._wrap(j, 'cancelled', 0, 'Megszakítva', 'cancelled');
            if (j.error) return this._wrap(j, 'error', 0, j.error, 'error');
            if (!j.startTs) return this._wrap(j, 'uploaded', 0, 'Feltöltve — indításra vár', 'pending');
            const elapsed = (Date.now() - j.startTs) / 1000;
            let pct = clamp(Math.round(100 * elapsed / j.durationSec), 0, 100);
            const table = STAGE_TABLES[j.type] || STAGE_TABLES.dub;
            // edit_ready megálló (dub kétfázisú): 60%-nál megáll, amíg a
            // "Generate" el nem indítja a 2. fázist.
            if (j.pausedStage === 'edit_ready' && pct >= 60 && !j.phase2) {
                return this._wrap(j, 'edit_ready', 60, 'Szerkesztésre kész — indítsd a szinkront', 'running');
            }
            if (pct >= 100) {
                if (!j.doneAt) { j.doneAt = Date.now(); save(); }
                return this._wrap(j, 'done', 100, 'Kész ✔', 'done');
            }
            for (const [limit, stage, detail] of table) {
                if (pct <= limit) return this._wrap(j, stage, pct, detail, 'running');
            }
            return this._wrap(j, 'done', 100, 'Kész ✔', 'done');
        },
        _wrap(j, stage, pct, detail, status) {
            return {
                job_id: j.id, id: j.id, stage: stage, progress: pct, detail: detail,
                status: status, error: j.error || null, job_mode: j.mode,
                created_at: j.created_at, updated_at: ts(),
                original_filename: j.filename, owner: j.owner,
            };
        },
    };

    // ─── Kezdő fixture-ök: legyen mit nézegetni ─────────────────
    function seedFixtures() {
        if (state.extra.seeded) {
            // Az "örökmozgó" háttér-job: ha végzett, 1 perc múlva újraindul,
            // hogy a dashboard mindig mutasson életet.
            const bg = state.jobs['demo-dub-bg'];
            if (bg && bg.doneAt && Date.now() - bg.doneAt > 60000) {
                bg.startTs = Date.now(); bg.doneAt = null;
                bg.durationSec = 120 + Math.floor(Math.random() * 60);
                save();
            }
            return;
        }
        const H = 3600 * 1000;
        sim.create('dub', { id: 'demo-dub-1', filename: 'Digitalis_technika_3_eloadas.mp4', durationSec: 1, autostart: true });
        state.jobs['demo-dub-1'].startTs = Date.now() - 2 * H;   // rég kész
        state.jobs['demo-dub-1'].created_at = ts(Date.now() - 2 * H);
        sim.create('subtitle', { id: 'demo-sub-1', filename: 'Aramkorok_bevezeto.mp4', durationSec: 1 });
        state.jobs['demo-sub-1'].startTs = Date.now() - 5 * H;
        state.jobs['demo-sub-1'].created_at = ts(Date.now() - 5 * H);
        sim.create('ppt_narrate', { id: 'demo-ppt-1', filename: 'Logikai_kapuk.pptx', durationSec: 1 });
        state.jobs['demo-ppt-1'].startTs = Date.now() - 3 * H;
        state.jobs['demo-ppt-1'].created_at = ts(Date.now() - 3 * H);
        // Örökmozgó futó job:
        sim.create('dub', { id: 'demo-dub-bg', filename: 'Melytanulas_alapjai_7.mp4', durationSec: 180 });
        state.extra.seeded = true;
        save();
    }
    seedFixtures();

    // ─── Szerverterhelés-szimuláció (hullámzó, élethű) ──────────
    function healthStats() {
        const t = Date.now() / 1000;
        const running = sim.list().filter(j => {
            const s = sim.status(j.id); return s.status === 'running';
        }).length;
        const busy = running > 0 ? 1 : 0;
        const wave = (f, ph) => (Math.sin(t / f + ph) + 1) / 2; // 0..1
        const cpu = Math.round(clamp(12 + 55 * busy * wave(9, 0) + 8 * wave(3.7, 2), 3, 97));
        const vramPct = Math.round(clamp(18 + 62 * busy * wave(14, 1) + 5 * wave(5.1, 4), 5, 96));
        const ram = Math.round(clamp(34 + 18 * busy * wave(23, 3) + 4 * wave(7.3, 1), 20, 92));
        return {
            gpu: { available: true, vram_percent: vramPct, vram_used_mb: Math.round(6144 * vramPct / 100) },
            ram: { used_percent: ram },
            cpu: { used_percent: cpu },
            queue_length: Math.max(0, running - 1),
            running_jobs: running,
            storage: { deletable_mb: 3271.4 },
        };
    }

    // ─── Router ─────────────────────────────────────────────────
    const routes = [];
    function route(method, pattern, handler) {
        routes.push({ method: method.toUpperCase(), re: new RegExp('^' + pattern + '$'), handler });
    }
    function resp(status, json) { return { __mockResp: true, status: status, json: json }; }
    function file(relUrl) { return { __mockFile: true, url: relUrl }; }

    // 'api/...' kanonikus útvonal kinyerése bármilyen URL-alakból.
    function apiPath(url) {
        let s = String(url);
        const i = s.indexOf('api/');
        if (i === -1) return null;
        // Csak akkor API, ha az 'api/' a path elején vagy '/' után áll.
        if (i > 0 && s[i - 1] !== '/') return null;
        return s.slice(i);
    }

    async function dispatch(method, url, init, bodyOverride) {
        const full = apiPath(url);
        const qIdx = full.indexOf('?');
        const path = qIdx === -1 ? full : full.slice(0, qIdx);
        const query = new URLSearchParams(qIdx === -1 ? '' : full.slice(qIdx + 1));
        let body = null, form = null, raw = null;
        const b = bodyOverride !== undefined ? bodyOverride : (init && init.body);
        if (b != null) {
            if (typeof FormData !== 'undefined' && b instanceof FormData) form = b;
            else if (typeof b === 'string') { raw = b; try { body = JSON.parse(b); } catch (_) {} }
            else if (b instanceof Blob) raw = '[blob]';
        }
        const req = { method: method, path: path, query: query, body: body, form: form, raw: raw, url: String(url) };
        if (DEBUG) console.log('[MOCK] →', method, path, body ? JSON.stringify(body).slice(0, 160) : '');
        for (const r of routes) {
            if (r.method !== method.toUpperCase()) continue;
            const m = path.match(r.re);
            if (!m) continue;
            let out = r.handler(m, req);
            if (out && typeof out.then === 'function') out = await out;
            return toResponse(out);
        }
        console.warn('[MOCK] nincs route:', method, path);
        return toResponse(resp(404, { detail: 'Demo mód: ez a funkció itt nem elérhető.' }));
    }

    function toResponse(out) {
        if (out instanceof Response) return out;
        if (out && out.__mockFile) return realFetch(out.url);
        let status = 200, json = out == null ? {} : out;
        if (out && out.__mockResp) { status = out.status; json = out.json == null ? {} : out.json; }
        return new Response(JSON.stringify(json), {
            status: status,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ─── fetch patch (a shared.js EZT csomagolja majd be — jó így) ──
    const realFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        const url = (input && input.url) ? input.url : String(input);
        if (apiPath(url) !== null) {
            const method = (init && init.method) || (input && input.method) || 'GET';
            return dispatch(method, url, init);
        }
        return realFetch(input, init);
    };

    // ─── XMLHttpRequest patch (chunk-upload + progress csíkok) ──
    const RealXHR = window.XMLHttpRequest;
    function MockXHR() {
        const self = this;
        this._real = new RealXHR();
        this._isApi = false;
        this.upload = { onprogress: null, addEventListener: function (n, f) { if (n === 'progress') this.onprogress = f; } };
        this.readyState = 0; this.status = 0; this.responseText = ''; this.response = '';
        this.onload = null; this.onerror = null; this.ontimeout = null; this.onreadystatechange = null;
        this.timeout = 0; this.withCredentials = false;
        // Nem-API kérésekhez az igazi XHR eseményeit tükrözzük.
        ['onload', 'onerror', 'ontimeout', 'onreadystatechange'].forEach(function (h) {
            self._real[h] = function () {
                if (self._isApi) return;
                self.readyState = self._real.readyState;
                try { self.status = self._real.status; self.responseText = self._real.responseText; self.response = self._real.response; } catch (_) {}
                if (typeof self[h] === 'function') self[h].apply(self, arguments);
            };
        });
    }
    MockXHR.prototype.open = function (method, url, async) {
        this._method = method; this._url = url;
        this._isApi = apiPath(url) !== null;
        if (!this._isApi) this._real.open(method, url, async !== false);
        this.readyState = 1;
    };
    MockXHR.prototype.setRequestHeader = function (k, v) { if (!this._isApi) this._real.setRequestHeader(k, v); };
    MockXHR.prototype.getResponseHeader = function () { return null; };
    MockXHR.prototype.abort = function () { if (!this._isApi) this._real.abort(); this._aborted = true; };
    MockXHR.prototype.addEventListener = function (n, f) { this['on' + n] = f; };
    MockXHR.prototype.send = function (body) {
        const self = this;
        if (!this._isApi) { this._real.send(body); return; }
        // Szimulált feltöltés-progress: a csík ~600ms alatt fut fel.
        const total = (body && body.size) || 1024 * 1024;
        const steps = 6;
        let step = 0;
        const timer = setInterval(function () {
            step += 1;
            if (self._aborted) { clearInterval(timer); return; }
            if (self.upload.onprogress) {
                self.upload.onprogress({ lengthComputable: true, loaded: Math.round(total * step / steps), total: total });
            }
            if (step >= steps) {
                clearInterval(timer);
                dispatch(self._method, self._url, null, body).then(async function (r) {
                    self.status = r.status;
                    self.responseText = await r.text();
                    self.response = self.responseText;
                    self.readyState = 4;
                    if (self.onreadystatechange) self.onreadystatechange();
                    if (self.onload) self.onload();
                });
            }
        }, 100);
    };
    window.XMLHttpRequest = MockXHR;

    // ─── EventSource patch ──────────────────────────────────────
    const sseRoutes = [];
    function sse(pattern, starter) {
        sseRoutes.push({ re: new RegExp('^' + pattern + '$'), starter: starter });
    }
    const RealES = window.EventSource;
    function MockES(url, opts) {
        const p = apiPath(url);
        if (p === null) return new RealES(url, opts);
        const path = p.indexOf('?') === -1 ? p : p.slice(0, p.indexOf('?'));
        const self = this;
        this.url = String(url);
        this.readyState = 0; // CONNECTING
        this.onopen = null; this.onmessage = null; this.onerror = null;
        this._listeners = {};
        this._timers = [];
        let matched = null, m = null;
        for (const r of sseRoutes) { m = path.match(r.re); if (m) { matched = r; break; } }
        setTimeout(function () {
            if (self.readyState === 2) return;
            if (!matched) {
                // Nincs mock-stream: CLOSED + error → a kliens szépen
                // visszaesik pollingra (a kód pont ezt várja).
                self.readyState = 2;
                if (self.onerror) self.onerror(new Event('error'));
                return;
            }
            self.readyState = 1;
            if (self.onopen) self.onopen(new Event('open'));
            const controller = {
                emit: function (name, data) {
                    const ev = new MessageEvent(name || 'message', { data: JSON.stringify(data) });
                    if (name && self._listeners[name]) self._listeners[name].forEach(f => f(ev));
                    if ((!name || name === 'message') && self.onmessage) self.onmessage(ev);
                },
                every: function (ms, fn) { const t = setInterval(fn, ms); self._timers.push(t); fn(); return t; },
                close: function () { self.close(); },
            };
            try { matched.starter(controller, m); } catch (e) { console.warn('[MOCK] sse starter hiba:', e); }
        }, 30);
    }
    MockES.prototype.addEventListener = function (n, f) {
        (this._listeners[n] = this._listeners[n] || []).push(f);
    };
    MockES.prototype.removeEventListener = function (n, f) {
        if (this._listeners[n]) this._listeners[n] = this._listeners[n].filter(x => x !== f);
    };
    MockES.prototype.close = function () {
        this.readyState = 2;
        this._timers.forEach(clearTimeout);
        this._timers.forEach(clearInterval);
        this._timers = [];
    };
    MockES.CONNECTING = 0; MockES.OPEN = 1; MockES.CLOSED = 2;
    window.EventSource = MockES;

    // ─── Alap route-ok (core kontraktus) ────────────────────────
    route('GET', 'api/version', () => ({ version: VERSION }));
    route('GET', 'api/me', () => IS_LOGIN_PAGE ? resp(403, {}) : {});
    route('POST', 'api/login', (m, req) => {
        const u = (req.body && req.body.username) || 'demo';
        setCookieRaw('currentUser', u);
        setCookieRaw('currentWorkspace', 'Alapértelmezett');
        setCookieRaw('dubOwner', u);
        return {};
    });
    route('POST', 'api/logout', () => ({}));
    route('GET', 'api/whoami', () => ({
        username: getCookieRaw('currentUser') || 'demo',
        role: 'admin',
        workspaces: ['Alapértelmezett', 'Portfólió'],
        current_workspace: getCookieRaw('currentWorkspace') || 'Alapértelmezett',
    }));
    route('GET', 'api/workspaces', () => ({ workspaces: ['Alapértelmezett', 'Portfólió'], active: getCookieRaw('currentWorkspace') || 'Alapértelmezett' }));
    route('POST', 'api/workspaces', () => ({}));
    route('DELETE', 'api/workspaces/([^/]+)', () => ({}));
    route('GET', 'api/health/stats', () => healthStats());
    route('GET', 'api/health', () => ({ status: 'ok' }));
    route('POST', 'api/check-duplicate', () => ({ duplicate: false, match: null }));

    // ─── Demo szalag ────────────────────────────────────────────
    function banner() {
        if (document.getElementById('_demoRibbon')) return;
        const el = document.createElement('div');
        el.id = '_demoRibbon';
        el.textContent = 'DEMÓ — minden adat és feldolgozás szimulált';
        el.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:99999;' +
            'background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff;' +
            'padding:6px 14px;border-radius:999px;font:600 0.78rem system-ui,sans-serif;' +
            'box-shadow:0 4px 18px rgba(0,0,0,0.45);opacity:0.93;pointer-events:none;';
        document.body.appendChild(el);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner);
    else banner();

    // ─── Export ─────────────────────────────────────────────────
    window.MOCK = {
        route: route, sse: sse, resp: resp, file: file,
        // belső hívás egy másik route-ra (pl. a darabolt feltöltés finalize-a a modul saját upload-route-jára)
        call: function (method, url, body) { return dispatch(method, url, null, body === undefined ? null : body); },
        sim: sim, state: state, save: save,
        ts: ts, uid: uid, healthStats: healthStats,
        STAGE_TABLES: STAGE_TABLES,
        VERSION: VERSION,
        // fix demó-asset útvonalak (valódi statikus fájlok a repóban):
        ASSET_VIDEO: 'demo_assets_video.mp4',
        ASSET_THUMB: 'demo_assets_thumb.jpg',
    };
})();
