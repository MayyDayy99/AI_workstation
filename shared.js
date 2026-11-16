// shared.js — Közös utility-k minden EDTI Stúdió oldalhoz
const API_URL = 'api';

// ============================================================
// TÉMA (sötét / világos)
// ------------------------------------------------------------
// A sötét az alap; a világosat a <html data-theme="light"> kapcsolja be,
// és a style.css-ben EGYETLEN token-blokk fordítja át. Azért attribútum és
// nem @media (prefers-color-scheme), mert a media-query + attribútum kettőse
// duplikálná az egész palettát — a rendszer-preferenciát itt olvassuk ki, egy
// helyen.
//
// A shared.js a <head>-ben, a <body> ELŐTT fut le minden lapon, ezért a téma
// az első festés előtt beáll: nincs villanás.
// ============================================================
const THEME_KEY = 'edti_theme';

function _systemPrefersLight() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches; } catch (_) { return false; }
}

function getTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (_) { /* privát mód */ }
    if (saved === 'light' || saved === 'dark') return saved;
    return _systemPrefersLight() ? 'light' : 'dark';
}

function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light') root.setAttribute('data-theme', 'light');
    else root.removeAttribute('data-theme');
    // A böngésző UI-ja (mobil címsor) is kövesse.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f5f7fa' : '#0e0e1a');
    const btn = document.getElementById('themeToggle');
    if (btn) {
        const toLight = theme !== 'light';
        btn.textContent = toLight ? '☀️' : '🌙';
        const label = toLight ? 'Világos témára váltás' : 'Sötét témára váltás';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    }
}

function setTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* privát mód */ }
    applyTheme(theme);
}

function toggleTheme() {
    setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
}
window.toggleTheme = toggleTheme;

// AZONNAL alkalmazzuk — még a <body> megnyitása előtt, hogy ne villanjon.
applyTheme(getTheme());

// A rendszer-beállítás követése, amíg a felhasználó nem választott kézzel.
try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
        let saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (_) {}
        if (!saved) applyTheme(e.matches ? 'light' : 'dark');
    });
} catch (_) { /* régi böngésző */ }

// A váltógomb minden lapra magától kerül ki — nincs közös fejléc-komponens,
// amibe be lehetne tenni, és 19 lapot kézzel bővíteni pont az a duplikáció
// lenne, ami ellen ez az egész munka szól.
function _mountThemeToggle() {
    if (document.getElementById('themeToggle')) return;
    const btn = document.createElement('button');
    btn.id = 'themeToggle';
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.addEventListener('click', toggleTheme);
    document.body.appendChild(btn);
    applyTheme(getTheme());
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _mountThemeToggle);
} else {
    _mountThemeToggle();
}

// ============================================================
// AUTH HELPER - Redirect to login on 401
// ============================================================
// ============================================================
// EL NEM MENTETT SZERKESZTÉSEK (UI-18)
// ============================================================
// A szinkron- és a felirat-szerkesztő a KÉPERNYŐN tartja a módosítást, a
// backend viszont a MENTETT segments.json-ből exportál és generál. Ebből három
// hiba fakadt, mind mérve: (1) a mentés hibánál is sikert jelzett; (2) 401-nél
// az alábbi csomagoló azonnal a belépő lapra navigált, a szerkesztéssel
// együtt; (3) az export és a generálás mentés nélkül a javítatlan szövegből
// dolgozott. A szerkesztők a `markUnsaved()`-dal jelzik a módosítást.
const _unsaved = { dirty: false };
function markUnsaved(dirty = true) {
    _unsaved.dirty = !!dirty;
    if (!_unsaved.dirty) _clearSessionExpiredNotice();
}
function hasUnsavedChanges() { return _unsaved.dirty; }

// Bezárás, frissítés, elnavigálás mentetlen módosítással: a böngésző kérdez.
window.addEventListener('beforeunload', (e) => {
    if (!_unsaved.dirty) return;
    e.preventDefault();
    e.returnValue = '';
});

// Tartós (nem eltűnő) figyelmeztetés a toast-konténerben. A süti a lapok
// között közös: egy új lapon belépve ezen a lapon a következő mentés sikerül.
function _showSessionExpiredNotice() {
    if (document.getElementById('_sessionExpired')) return;
    const c = _ensureToastContainer();
    const el = document.createElement('div');
    el.id = '_sessionExpired';
    el.className = 'toast';
    el.setAttribute('data-kind', 'warning');
    el.setAttribute('role', 'alert');
    const strong = document.createElement('strong');
    strong.textContent = 'A munkamenet lejárt — a szerkesztésed még nincs mentve.';
    const p = document.createElement('div');
    p.append('Ne zárd be ezt a lapot. ');
    const a = document.createElement('a');
    a.href = 'login.html'; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = 'Jelentkezz be egy új lapon';
    p.append(a, ', aztán mentsd újra itt.');
    el.append(strong, p);
    c.appendChild(el);
}
function _clearSessionExpiredNotice() {
    const el = document.getElementById('_sessionExpired');
    if (el) el.remove();
}

const _origFetch = window.fetch.bind(window);
window.fetch = async function(...args) {
    const resp = await _origFetch(...args);
    if (resp.status === 401 && !String(args[0]).includes('api/login') && !String(args[0]).includes('api/me')) {
        // Mentetlen szerkesztéssel NEM navigálunk el: az elvinné a munkát.
        if (_unsaved.dirty) _showSessionExpiredNotice();
        else window.location.href = 'login.html';
    }
    return resp;
};

// ============================================================
// USER SESSION
// ============================================================
// A süti-értéket MINDIG százalékkódolva írjuk. Kódolatlanul egy ékezetes
// munkaterület-név („Tanszék") UTF-8 bájtokként ment el, a backend viszont a
// fejlécet latin-1-ként olvassa → „TanszÃ©k", ami egyik munkaterülettel sem
// illeszkedett; egy „;"-t tartalmazó név pedig egyszerűen kettévágta a sütit.
// (UI-17; a backend oldala: auth.decode_workspace_cookie.)
function setCookie(name, value, days) {
    let expires = "";
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + encodeURIComponent(value || "") + expires + "; path=/; SameSite=Lax";
}

function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) == ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) == 0) {
            const raw = c.substring(nameEQ.length, c.length);
            // A régi, kódolatlan értékek (és egy „100% kész"-féle név) nem
            // érvényes százalékkódolás — ezeket nyersen adjuk vissza.
            try { return decodeURIComponent(raw); } catch (_) { return raw; }
        }
    }
    return null;
}

// A jobok tulajdonosa (ADR-008): a FELHASZNÁLÓNÉV, munkaterülettől
// függetlenül — a munkaterület a jobok címkéje, nem része a tulajdonosnak.
// Eddig a nem-alapértelmezett munkaterületben „felhasználó::munkaterület"
// kulcsot adott (a régi ADR-002 minta): a batch-lapok „Saját munkáim"
// szűrője (owner === getOwner()) ott MINDEN tételt kiszűrt. (TD-027)
// A `let _userInfo` lejjebb áll a fájlban: a kiértékelés közbeni hívás ne
// fusson TDZ-hibára.
function _ui() { try { return _userInfo; } catch (_) { return null; } }

function getOwner() {
    const n = (_ui() && _ui().username) || getCookie('dubOwner')
        || localStorage.getItem('dubOwner') || getCookie('currentUser');
    return n ? String(n).split('::')[0] : null;
}

// Visszafelé-kompatibilis csonk: a tulajdonos-kulcs a felhasználónév (ADR-008).
function _computeWorkspaceKey(username) {
    return username;
}

// ── Munkaterület-szűrés (TD-027) ──────────────────────────────────────
// A job címkéje a létrehozásakor aktív munkaterület (a backend is így
// címkéz). Címke nélküli (a TD-027 előtti) vagy már törölt munkaterületű
// job az alapértelmezettben (az első) látszik — így egy munkaterület
// törlése sem tüntet el semmit. A lista a /api/workspaces-ből jön, és a
// localStorage-ban is megmarad, hogy a lapok első renderje is szűrhessen.
const _WS_CACHE_KEY = 'edti-workspaces';

function _knownWorkspaces() {
    const fromInfo = _ui() && _ui().workspaces;
    if (fromInfo && fromInfo.length) return fromInfo;
    try {
        const cached = JSON.parse(localStorage.getItem(_WS_CACHE_KEY) || 'null');
        if (Array.isArray(cached) && cached.length) return cached;
    } catch (_) { /* ignore */ }
    return null;
}

/** Az aktív munkaterület neve (címkézéshez) — ismeretlen listánál a süti. */
function currentWorkspaceLabel() {
    const wss = _knownWorkspaces();
    const cur = getCookie('currentWorkspace') || '';
    if (!wss) return cur || null;
    return wss.includes(cur) ? cur : wss[0];
}

/** Egy job (címkéje alapján) az aktív munkaterületben látszik-e. */
function isInCurrentWorkspace(label) {
    const wss = _knownWorkspaces();
    if (!wss) return true;                       // még nem ismert → nem szűrünk
    const def = wss[0];
    return (wss.includes(label) ? label : def) === currentWorkspaceLabel();
}
window.currentWorkspaceLabel = currentWorkspaceLabel;
window.isInCurrentWorkspace = isInCurrentWorkspace;

function applyOwnerDisplay() {
    const workspace = getCookie('currentWorkspace') || '';
    const el = document.getElementById('userDisplay');
    if (!el) return;
    const label = workspace || 'Alapértelmezett';

    // A jelölő csak a HELYET adja (`.ws-switch`, a hub láblécében
    // `.is-inline`); a tartalmat innen építjük, osztályokból. Korábban ez egy
    // `style.cssText`-tel festett, pontozott aláhúzású szövegdarab volt —
    // abból nem derült ki, hogy kattintható, sem hogy MIT vált. (UI-16)
    el.classList.add('ws-switch');
    el.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'ws-switch-head';
    const caption = document.createElement('span');
    caption.className = 'ws-switch-caption';
    caption.textContent = 'Munkaterület';
    head.appendChild(caption);
    el.appendChild(head);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-switch-btn';
    btn.title = 'Munkaterület váltása';
    // A választó egy modális párbeszéd, nem menü — a segédtechnikának is ezt
    // mondjuk, és a teljes nevet felolvastatjuk (a doboz levághatja).
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-label', `Munkaterület: ${label} — váltás`);

    const mark = document.createElement('span');
    mark.className = 'ws-switch-mark';
    mark.setAttribute('aria-hidden', 'true');

    const name = document.createElement('span');
    name.className = 'ws-switch-name';
    name.textContent = label;

    // A chevron SVG `currentColor`-ral fest: prezentációs attribútum NEM vesz
    // fel `var()`-t, a currentColor viszont a témát is követi.
    const caret = document.createElement('span');
    caret.className = 'ws-switch-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none">'
        + '<path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" stroke-width="1.5" '
        + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';

    btn.append(mark, name, caret);
    btn.onclick = openWorkspacePicker;
    el.appendChild(btn);

    // ADR-008: role-badge a váltó mellett — a /api/whoami cache-ből.
    // Ha még nincs _userInfo (első render), később a fetch ráül.
    const role = (_userInfo && _userInfo.role) || '';
    if (role) {
        const badge = document.createElement('span');
        badge.className = 'role-badge' +
            (role === 'admin' ? ' is-admin' : role === 'viewer' ? ' is-viewer' : '');
        badge.textContent = role.toUpperCase();
        head.appendChild(badge);
    } else {
        // Ha még nincs _userInfo, indítsunk egy lazy fetch-et és re-render-eljünk.
        // A cache miatt csak egy fetch fut a lap életében — minden későbbi
        // applyOwnerDisplay() hívás már a kész role-t használja.
        ensureUserInfo().then(info => { if (info && info.role) applyOwnerDisplay(); });
    }
}

// ============================================================
// ADR-008 — /api/whoami integráció
// ============================================================
// A frontend ezekkel a helperekkel olvassa a role-t és a current workspace-t.
// _userInfo a `api/whoami` cache-elt válasza ({username, role, workspaces, current_workspace}).
let _userInfo = null;

async function ensureUserInfo() {
    if (_userInfo) return _userInfo;
    try {
        const r = await _origFetch('api/whoami');
        if (r.ok) _userInfo = await r.json();
    } catch (_) { /* offline / 401 — _userInfo marad null */ }
    return _userInfo;
}

function getRole() { return (_userInfo && _userInfo.role) || 'editor'; }
function getUserWorkspaces() { return (_userInfo && _userInfo.workspaces) || []; }
function getCurrentWorkspace() {
    // A cookie elsőbbséget élvez (a workspace-picker frissíti); fallback a whoami-ból.
    return getCookie('currentWorkspace') || (_userInfo && _userInfo.current_workspace) || '';
}
function isCurrentUserAdmin() { return getRole() === 'admin'; }

async function logoutUser() {
    try { await fetch(`${API_URL}/logout`, { method: 'POST' }); } catch(e) {}
    document.cookie = 'dub_session=; path=/; max-age=0';
    document.cookie = 'currentUser=; path=/; max-age=0';
    document.cookie = 'currentWorkspace=; path=/; max-age=0';
    document.cookie = 'dubOwner=; path=/; max-age=0';
    localStorage.removeItem('dubOwner');
    window.location.href = 'login.html';
}
window.logoutUser = logoutUser;

// ============================================================
// WORKSPACE PICKER
// ============================================================
async function openWorkspacePicker() {
    let data;
    try {
        const res = await _origFetch(`${API_URL}/workspaces`);
        if (!res.ok) return;
        data = await res.json();
    } catch(e) { return; }

    const { workspaces, active } = data;

    // Remove existing modal
    const existing = document.getElementById('_wsPicker');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = '_wsPicker';
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--scrim);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface-raised);border:1px solid var(--border-color);border-radius:var(--radius-xl);padding:28px;min-width:320px;max-width:420px;width:90%;box-shadow:var(--shadow-xl);font-family:inherit;color:var(--text-primary);';

    box.innerHTML = `
        <h3 class="ws-title">Munkaterület</h3>
        <div id="_wsListItems" class="ws-list"></div>
        <div class="ws-add">
            <input id="_wsNewName" type="text" placeholder="Új munkaterület neve..." maxlength="50">
            <button id="_wsAddBtn">+ Létrehozás</button>
        </div>
        <div id="_wsError" class="ws-error hidden"></div>
    `;

    const list = box.querySelector('#_wsListItems');
    workspaces.forEach((ws, idx) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;';

        const btn = document.createElement('button');
        const isActive = ws === active;
        btn.textContent = (idx === 0 ? ws + ' (alap)' : ws);
        btn.style.cssText = `flex:1;text-align:left;padding:10px 14px;border-radius:12px;cursor:pointer;font-size:0.95rem;font-family:inherit;font-weight:${isActive ? '600' : '400'};color:var(--text-primary);transition:all 0.2s;border:1px solid ${isActive ? 'var(--accent-color)' : 'var(--border-subtle)'};background:${isActive ? 'var(--accent-soft-hover)' : 'var(--tint-2)'};`;
        btn.onmouseenter = () => { if (!isActive) btn.style.background = 'var(--tint-4)'; };
        btn.onmouseleave = () => { if (!isActive) btn.style.background = 'var(--tint-2)'; };
        btn.onclick = () => { switchWorkspace(ws, workspaces); overlay.remove(); };
        row.appendChild(btn);

        if (idx > 0) {
            const del = document.createElement('button');
            del.textContent = '✕';
            del.title = 'Törlés';
            del.style.cssText = 'padding:8px 12px;border:1px solid rgba(239,68,68,0.3);background:var(--danger-soft);color:var(--danger-text);border-radius:var(--radius-md);cursor:pointer;font-size:0.85rem;transition:all 0.2s;';
            del.onmouseenter = () => { del.style.background = 'var(--danger-soft-hover, rgba(239,68,68,0.28))'; };
            del.onmouseleave = () => { del.style.background = 'var(--danger-soft)'; };
            del.onclick = () => deleteWorkspace(ws, overlay);
            row.appendChild(del);
        }

        list.appendChild(row);
    });

    box.querySelector('#_wsAddBtn').onmouseenter = (e) => { e.target.style.filter = 'brightness(1.15)'; };
    box.querySelector('#_wsAddBtn').onmouseleave = (e) => { e.target.style.filter = ''; };
    box.querySelector('#_wsAddBtn').onclick = () => addWorkspace(box, overlay, workspaces);
    box.querySelector('#_wsNewName').onkeydown = (e) => { if (e.key === 'Enter') addWorkspace(box, overlay, workspaces); };
    box.querySelector('#_wsNewName').onfocus = (e) => { e.target.style.borderColor = 'rgba(99,102,241,0.6)'; };
    box.querySelector('#_wsNewName').onblur = (e) => { e.target.style.borderColor = 'var(--border-color)'; };

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    box.querySelector('#_wsNewName').focus();
}

function switchWorkspace(wsName, workspaces) {
    // A tulajdonos nem változik (ADR-008) — csak az aktív címke; az újratöltés
    // után minden lista az új munkaterület szerint szűr. (TD-027)
    setCookie('currentWorkspace', wsName, 365);
    window.location.reload();
}

async function deleteWorkspace(wsName, overlay) {
    if (!confirm(`Biztosan törlöd a "${wsName}" munkaterületet?\nAz ehhez tartozó feladatok nem törlődnek.`)) return;
    try {
        const res = await fetch(`${API_URL}/workspaces/${encodeURIComponent(wsName)}`, { method: 'DELETE' });
        if (res.ok) {
            const currentWs = getCookie('currentWorkspace') || '';
            if (currentWs === wsName) {
                document.cookie = 'currentWorkspace=; path=/; max-age=0';
            }
            overlay.remove();
            window.location.reload();
        } else {
            const d = await res.json().catch(() => ({}));
            alert(d.detail || 'Törlési hiba');
        }
    } catch(e) { alert('Hálózati hiba'); }
}

async function addWorkspace(box, overlay, existingWorkspaces) {
    const input = box.querySelector('#_wsNewName');
    const errEl = box.querySelector('#_wsError');
    const name = input.value.trim();
    errEl.classList.add('hidden');
    if (!name) { errEl.textContent = 'Add meg a munkaterület nevét.'; errEl.classList.remove('hidden'); return; }
    try {
        const res = await fetch(`${API_URL}/workspaces`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name })
        });
        if (res.ok) {
            const allWorkspaces = [...existingWorkspaces, name];
            switchWorkspace(name, allWorkspaces);
            overlay.remove();
        } else {
            const d = await res.json().catch(() => ({}));
            errEl.textContent = d.detail || 'Hiba a létrehozáskor.';
            errEl.classList.remove('hidden');
        }
    } catch(e) { errEl.textContent = 'Hálózati hiba.'; errEl.classList.remove('hidden'); }
}

// ============================================================
// SERVER LOAD MONITOR
// ============================================================
function setBar(id, percent) {
    const bar = document.getElementById(id);
    if (!bar) return;
    bar.style.width = Math.min(percent, 100) + '%';
    bar.classList.remove('warn', 'danger');
    if (percent > 85) bar.classList.add('danger');
    else if (percent > 60) bar.classList.add('warn');
}

async function refreshMonitor() {
    try {
        const res = await fetch(`${API_URL}/health/stats`);
        if (!res.ok) return;
        const d = await res.json();
        setBar('monVram', d.gpu.available ? d.gpu.vram_percent : 0);
        const vramTxt = document.getElementById('monVramTxt');
        if (vramTxt) vramTxt.textContent = d.gpu.available ? d.gpu.vram_used_mb + 'M' : 'N/A';
        setBar('monRam', d.ram.used_percent);
        const ramTxt = document.getElementById('monRamTxt');
        if (ramTxt) ramTxt.textContent = d.ram.used_percent + '%';
        
        // Add CPU update
        if (d.cpu) {
            setBar('monCpu', d.cpu.used_percent);
            const cpuTxt = document.getElementById('monCpuTxt');
            if (cpuTxt) cpuTxt.textContent = d.cpu.used_percent + '%';
        }

        const monQueue = document.getElementById('monQueue');
        if (monQueue) monQueue.textContent = d.queue_length !== undefined ? d.queue_length : '–';
        const monRunning = document.getElementById('monRunning');
        if (monRunning) monRunning.textContent = d.running_jobs !== undefined ? d.running_jobs : '–';

        // Storage update
        const monStorageTxt = document.getElementById('monStorageTxt');
        if (monStorageTxt && d.storage) {
            let val = d.storage.deletable_mb;
            if (val > 1024) {
                monStorageTxt.textContent = (val / 1024).toFixed(1) + ' GB';
            } else {
                monStorageTxt.textContent = Math.round(val) + ' MB';
            }
        }
    } catch (e) { 
        console.error("Monitor refresh failed:", e);
    }
}

function startMonitor() {
    refreshMonitor();
    setInterval(refreshMonitor, 5000);
}

// ============================================================
// FILE DOWNLOAD HELPER
// ============================================================
function downloadFileFromJob(jobId, filename, downloadName) {
    const name = downloadName || filename;
    const url = `${API_URL}/download/${jobId}/${filename}?t=${Date.now()}&download_name=${encodeURIComponent(name)}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

// ============================================================
// INIT HELPER — called on DOMContentLoaded on every tool page
// ============================================================
async function initSharedSession(onReady) {
    // ── Version check & auto cache-bust ──────────────────────────
    try {
        const vResp = await _origFetch('api/version');
        if (vResp.ok) {
            const { version } = await vResp.json();
            const stored = localStorage.getItem('_appVersion');
            if (stored && stored !== version) {
                // New version deployed — clear caches and hard-reload
                localStorage.setItem('_appVersion', version);
                // Force-reload bypassing browser cache
                window.location.reload(true);
                return; // stop further init while reloading
            }
            localStorage.setItem('_appVersion', version);
            // Show version badge in sidebar if element exists
            const badge = document.getElementById('_versionBadge');
            if (badge) badge.textContent = 'v' + version;
        }
    } catch(e) { /* ignore — offline or server starting */ }
    // ─────────────────────────────────────────────────────────────

    const authUser = getCookie('currentUser');
    if (!authUser) {
        startMonitor();
        if (onReady) onReady(getOwner());
        return;
    }

    // Load workspaces from server and sync cookies
    try {
        const res = await _origFetch(`${API_URL}/workspaces`);
        if (res.ok) {
            const data = await res.json();
            const { workspaces, active } = data;
            // Sync currentWorkspace cookie
            const currentWs = getCookie('currentWorkspace') || '';
            const wsToUse = workspaces.includes(currentWs) ? currentWs : active;
            if (wsToUse !== currentWs) setCookie('currentWorkspace', wsToUse, 365);
            // A munkaterület-lista a lapok előzmény-szűréséhez (TD-027); ha
            // eddig nem volt ismert, a már kirajzolt előzménylista újraszűrődik.
            let hadList = false;
            try { hadList = !!localStorage.getItem(_WS_CACHE_KEY); } catch (_) { /* ignore */ }
            try { localStorage.setItem(_WS_CACHE_KEY, JSON.stringify(workspaces)); } catch (_) { /* ignore */ }
            if (!hadList && typeof window.renderHistory === 'function') {
                try { window.renderHistory(); } catch (_) { /* ignore */ }
            }
        }
    } catch(e) { /* offline — a tulajdonos a felhasználónév marad */ }

    // ADR-008: /api/whoami fetch (role + workspaces). A render előtt kell,
    // hogy a role-badge azonnal megjelenjen a userDisplay-en.
    await ensureUserInfo();
    // A tulajdonos a szerver szerinti (kanonikus) felhasználónév — a
    // belépéskor beírt név kis-nagybetűje eltérhet tőle. (TD-027)
    const owner = (_userInfo && _userInfo.username) || authUser;
    setCookie('dubOwner', owner, 365);
    try { localStorage.setItem('dubOwner', owner); } catch (_) { /* ignore */ }

    applyOwnerDisplay();
    startMonitor();
    if (onReady) onReady(getOwner());
}


window.setCookie = setCookie;
window.getCookie = getCookie;
window.getOwner = getOwner;
window.applyOwnerDisplay = applyOwnerDisplay;
window.openWorkspacePicker = openWorkspacePicker;
window.setBar = setBar;
window.refreshMonitor = refreshMonitor;
window.startMonitor = startMonitor;
window.initSharedSession = initSharedSession;
window.downloadFileFromJob = downloadFileFromJob;
window.ensureUserInfo = ensureUserInfo;
window.getRole = getRole;
window.getUserWorkspaces = getUserWorkspaces;
window.getCurrentWorkspace = getCurrentWorkspace;
window.isCurrentUserAdmin = isCurrentUserAdmin;

// =========================================================================
// Egységes felhasználói szótár + helper-ek — phase 1A
//
// Szándékosan külön szekcióban, hogy a régi függvényeket ne bántsa.
// Minden új oldal ezekre épít; a régi oldalakat fokozatosan migráljuk át.
// =========================================================================

// --- Terminológia szótár -------------------------------------------------
// Backend stage / status string → felhasználó-barát magyar szöveg.
// A backend API-ja angol kulcsokat ad vissza (pl. stage: "asr"), ezért itt
// lokalizáljuk. Új stage bevezetésekor bővítsd a térképet is, különben a
// felhasználó az angol kulcsot látja.
const DUB_STATUS_HU = {
    queued:       "Sorban áll",
    running:      "Fut",
    done:         "Kész",
    error:        "Hibás",
    cancelled:    "Megszakítva",
    canceled:     "Megszakítva",      // backend néha így írja
    interrupted:  "Megszakadt",       // szerver újraindult közben
    pending:      "Várakozik",
};

const DUB_STAGE_HU = {
    created:             "Létrehozva",
    uploaded:            "Feltöltve",
    queued:              "Sorban áll",
    queued_tts:          "Sorban áll (szinkron)",
    extract:             "Hang kivonása",
    isolate:             "Beszéd leválasztása",
    asr:                 "Szöveg felismerése",
    translate:           "Fordítás",
    refine:              "Szöveg finomítása",
    tts:                 "Beszéd szintézise",
    timefit:             "Időzítés",
    mix:                 "Hangkeverés",
    mux:                 "Videó összerakása",
    edit_ready:          "Szerkeszthető",
    done:                "Kész",
    error:               "Hibás",
    cancelled:           "Megszakítva",
    canceled:            "Megszakítva",
    interrupted:         "Megszakadt",
    // intro/outro
    intro_outro_analyze: "Elemzés",
    intro_outro_render:  "Render",
    // ppt replace
    ppt_analyze:         "PPT elemzés",
    ppt_segment:         "Szegmentálás",
    ppt_translate:       "PPT fordítás",
    ppt_reconstruct:     "PPT újraépítése",
    ppt_detect:          "Dia-felismerés",
    ppt_match:           "Dia-illesztés",
    ppt_composite:       "Videó összerakása",
    ppt_export:          "Export",
};

// Formázó: bármilyen status-objektumot (job_status vagy batch item) emberi
// nyelvű sorrá alakít. Fallback: ha nem ismerjük a kulcsot, visszaadjuk
// ahogy van, hogy ne tűnjön el információ.
function formatStageHu(stage) {
    if (!stage) return "";
    return DUB_STAGE_HU[stage] || stage;
}
function formatStatusHu(status) {
    if (!status) return "";
    return DUB_STATUS_HU[status] || status;
}

// --- Toast notifikáció ---------------------------------------------------
// Egységes visszajelzés: sikeres mentés, hiba, figyelmeztetés. CSS
// a style.css #toastContainer + .toast szekciójában.
function _ensureToastContainer() {
    let c = document.getElementById('toastContainer');
    if (!c) {
        c = document.createElement('div');
        c.id = 'toastContainer';
        document.body.appendChild(c);
    }
    return c;
}

function showToast(message, kind = 'info', ttlMs = 3500) {
    const c = _ensureToastContainer();
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('data-kind', kind);
    el.textContent = message;
    c.appendChild(el);
    setTimeout(() => {
        el.classList.add('fade-out');
        setTimeout(() => el.remove(), 220);
    }, ttlMs);
}

// --- Confirm modal -------------------------------------------------------
// Megerősítés destruktív akció előtt (törlés, reset, megszakítás). Promise-t
// ad vissza: resolve(true) ha a user OK-olja, resolve(false) ha Mégse.
// A CSS .confirm-modal + .confirm-modal-box osztályokra támaszkodik.
function showConfirm(options) {
    const {
        title = 'Biztos?',
        message = '',
        confirmText = 'Rendben',
        cancelText = 'Mégse',
        danger = false,
    } = options || {};

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'confirm-modal show';
        overlay.innerHTML = `
            <div class="confirm-modal-box">
                <h3></h3>
                <p></p>
                <div class="actions">
                    <button class="btn btn-secondary" data-role="cancel"></button>
                    <button class="btn ${danger ? 'btn-danger' : 'btn-accent'}" data-role="ok"></button>
                </div>
            </div>
        `;
        // Biztonsági okokból textContent-et használunk, nem innerHTML-t a
        // tartalomra — sose akarjunk user-controlled stringet HTML-ként
        // beszúrni.
        overlay.querySelector('h3').textContent = title;
        overlay.querySelector('p').textContent = message;
        overlay.querySelector('[data-role="cancel"]').textContent = cancelText;
        overlay.querySelector('[data-role="ok"]').textContent = confirmText;

        const cleanup = (result) => {
            overlay.remove();
            resolve(result);
        };
        overlay.querySelector('[data-role="ok"]').addEventListener('click', () => cleanup(true));
        overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => cleanup(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });

        document.body.appendChild(overlay);
        // ESC is zárja
        const onKey = (e) => {
            if (e.key === 'Escape') { cleanup(false); document.removeEventListener('keydown', onKey); }
            else if (e.key === 'Enter') { cleanup(true); document.removeEventListener('keydown', onKey); }
        };
        document.addEventListener('keydown', onKey);
    });
}

// --- Univerzális job poll -------------------------------------------------
// A korábbi oldalak mind saját pollJobStatus-t írtak (2–5 s közötti
// intervallummal, eltérő leállási feltételekkel). Egy helyre összevonva.
//
// Szerződés:
//   pollJobStatus({ jobId, endpoint, onUpdate, onTerminal, intervalMs })
//     endpoint:   GET URL amit hívunk (status JSON-t ad vissza).
//     onUpdate:   minden polling kör után meghívódik a status objektummal.
//     onTerminal: ha a stage terminálishoz ér (done / error / cancelled),
//                 meghívódik és a polling leáll.
//     intervalMs: alap 2000 ms (egységes érték — phase 1 döntés).
//
// Visszatér egy stop() callable-lel a hívónak, hogy manuálisan tudja
// leállítani (pl. új job indításakor).
const _DEFAULT_POLL_INTERVAL_MS = 2000;
const _TERMINAL_STAGES = new Set(['done', 'error', 'cancelled', 'canceled']);

function pollJobStatus({ jobId, endpoint, onUpdate, onTerminal, intervalMs = _DEFAULT_POLL_INTERVAL_MS }) {
    let stopped = false;
    let failStreak = 0;

    const tick = async () => {
        if (stopped) return;
        try {
            const res = await fetch(endpoint, { credentials: 'same-origin' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            failStreak = 0;
            if (typeof onUpdate === 'function') {
                try { onUpdate(data); } catch (e) { console.error('onUpdate threw:', e); }
            }
            const stage = data && data.stage;
            if (_TERMINAL_STAGES.has(stage)) {
                stopped = true;
                if (typeof onTerminal === 'function') {
                    try { onTerminal(data); } catch (e) { console.error('onTerminal threw:', e); }
                }
                return;
            }
        } catch (e) {
            // Hálózati hiba → exponenciális backoff 3× bukásig, aztán
            // visszatérünk a normál intervallumhoz. Sose állunk le a
            // polling-gal csendben — a régi kód ezt tette, és emiatt a
            // UI ragadt be "Feldolgozás..." felirattal restart után.
            failStreak += 1;
            if (failStreak === 1) {
                console.warn(`pollJobStatus(${jobId}): network hiccup, retrying…`);
            }
        }
        const delay = Math.min(intervalMs * Math.max(1, failStreak), 15000);
        setTimeout(tick, delay);
    };

    tick();
    return { stop: () => { stopped = true; } };
}

// --- Cancel / retry / delete gombok közös logikája -----------------------
async function cancelJob(jobId, endpoint = null) {
    const ok = await showConfirm({
        title: 'Feladat megszakítása',
        message: 'Biztos vagy benne, hogy megszakítod ezt a feladatot?',
        confirmText: 'Megszakítás',
        cancelText: 'Mégse',
        danger: true,
    });
    if (!ok) return false;
    const url = endpoint || `api/cancel/${jobId}`;
    try {
        const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('Megszakítás elküldve.', 'success');
        return true;
    } catch (e) {
        showToast('Nem sikerült a megszakítás: ' + e.message, 'error');
        return false;
    }
}

async function retryJob(jobId, endpoint = null) {
    const url = endpoint || `api/retry/${jobId}`;
    try {
        const res = await fetch(url, { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            throw new Error(txt || `HTTP ${res.status}`);
        }
        showToast('Újraindítás megkezdve.', 'success');
        return true;
    } catch (e) {
        showToast('Nem sikerült az újraindítás: ' + e.message, 'error');
        return false;
    }
}

async function deleteJob(jobId, endpoint = null) {
    const ok = await showConfirm({
        title: 'Feladat törlése',
        message: 'Ez véglegesen törli a feladatot és minden tartozó fájlt. Biztos?',
        confirmText: 'Törlés',
        cancelText: 'Mégse',
        danger: true,
    });
    if (!ok) return false;
    const url = endpoint || `api/job/${jobId}`;
    try {
        const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('Feladat törölve.', 'success');
        return true;
    } catch (e) {
        showToast('Nem sikerült a törlés: ' + e.message, 'error');
        return false;
    }
}

// --- Process banner render ------------------------------------------------
// A phase 1 egyik alaptézise: minden lap tetején legyen egy szembetűnő csík,
// ami mondja, melyik folyamatban és módban vagy. Ez védi a felhasználót
// attól, hogy egy kék gombra nyomva rossz folyamatot indítson.
//
// A lap egy <div id="processBanner"></div>-be tegye ezt a függvényt:
//   renderProcessBanner({ process: 'dub', mode: 'single', title: 'Szinkron' })
//
// Elérhető folyamatkulcsok (process): dub, subtitle, transcribe,
// intro_outro, ppt_replace, course. Mode: 'single' | 'batch'.
const _PROCESS_META = {
    dub: {
        icon: '🎬',
        title: 'Szinkron',
        subtitle: 'Videó szinkronizálása magyarról angolra',
        singleHref: 'dub.html',
        batchHref: 'batch.html',
    },
    subtitle: {
        icon: '💬',
        title: 'Felirat',
        subtitle: 'Magyar és angol feliratfájlok készítése',
        singleHref: 'subtitle.html',
        batchHref: 'subtitle_batch.html',
    },
    transcribe: {
        icon: '📝',
        title: 'Leirat',
        subtitle: 'Videóból leirat (magyar) készítése',
        singleHref: 'transcribe.html',
        batchHref: 'transcribe_batch.html',
    },
    intro_outro: {
        icon: '🎞️',
        title: 'Intro / Outro',
        subtitle: 'Nyitó- és záróképsorok hozzáadása',
        singleHref: 'intro_outro.html',
        batchHref: 'intro_outro_batch.html',
    },
    ppt_replace: {
        icon: '📊',
        title: 'PPT csere',
        subtitle: 'Videóban lévő PowerPoint diák lecserélése',
        singleHref: 'ppt_replace.html',
        batchHref: null,
    },
    ppt_narrate: {
        icon: '🗣️',
        title: 'PPT narráció',
        subtitle: 'Dia-jegyzetek felolvasása XTTS-szel, narrált videó',
        singleHref: 'ppt_narrate.html',
        batchHref: 'ppt_narrate_batch.html',
    },
    course: {
        icon: '📚',
        title: 'Kurzus',
        subtitle: 'Teljes kurzus feldolgozása ZIP-ből',
        singleHref: 'course.html',
        batchHref: null,
    },
    convert: {
        icon: '🔄',
        title: 'Fájlkonvertáló',
        subtitle: 'Helyi konvertálás — a fájl nem megy külső szolgáltatóhoz',
        singleHref: 'convert.html',
        batchHref: null,
    },
};

function renderProcessBanner({ process, mode = 'single', targetId = 'processBanner', titleOverride = null, subtitleOverride = null } = {}) {
    const meta = _PROCESS_META[process];
    const target = document.getElementById(targetId);
    if (!target || !meta) return;

    const title = titleOverride || meta.title;
    const subtitle = subtitleOverride || meta.subtitle;
    const modePillClass = mode === 'batch' ? 'batch-pill' : 'single-pill';
    const modeLabel = mode === 'batch' ? 'Batch' : 'Egy fájl';

    // A process-toggle csak akkor látszik, ha a másik mód is elérhető ennél
    // a folyamatnál. Pl. PPT cserénél nincs batch, ott a toggle elrejtődik.
    let toggleHtml = '';
    if (meta.singleHref && meta.batchHref) {
        const singleActive = mode === 'single' ? 'active' : '';
        const batchActive = mode === 'batch' ? 'active' : '';
        toggleHtml = `
            <nav class="process-toggle" aria-label="Mód váltás">
                <a href="${meta.singleHref}" class="${singleActive}">Egy fájl</a>
                <a href="${meta.batchHref}" class="${batchActive}">Batch</a>
            </nav>
        `;
    }

    target.className = 'process-banner';
    target.setAttribute('data-process', process);
    target.setAttribute('data-mode', mode);
    target.innerHTML = `
        <span class="process-icon" aria-hidden="true"></span>
        <span class="process-text">
            <span class="process-title"></span>
            <span class="process-subtitle"></span>
        </span>
        <span class="${modePillClass}"></span>
        ${toggleHtml}
    `;
    target.querySelector('.process-icon').textContent = meta.icon;
    target.querySelector('.process-title').textContent = title;
    target.querySelector('.process-subtitle').textContent = subtitle;
    target.querySelector(`.${modePillClass}`).textContent = modeLabel;
}

// --- Queue row render helper ---------------------------------------------
// A batch oldalak közepén lévő EGY lista egy-egy sorának közös render-je.
// Kötelező item mezők: id (batch_queue id), original_filename, status,
// job_status (opcionális: a dub status objektum ha már el van indítva).
//
// opts.actions — gombok a sor végén (pl. 'retry', 'cancel', 'delete').
//                A hívó oldal köti be az onclick-et a saját backend
//                endpointjára.
function renderJobQueueRow(item, opts = {}) {
    const status = (item.status || '').toLowerCase();
    const js = item.job_status || {};
    const stage = js.stage || '';
    const progress = typeof js.progress === 'number' ? js.progress : (status === 'done' ? 100 : 0);
    const detail = js.detail || '';
    const stageLabel = formatStageHu(stage || status);

    const row = document.createElement('div');
    row.className = 'job-queue-row';
    row.setAttribute('data-status', status);
    row.setAttribute('data-id', String(item.id));
    if (item.job_id) row.setAttribute('data-job-id', item.job_id);

    const escape = (s) => (s == null ? '' : String(s));
    // A fájlnév / detail / stage szövegeket textContent-tel írjuk, ne
    // innerHTML-lel, mert a tartalom részben felhasználói eredetű.
    row.innerHTML = `
        <span class="job-queue-status-pill" data-status="${status}"></span>
        <div>
            <div class="file-name"></div>
            <div class="sub-meta"></div>
        </div>
        <div class="progress-wrap">
            <div class="progress-bar-container">
                <div class="progress-bar" style="width: ${progress}%;"></div>
            </div>
            <span class="stage-text"></span>
        </div>
        <div class="actions"></div>
    `;
    row.querySelector('.job-queue-status-pill').textContent = formatStatusHu(status);
    row.querySelector('.file-name').textContent = escape(item.original_filename || item.id);
    row.querySelector('.sub-meta').textContent =
        (item.owner ? `@${item.owner}` : '') +
        (item.created_at ? (item.owner ? ' · ' : '') + _fmtCreated(item.created_at) : '');
    row.querySelector('.stage-text').textContent = detail || stageLabel || '';

    // Akciógombok (opcionális) — a hívó oldal adja meg, mert minden folyamat
    // más endpointra hív.
    const actionsWrap = row.querySelector('.actions');
    const actions = opts.actions || [];
    for (const a of actions) {
        if (a.showIf && !a.showIf(item)) continue;
        const b = document.createElement('button');
        b.className = 'btn ' + (a.className || 'btn-secondary');
        b.textContent = a.label;
        if (a.title) b.title = a.title;
        b.addEventListener('click', (e) => { e.stopPropagation(); a.onClick(item, row); });
        actionsWrap.appendChild(b);
    }

    if (typeof opts.onClick === 'function') {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => opts.onClick(item, row));
    }

    return row;
}

function _fmtCreated(raw) {
    if (!raw) return '';
    // SQLite: "YYYY-MM-DD HH:MM:SS" (UTC) — UTC-nek értelmezzük, aztán hu-HU-ban.
    const s = String(raw).includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
    try {
        return new Date(s).toLocaleString('hu-HU', {
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
        });
    } catch {
        return String(raw);
    }
}

// --- Export az új helperekre ----------------------------------------------
window.DUB_STATUS_HU = DUB_STATUS_HU;
window.DUB_STAGE_HU = DUB_STAGE_HU;
window.formatStageHu = formatStageHu;
window.formatStatusHu = formatStatusHu;
window.showToast = showToast;

// ──────────────────────────────────────────────────────────────────────────
// ETA (Estimated Time to Arrival) becslő egy futó job-ra. Lineáris becslés
// a `progress` (%) és az eltelt idő alapján — meglepően pontos a pipeline
// első felében, kissé bizonytalan az utolsó 10%-on (a TTS-render-stage nem
// teljesen lineáris). A `progress < 5%` esetén túl-bizonytalan; ekkor null-t
// adunk, és a render-kód nem mutat ETA-t. A két ISO-időbélyegre épít:
//   * createdAt — a job indítása (job_status.created_at, vagy a server-side
//     `created`). Stringként vagy Date-objektumként is elfogadja.
//   * progress  — 0..100, %.
// Visszatérés:
//   {
//     remainingMs: number,        // ms-ban a hátralévő idő
//     finishedAt:  Date,          // várható befejezés
//     label:       string,        // "Várhatóan kész: 14:32" magyar formátum
//     short:       string,        // "~7 perc" rövid kompakt forma
//   }
// vagy null, ha nem becsülhető (hiányzó input / túl korai).
function computeETA(createdAt, progress) {
    if (createdAt == null || progress == null) return null;
    const prog = Number(progress);
    if (!isFinite(prog) || prog <= 5 || prog >= 100) return null;
    let startMs;
    try {
        // ISO 8601 (UTC). Backend "YYYY-MM-DD HH:MM:SS" formátumot is ad,
        // ezt T-vel kell javítani.
        const raw = typeof createdAt === 'string'
            ? createdAt.replace(' ', 'T') + (createdAt.includes('Z') || createdAt.includes('+') ? '' : 'Z')
            : createdAt;
        startMs = new Date(raw).getTime();
        if (!isFinite(startMs)) return null;
    } catch (e) { return null; }
    const now = Date.now();
    const elapsedMs = now - startMs;
    if (elapsedMs < 1000) return null;  // < 1s eltelt → még nem becsülhető
    const remainingMs = Math.round(elapsedMs * (100 - prog) / prog);
    if (remainingMs < 0 || remainingMs > 24 * 3600 * 1000) return null;  // sanity-cap 24h
    const finishedAt = new Date(now + remainingMs);
    const label = 'Várhatóan kész: ' + finishedAt.toLocaleTimeString('hu-HU', {
        hour: '2-digit', minute: '2-digit',
    });
    // Rövid forma — < 1 perc, < 1 óra, > 1 óra
    let short;
    const minutes = Math.round(remainingMs / 60000);
    if (remainingMs < 60000) short = '~1 perc';
    else if (minutes < 60) short = '~' + minutes + ' perc';
    else short = '~' + Math.round(minutes / 60 * 10) / 10 + ' óra';
    return { remainingMs, finishedAt, label, short };
}

// Render-helper: ha a job RUNNING + van értelmes ETA, visszaadja az HTML-t a
// status-sorhoz. Egységes design minden batch + single oldalon.
function formatEtaHtml(createdAt, progress) {
    const eta = computeETA(createdAt, progress);
    if (!eta) return '';
    return '<span class="job-eta" title="' + eta.label + '">⏳ ' + eta.short + '</span>';
}

window.computeETA = computeETA;
window.formatEtaHtml = formatEtaHtml;

// ──────────────────────────────────────────────────────────────────────────
// Stuck-job heuristika a kliensen.
//
// A backend stuck_job_watchdog supervisor-task minden 60s-ben végigmegy a
// running-state-eken, és audit-logolja, ha az updated_at > 30 perc régi.
// A UI-on is jelezni akarjuk: render-time-ban megnézzük, hogy a status
// updated_at-je mennyire régi — ha túl-régi, "Beragadt" badge + stuck-ETA.
//
// Konfigurálható timeout (perc): a config.yaml jobs.stuck_timeout_minutes
// értéke kerül a backend-/api/whoami response-ba később. Most kliens-side
// fixen 30 perc; ha a backend később egy config-endpointon lefedi, csak
// itt csere kell.
//
// Returns:
//   { isStuck: bool, silenceMinutes: number, label?: string }
const STUCK_TIMEOUT_MIN = 30;
function detectStuck(updatedAt) {
    if (!updatedAt) return { isStuck: false, silenceMinutes: 0 };
    let lastMs;
    try {
        const raw = typeof updatedAt === 'string'
            ? updatedAt.replace(' ', 'T') + (updatedAt.includes('Z') || updatedAt.includes('+') ? '' : 'Z')
            : updatedAt;
        lastMs = new Date(raw).getTime();
        if (!isFinite(lastMs)) return { isStuck: false, silenceMinutes: 0 };
    } catch (e) { return { isStuck: false, silenceMinutes: 0 }; }
    const minutesQuiet = Math.floor((Date.now() - lastMs) / 60000);
    if (minutesQuiet < STUCK_TIMEOUT_MIN) {
        return { isStuck: false, silenceMinutes: minutesQuiet };
    }
    return {
        isStuck: true,
        silenceMinutes: minutesQuiet,
        label: '⚠️ Beragadt (' + minutesQuiet + ' perce nem frissül)',
    };
}

// Render-helper: a running job-okhoz egy "Beragadt" badge-et ad ha tényleg
// régen frissült. Visszaadja az HTML-t, vagy üres string-et.
function formatStuckHtml(updatedAt) {
    const stuck = detectStuck(updatedAt);
    if (!stuck.isStuck) return '';
    return '<span class="job-stuck" title="' + stuck.label + '">' + stuck.label + '</span>';
}

window.detectStuck = detectStuck;
window.formatStuckHtml = formatStuckHtml;

// ──────────────────────────────────────────────────────────────────────────
// Smooth list renderer — key-based DOM diff a `container.innerHTML = …`
// teljes-újra-építés helyett.
//
// Probléma: a 5sec-enkénti polling minden body-tartalmat újra-rajzolt
// (innerHTML = …) → a user fix csempéket lát eltűnni-megjelenni, villódzás
// érzéssel. A render-output gyakran AZONOS az előzőhöz képest — szóval a
// teljes újraépítés feleslegesen drága + zavaró.
//
// Új viselkedés:
//   * Minden lista-elem `data-list-key="<egyedi>"` attribútummal érkezik.
//     Ha ugyanaz a key megint látható: az adott DOM-wrapper a helyén marad,
//     csak a tartalom frissül in-place (NO unmount/remount, NO layout-jump).
//   * Új key: az új DOM-elem append-elődik egy `list-item-enter` class-szal,
//     a CSS-transition smooth fade+slide-in-ot ad (~300 ms).
//   * Eltűnt key: a régi DOM-elem fade-out class-t kap, és 320ms után törlődik.
//   * Sorrend-csere: ha a backend új sorrend-bel jött, `insertBefore`-rel
//     mozgatjuk a meglévő wrapper-eket — a browser CSS-transition-t indít a
//     `transform` változására, így a mozgás is smooth.
//
// Optimalizáció: a render-template a wrapper-en `data-render-sig="…"` hash-t
// rögzít a state-jeggyel (pl. `running:asr:45:0:0`). Ha az új és a régi sig
// megegyezik, NEM piszkáljuk az innerHTML-t — zero villogás, zero CPU.
//
// Használat:
//   renderListSmoothInto(document.getElementById('batchList'), [
//     { key: 'u-tok123', html: '<div class="batch-item" data-list-key="u-tok123" data-render-sig="upload:50">…</div>' },
//     { key: 'b-42',     html: '<div class="batch-item" data-list-key="b-42"     data-render-sig="running:asr:30">…</div>' },
//   ]);
function renderListSmoothInto(container, items) {
    if (!container) return;
    const existing = new Map();
    for (const child of Array.from(container.children)) {
        const k = child.getAttribute && child.getAttribute('data-list-key');
        if (k) existing.set(k, child);
    }
    const parser = document.createElement('div');
    const newOrder = [];

    for (const it of items) {
        if (!it || !it.key) continue;
        parser.innerHTML = it.html;
        const fresh = parser.firstElementChild;
        if (!fresh) continue;
        const existingEl = existing.get(it.key);
        if (existingEl) {
            const oldSig = existingEl.getAttribute('data-render-sig') || '';
            const newSig = fresh.getAttribute('data-render-sig') || '';
            if (oldSig && newSig && oldSig === newSig) {
                // Pontosan ugyanaz a render-state — semmit nem frissítünk.
                newOrder.push(existingEl);
                existing.delete(it.key);
                continue;
            }
            // In-place update: a wrapper-attribútumokat áttöltjük, az
            // innerHTML-t cseréljük. A wrapper-position fix → nincs layout-jump.
            _syncAttrs(fresh, existingEl);
            existingEl.innerHTML = fresh.innerHTML;
            newOrder.push(existingEl);
            existing.delete(it.key);
        } else {
            // Új elem fade-in animációval. requestAnimationFrame-mel kapcsoljuk
            // be az "enter-active" class-t, hogy a CSS-transition tényleg fusson.
            fresh.classList.add('list-item-enter');
            container.appendChild(fresh);
            requestAnimationFrame(() => {
                fresh.classList.add('list-item-enter-active');
                setTimeout(() => {
                    fresh.classList.remove('list-item-enter', 'list-item-enter-active');
                }, 360);
            });
            newOrder.push(fresh);
        }
    }

    // Eltűnt elemek: fade-out + delayed remove.
    for (const [, el] of existing) {
        el.classList.add('list-item-leave');
        setTimeout(() => {
            if (el.parentNode === container) container.removeChild(el);
        }, 340);
    }

    // Sorrend-helyreállítás — a container child-jeit a newOrder sorrendjébe
    // mozgatjuk insertBefore-rel. Csak akkor mozgat, ha tényleg más sorrend.
    for (let i = 0; i < newOrder.length; i++) {
        const target = newOrder[i];
        const currentAt = container.children[i];
        if (currentAt !== target) {
            container.insertBefore(target, currentAt || null);
        }
    }
}

function _syncAttrs(from, to) {
    // Az új outerHTML attribútumait áttöltjük a meglévő wrapper-be (class,
    // style, data-*). A removeAttribute-ot előbb futtatjuk a tobbi attribute-on,
    // hogy a régi class-ok (pl. status-running → status-done) tisztán cserélődjenek.
    const newAttrNames = new Set();
    for (const a of from.attributes) newAttrNames.add(a.name);
    for (const a of Array.from(to.attributes)) {
        if (!newAttrNames.has(a.name)) to.removeAttribute(a.name);
    }
    for (const a of from.attributes) {
        if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
    }
}

window.renderListSmoothInto = renderListSmoothInto;
window.showConfirm = showConfirm;
window.pollJobStatus = pollJobStatus;
window.cancelJob = cancelJob;
window.retryJob = retryJob;
window.deleteJob = deleteJob;
window.renderProcessBanner = renderProcessBanner;
window.renderJobQueueRow = renderJobQueueRow;
