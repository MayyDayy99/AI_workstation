// ppt_narrate.js — single-mode PPT narráció UI logika.
// Pattern követi az intro_outro.js step-indicator + polling mintáját, de
// PPTX bemenettel és XTTS voice-picker-rel.

const PN_API = 'api/ppt_narrate';
const POLL_MS = 2000;

const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));

let _pendingFile = null;
let _currentJobId = null;
let _currentJobName = null;
let _pollTimer = null;
let _sseStatus = null;
const _HISTORY_KEY = 'pptNarrateJobs';
let _historyDateFilter = 'all';

// ────────────── Logout + server monitor (közös pattern) ──────────────
async function logoutUser() {
    try { await fetch('api/logout', { method: 'POST' }); } catch (_) {}
    document.cookie = 'dub_session=; path=/; max-age=0';
    document.cookie = 'currentUser=; path=/; max-age=0';
    window.location.href = 'login.html';
}
window.logoutUser = logoutUser;

function setBar(id, pct) {
    const b = document.getElementById(id);
    if (!b) return;
    b.style.width = Math.min(pct, 100) + '%';
    b.classList.remove('warn', 'danger');
    if (pct > 85) b.classList.add('danger');
    else if (pct > 60) b.classList.add('warn');
}

async function refreshMonitor() {
    try {
        const r = await fetch('api/health/stats');
        if (!r.ok) return;
        const d = await r.json();
        if (d.cpu) { setBar('monCpu', d.cpu.used_percent); document.getElementById('monCpuTxt').textContent = Math.round(d.cpu.used_percent) + '%'; }
        if (d.gpu && d.gpu.available) {
            setBar('monVram', d.gpu.vram_percent);
            document.getElementById('monVramTxt').textContent = d.gpu.vram_used_mb + ' / ' + d.gpu.vram_total_mb + ' MB';
        } else {
            setBar('monVram', 0);
            document.getElementById('monVramTxt').textContent = 'N/A';
        }
        if (d.ram) {
            setBar('monRam', d.ram.used_percent);
            document.getElementById('monRamTxt').textContent = d.ram.used_mb ? (d.ram.used_mb + ' / ' + d.ram.total_mb + ' MB') : (d.ram.used_percent + '%');
        }
        document.getElementById('monQueue').textContent = d.queue_length;
        document.getElementById('monRunning').textContent = d.running_jobs;
    } catch (_) { /* silent */ }
}

// ────────────── Step-indicator ──────────────
function setActiveStep(n) {
    for (let i = 1; i <= 4; i++) {
        const el = document.getElementById('step' + i);
        if (!el) continue;
        el.classList.remove('active', 'done');
        if (i < n) el.classList.add('done');
        if (i === n) el.classList.add('active');
    }
}

function showSection(id) {
    ['uploadSection', 'configSection', 'statusSection', 'downloadSection', 'errorSection']
        .forEach(s => document.getElementById(s).classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

// ────────────── Step 1: PPTX upload ──────────────
function _initDropZone() {
    const dz = document.getElementById('pptDropZone');
    const input = document.getElementById('pptInput');
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e =>
        dz.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); }, false));
    ['dragenter', 'dragover'].forEach(e =>
        dz.addEventListener(e, () => { dz.style.borderColor = '#7c3aed'; dz.style.background = 'rgba(124,58,237,0.1)'; }, false));
    ['dragleave', 'drop'].forEach(e =>
        dz.addEventListener(e, () => { dz.style.borderColor = ''; dz.style.background = ''; }, false));
    dz.addEventListener('drop', e => { handleSelectedFile(e.dataTransfer.files[0]); }, false);
    input.addEventListener('change', e => { handleSelectedFile(e.target.files[0]); }, false);
    document.getElementById('nextBtn').addEventListener('click', proceedToConfig);
}

function handleSelectedFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pptx')) {
        alert('Csak .pptx fájl tölthető fel.');
        return;
    }
    _pendingFile = file;
    const lbl = document.getElementById('fileLabel');
    lbl.classList.remove('hidden');
    lbl.textContent = '📄 ' + file.name + ' (' + (file.size / 1024 / 1024).toFixed(2) + ' MB)';
    document.getElementById('nextBtn').disabled = false;
}

async function proceedToConfig() {
    if (!_pendingFile) return;
    // Dedup: feltöltés előtt azonos-fájl ellenőrzés (fail-open).
    if (window.DedupUpload && (await DedupUpload.guard(_pendingFile)) === 'skip') {
        return;
    }
    const btn = document.getElementById('nextBtn');
    btn.disabled = true;
    btn.textContent = 'Feltöltés…';
    try {
        const fd = new FormData();
        fd.append('file', _pendingFile);
        const r = await fetch(`${PN_API}/upload`, { method: 'POST', body: fd });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        const data = await r.json();
        _currentJobId = data.job_id;
        _currentJobName = _pendingFile.name;
        addJobToHistory(_currentJobId, _currentJobName);
        await VoicePicker.refresh('voiceSelect');
        setActiveStep(2);
        showSection('configSection');
    } catch (e) {
        alert('Feltöltési hiba: ' + (e.message || e));
        btn.disabled = false;
        btn.textContent = 'Tovább a beállításokhoz →';
    }
}
window.proceedToConfig = proceedToConfig;

// ────────────── Step 2: Process ──────────────
async function startProcess() {
    if (!_currentJobId) return;
    const voiceKey = document.getElementById('voiceSelect').value;
    if (!voiceKey) { alert('Válassz hangmintát.'); return; }
    const language = document.getElementById('languageSelect').value || 'hu';
    const emptyDur = parseFloat(document.getElementById('emptyDurInput').value || '3.0');

    const startBtn = document.getElementById('startBtn');
    startBtn.disabled = true;
    startBtn.textContent = 'Indítás…';
    try {
        const r = await fetch(`${PN_API}/process/${encodeURIComponent(_currentJobId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ language, voice_key: voiceKey, empty_slide_dur: emptyDur }),
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        setActiveStep(3);
        showSection('statusSection');
        startPolling();
    } catch (e) {
        alert('Indítási hiba: ' + (e.message || e));
        startBtn.disabled = false;
        startBtn.textContent = 'Feldolgozás indítása →';
    }
}
window.startProcess = startProcess;

// ────────────── Step 3: Status polling ──────────────
function startPolling() {
    stopPolling();
    // Safety net polling
    _pollTimer = setInterval(pollOnce, POLL_MS);
    pollOnce();
    // Try SSE
    try {
        if (!_currentJobId) return;
        _sseStatus = new EventSource(`${PN_API}/status/${encodeURIComponent(_currentJobId)}/stream`);
        _sseStatus.addEventListener('status', ev => {
            if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
            try {
                const st = JSON.parse(ev.data);
                renderStatus(st);
                if (st.stage === 'done') {
                    stopPolling();
                    setActiveStep(4);
                    const link = document.getElementById('downloadLink');
                    link.href = `${PN_API}/download/${encodeURIComponent(_currentJobId)}`;
                    showSection('downloadSection');
                } else if (st.stage === 'error') {
                    stopPolling();
                    showError(st.error_detail || st.detail || 'Ismeretlen hiba');
                } else if (st.stage === 'cancelled' || st.stage === 'canceled') {
                    stopPolling();
                    showError(st.detail || 'Felhasználó leállította');
                }
            } catch (e) { console.warn('SSE status parse:', e); }
        });
        _sseStatus.onerror = () => {
            if (_sseStatus && _sseStatus.readyState === EventSource.CLOSED) {
                _sseStatus = null;
                if (!_pollTimer) _pollTimer = setInterval(pollOnce, POLL_MS);
            }
        };
    } catch (e) { console.warn('SSE status init failed:', e); }
}

function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_sseStatus) { try { _sseStatus.close(); } catch(_) {} _sseStatus = null; }
}

async function pollOnce() {
    if (!_currentJobId) return;
    try {
        // credentials: 'same-origin' kötelező — különben a backend
        // _ensure_job_view 401-et ad, a poll csendben elhal, és a sidebar
        // job-click sosem kapcsol át a megfelelő szekcióra.
        const r = await fetch(`${PN_API}/status/${encodeURIComponent(_currentJobId)}`, {
            credentials: 'same-origin',
        });
        if (!r.ok) {
            if (r.status === 404) {
                stopPolling();
                showError('A job eltűnt (404). Lehet, hogy törölve lett.');
            }
            return;
        }
        const st = await r.json();
        renderStatus(st);
        if (st.stage === 'done') {
            stopPolling();
            setActiveStep(4);
            const link = document.getElementById('downloadLink');
            link.href = `${PN_API}/download/${encodeURIComponent(_currentJobId)}`;
            showSection('downloadSection');
        } else if (st.stage === 'error') {
            stopPolling();
            showError(st.error_detail || st.detail || 'Ismeretlen hiba');
        } else if (st.stage === 'cancelled' || st.stage === 'canceled') {
            stopPolling();
            showError(st.detail || 'Felhasználó leállította');
        }
    } catch (e) {
        // Network hiccup — keep polling.
    }
}

function renderStatus(st) {
    const stage = (st.stage || '').toLowerCase();
    const badge = document.getElementById('stageBadge');
    badge.className = 'pn-stage-badge pn-stage-' + stage;
    badge.textContent = stage;
    const pct = Math.max(0, Math.min(100, parseInt(st.progress, 10) || 0));
    // ETA inline a detail-szöveg után, ha futó stage.
    const etaHtml = (typeof formatEtaHtml === 'function')
        ? formatEtaHtml(st.created_at, pct)
        : '';
    const detailEl = document.getElementById('progressDetail');
    detailEl.innerHTML = (st.detail || '') + etaHtml;
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressPct').textContent = pct + '%';
}

function showError(msg) {
    document.getElementById('errorDetail').textContent = msg;
    showSection('errorSection');
}

async function cancelCurrentJob() {
    if (!_currentJobId) return;
    if (!confirm('Biztos leállítod?')) return;
    stopPolling();
    try {
        await fetch(`${PN_API}/job/${encodeURIComponent(_currentJobId)}`, { method: 'DELETE' });
    } catch (_) {}
    resetToUpload();
}
window.cancelCurrentJob = cancelCurrentJob;

async function retryCurrentJob() {
    if (!_currentJobId) return;
    try {
        const r = await fetch(`${PN_API}/retry/${encodeURIComponent(_currentJobId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        setActiveStep(3);
        showSection('statusSection');
        startPolling();
    } catch (e) {
        alert('Újraindítás sikertelen: ' + (e.message || e));
    }
}
window.retryCurrentJob = retryCurrentJob;

function resetToUpload() {
    stopPolling();
    _pendingFile = null;
    _currentJobId = null;
    document.getElementById('pptInput').value = '';
    document.getElementById('fileLabel').classList.add('hidden');
    document.getElementById('fileLabel').textContent = '';
    document.getElementById('nextBtn').disabled = true;
    document.getElementById('nextBtn').textContent = 'Tovább a beállításokhoz →';
    document.getElementById('startBtn').disabled = false;
    document.getElementById('startBtn').textContent = 'Feldolgozás indítása →';
    setActiveStep(1);
    showSection('uploadSection');
}
window.resetToUpload = resetToUpload;

// ────────────── Boot ──────────────
document.addEventListener('DOMContentLoaded', () => {
    if (typeof applyOwnerDisplay === 'function') applyOwnerDisplay();
    _initDropZone();
    refreshMonitor();
    setInterval(refreshMonitor, 5000);
    // Voice library frissítés ha valaki feltölt
    document.addEventListener('voiceLibraryChanged', () => {
        const cur = document.getElementById('voiceSelect').value;
        VoicePicker.refresh('voiceSelect', cur);
    });
    renderHistory();
});

// ────────────── History sidebar (közös pattern intro_outro.js-szel) ──────────────
// localStorage kulcs: pptNarrateJobs (külön a többi modul history-jától).
// Mindegyik elem: { id, name, date }. A stage-et server-side enrich-eljük.
function addJobToHistory(jobId, fileName) {
    if (!jobId) return;
    try {
        const hist = JSON.parse(localStorage.getItem(_HISTORY_KEY) || '[]');
        // Idempotens: ne duplikáljon ha már bent van.
        if (!hist.find(h => h.id === jobId)) {
            hist.unshift({
                id: jobId,
                name: fileName || 'narration',
                date: new Date().toISOString(),
            });
            // Max 50 elem, hogy a localStorage ne nőjjön kontrollálatlanul.
            localStorage.setItem(_HISTORY_KEY, JSON.stringify(hist.slice(0, 50)));
        }
        renderHistory();
    } catch (_) { /* fail-open */ }
}

function setHistoryDateFilter(value) {
    _historyDateFilter = value;
    document.querySelectorAll('#historyDatePills .date-pill').forEach(p => p.classList.remove('active'));
    const map = { all: 'hpAll', today: 'hpToday', yesterday: 'hpYest' };
    if (map[value]) {
        const el = document.getElementById(map[value]);
        if (el) el.classList.add('active');
    }
    renderHistory();
}
window.setHistoryDateFilter = setHistoryDateFilter;

function _matchHistoryDate(isoDate) {
    if (_historyDateFilter === 'all') return true;
    if (!isoDate) return false;
    const day = isoDate.slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (_historyDateFilter === 'today') return day === today;
    if (_historyDateFilter === 'yesterday') return day === yest;
    return true;
}

function _fmtJobDate(isoDate) {
    if (!isoDate) return '';
    try {
        const d = new Date(isoDate);
        return d.toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return ''; }
}

async function renderHistory() {
    const container = document.getElementById('jobHistory');
    if (!container) return;
    const history = JSON.parse(localStorage.getItem(_HISTORY_KEY) || '[]');
    const filtered = history.filter(j => _matchHistoryDate(j.date));
    if (filtered.length === 0) {
        const msg = _historyDateFilter === 'all' ? 'Nincs korábbi feladat'
            : (_historyDateFilter === 'today' ? 'Ma még nincs feltöltés.' : 'Tegnap nincs feltöltés.');
        container.innerHTML = `<div style="padding:20px;color:#555;font-size:0.85rem;">${msg}</div>`;
        return;
    }
    _renderHistoryItems(container, filtered);
    const enriched = await _enrichHistoryWithStage(filtered);
    _renderHistoryItems(container, enriched);
}

function _renderHistoryItems(container, items) {
    container.innerHTML = items.map(job => {
        // Build the per-row style as ONE attribute — a previous version
        // emitted two `style="..."` attributes (stage-border + flex-layout)
        // which the browser silently merged to only the first, dropping the
        // flex-direction:column and leaving the row in CSS-default `row`.
        const stageBorder = job._stage === 'error'
            ? 'border-left:3px solid #ef4444;'
            : (job._stage === 'done' ? 'border-left:3px solid #10b981;' : '');
        const rowStyle = `display:flex;flex-direction:column;gap:6px;align-items:stretch;${stageBorder}`;
        const retryBtn = (job._stage === 'error' || job._stage === 'done')
            ? `<button onclick="retryJobFromHistory('${job.id}', event)" class="btn btn-secondary" style="padding:4px 8px;font-size:0.78rem;border-radius:4px;" title="Újra feldolgozás">🔄</button>`
            : '';
        const previewBtn = (job._stage === 'done')
            ? `<button onclick="openPreview('${job.id}', event)" class="btn btn-secondary" style="padding:4px 8px;font-size:0.78rem;border-radius:4px;flex:1;" title="Előnézet">👁 Előnézet</button>`
            : '';
        const deleteBtn = `<button onclick="deleteJobFromHistory('${job.id}', event)" class="btn btn-secondary" style="padding:4px 8px;font-size:0.8rem;border-radius:4px;" title="Törlés">❌</button>`;
        const thumb = (job._stage === 'done')
            ? `<img class="ppt-thumb" loading="lazy" src="${PN_API}/preview/${encodeURIComponent(job.id)}/thumbnail.jpg" alt="" onerror="this.style.display='none'">`
            : '';
        const isActive = job.id === _currentJobId ? ' active' : '';
        // 3-row layout (user request):
        //   row 1 — name, full row width
        //   row 2 — thumbnail (left) + date (right)
        //   row 3 — Preview button (flex-1) + Retry + Delete, all one line
        return `
        <div class="job-item${isActive}" onclick="loadJobFromHistory('${job.id}', ${esc(JSON.stringify(job.name))})" style="${rowStyle}">
            <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.95rem;">${esc(job.name)}</div>
            <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                ${thumb}
                <div class="job-date" style="flex:1;min-width:0;">🕐 ${_fmtJobDate(job.date)}</div>
            </div>
            <div style="display:flex;gap:4px;align-items:center;">
                ${previewBtn}
                ${retryBtn}
                ${deleteBtn}
            </div>
        </div>`;
    }).join('');
}

async function _enrichHistoryWithStage(history) {
    return await Promise.all(history.map(async job => {
        try {
            const r = await fetch(`${PN_API}/status/${encodeURIComponent(job.id)}`, { credentials: 'same-origin' });
            if (r.ok) {
                const s = await r.json();
                job._stage = s.stage;
            }
        } catch (_) { /* silent */ }
        return job;
    }));
}

async function loadJobFromHistory(jobId, name) {
    if (!jobId) return;
    // Új job nyit → előző job poll-jait/SSE-jét leállítjuk, különben
    // race-elnek a kettő.
    stopPolling();
    _currentJobId = jobId;
    _currentJobName = name || 'narration';
    renderHistory();

    // EGYSZERES status-fetch a kattintás pillanatában: ennek alapján
    // döntjük el, MELYIK szekció jelenjen meg.
    //   done       → letöltés-szekció
    //   error/cancelled → error-szekció
    //   bármi más  → status-szekció + polling újraindít
    // Korábban vakon statusSection-t mutattunk és a polling-ra bíztuk a
    // szekció-váltást — DE a polling-fetch credentials nélkül 401-et
    // kapott, csendben elhalt, és a felhasználó örökre üres status-
    // szekciót látott.
    try {
        const r = await fetch(`${PN_API}/status/${encodeURIComponent(jobId)}`, {
            credentials: 'same-origin',
        });
        if (r.ok) {
            const st = await r.json();
            renderStatus(st);
            const stage = (st.stage || '').toLowerCase();
            if (stage === 'done') {
                setActiveStep(4);
                const link = document.getElementById('downloadLink');
                if (link) link.href = `${PN_API}/download/${encodeURIComponent(jobId)}`;
                showSection('downloadSection');
                return;
            }
            if (stage === 'error') {
                showError(st.error_detail || st.detail || 'Ismeretlen hiba');
                return;
            }
            if (stage === 'cancelled' || stage === 'canceled') {
                showError(st.detail || 'Felhasználó leállította');
                return;
            }
            // Még fut / queued / processing → status + polling.
            setActiveStep(3);
            showSection('statusSection');
            startPolling();
            return;
        }
        if (r.status === 404) {
            showError('A job eltűnt a szerverről (404).');
            return;
        }
        if (r.status === 401 || r.status === 403) {
            showError('Nincs jogosultság ehhez a job-hoz.');
            return;
        }
        showError(`Status lekérdezés sikertelen: HTTP ${r.status}`);
    } catch (e) {
        // Hálózati hiba — fallback a régi viselkedésre, hogy ne legyen dead-end.
        setActiveStep(3);
        showSection('statusSection');
        startPolling();
    }
}
window.loadJobFromHistory = loadJobFromHistory;

async function deleteJobFromHistory(jobId, evt) {
    if (evt) { evt.stopPropagation(); evt.preventDefault(); }
    if (!confirm('Törlöd a feladatot a listából (a szervert is)?')) return;
    // credentials: 'same-origin' — a session-cookie nélkül a backend 401-et
    // dobott és a job csak a localStorage-ból tűnt el, a szerveren megmaradt.
    let serverOk = true;
    try {
        const r = await fetch(`${PN_API}/job/${encodeURIComponent(jobId)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        if (!r.ok) {
            serverOk = false;
            const b = await r.json().catch(() => ({}));
            alert(`Szerver-oldali törlés sikertelen (${r.status}): ${b.detail || ''}\nA bejegyzés a saját listából eltávolítva, de a job_dir a szerveren megmaradt.`);
        }
    } catch (e) {
        serverOk = false;
        alert('Hálózati hiba a törlésnél: ' + (e.message || e));
    }
    const hist = JSON.parse(localStorage.getItem(_HISTORY_KEY) || '[]');
    localStorage.setItem(_HISTORY_KEY, JSON.stringify(hist.filter(j => j.id !== jobId)));
    if (_currentJobId === jobId) { _currentJobId = null; _currentJobName = null; }
    renderHistory();
}
window.deleteJobFromHistory = deleteJobFromHistory;

async function retryJobFromHistory(jobId, evt) {
    if (evt) { evt.stopPropagation(); evt.preventDefault(); }
    if (!jobId) return;
    _currentJobId = jobId;
    try {
        const r = await fetch(`${PN_API}/retry/${encodeURIComponent(jobId)}`, { method: 'POST' });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            alert('Retry hiba: ' + (b.detail || ('HTTP ' + r.status)));
            return;
        }
        setActiveStep(3);
        showSection('statusSection');
        startPolling();
        renderHistory();
    } catch (e) {
        alert('Retry hiba: ' + (e.message || e));
    }
}
window.retryJobFromHistory = retryJobFromHistory;

// ────────────── F3: Preview modal ──────────────
// Modal lifecycle: openPreview(jobId) shows it; closePreview() hides it.
// Esc key + backdrop click also close. Slide list lazy-fetches on toggle.
let _previewJobId = null;
let _previewSlidesLoaded = false;

function openPreview(jobId, evt) {
    if (evt) { try { evt.stopPropagation(); evt.preventDefault(); } catch (_) {} }
    if (!jobId) return;
    _previewJobId = jobId;
    _previewSlidesLoaded = false;

    const modal = document.getElementById('previewModal');
    if (!modal) return;
    const video = document.getElementById('previewVideo');
    const dlBtn = document.getElementById('previewDownloadBtn');
    const slideList = document.getElementById('previewSlideList');
    const slideBody = document.getElementById('previewSlideListBody');

    if (video) {
        video.pause();
        video.src = `${PN_API}/preview/${encodeURIComponent(jobId)}/video.mp4`;
        video.poster = `${PN_API}/preview/${encodeURIComponent(jobId)}/thumbnail.jpg`;
        // Error handler: ha az output.mp4 hiányzik / a regen folyamatban van /
        // a job nem 'done' státuszú, a video element némán fekete dobozt mutat.
        // Replikáljuk az új error-banner-t a video alatt, hogy a user lássa miért.
        video.onerror = function () {
            const banner = document.getElementById('previewErrorBanner');
            if (banner) {
                banner.textContent = 'Az előnézet jelenleg nem érhető el (lehet, hogy a videó éppen újragenerálódik, vagy törölve lett).';
                banner.classList.remove('hidden');
            }
        };
        const banner = document.getElementById('previewErrorBanner');
        if (banner) banner.classList.add('hidden');
        video.load();
    }
    if (dlBtn) {
        dlBtn.href = `${PN_API}/download/${encodeURIComponent(jobId)}`;
    }
    if (slideList) slideList.classList.add('hidden');
    if (slideBody) slideBody.innerHTML = 'Betöltés…';

    loadPreviewChapters(jobId);

    modal.classList.remove('hidden');
    document.addEventListener('keydown', _previewEscHandler);
}
window.openPreview = openPreview;

// ── SYNC-PPT-CHAP-2: kattintható fejezetlista az előnézet alatt ──────────
// A böngésző natív <video> lejátszója NEM jeleníti meg az MP4-be ágyazott
// fejezeteket (az csak VLC/PotPlayer/mpv funkció) — ezért a backend
// /preview/{id}/chapters endpointjából rajzolunk saját, kattintható listát.
function _fmtChapTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = (h ? String(m).padStart(2, '0') : String(m));
    return (h ? `${h}:${mm}` : mm) + ':' + String(s).padStart(2, '0');
}

async function loadPreviewChapters(jobId) {
    const wrap = document.getElementById('previewChapters');
    if (!wrap) return;
    wrap.innerHTML = '';
    wrap.classList.add('hidden');
    wrap.style.display = '';
    const video = document.getElementById('previewVideo');
    if (video) video.ontimeupdate = null;
    let chs = [];
    try {
        const r = await fetch(`${PN_API}/preview/${encodeURIComponent(jobId)}/chapters`);
        if (!r.ok) return;
        chs = await r.json();
    } catch (_) { return; }
    // A modal közben bezárulhatott vagy másik jobra válthatott — ne rajzoljunk.
    if (_previewJobId !== jobId) return;
    if (!Array.isArray(chs) || chs.length < 2) return; // 1 fejezet = nincs értelme
    const btns = [];
    chs.forEach((ch, i) => {
        const start = Number(ch.start) || 0;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary';
        btn.style.cssText = 'padding:3px 8px; font-size:0.75rem; border-radius:4px;';
        btn.textContent = `${_fmtChapTime(start)} ${ch.title || ('' + (i + 1) + '. dia')}`;
        btn.onclick = () => {
            const v = document.getElementById('previewVideo');
            if (v) { v.currentTime = start + 0.01; v.play().catch(() => {}); }
        };
        btn._chapStart = start;
        btns.push(btn);
        wrap.appendChild(btn);
    });
    wrap.classList.remove('hidden');
    wrap.style.display = 'flex';
    if (video) {
        video.ontimeupdate = function () {
            const t = video.currentTime || 0;
            let active = -1;
            for (let i = 0; i < btns.length; i++) {
                if (t >= btns[i]._chapStart) active = i;
            }
            btns.forEach((b, i) => {
                b.style.outline = (i === active) ? '2px solid #8b5cf6' : '';
            });
        };
    }
}

function closePreview() {
    const modal = document.getElementById('previewModal');
    if (!modal) return;
    const video = document.getElementById('previewVideo');
    if (video) {
        try { video.pause(); } catch (_) {}
        video.ontimeupdate = null;
        video.removeAttribute('src');
        try { video.load(); } catch (_) {}
    }
    const chWrap = document.getElementById('previewChapters');
    if (chWrap) { chWrap.innerHTML = ''; chWrap.classList.add('hidden'); chWrap.style.display = ''; }
    modal.classList.add('hidden');
    _previewJobId = null;
    _previewSlidesLoaded = false;
    document.removeEventListener('keydown', _previewEscHandler);
}
window.closePreview = closePreview;

function _previewEscHandler(e) {
    if (e.key === 'Escape' || e.keyCode === 27) closePreview();
}

function _previewBackdropClick(e) {
    // Only close if click landed on overlay itself, not inner box (which
    // already stops propagation via inline onclick).
    if (e && e.target && e.target.id === 'previewModal') closePreview();
}
window._previewBackdropClick = _previewBackdropClick;

async function togglePreviewSlideList() {
    const slideList = document.getElementById('previewSlideList');
    if (!slideList) return;
    const wasHidden = slideList.classList.contains('hidden');
    slideList.classList.toggle('hidden');
    if (wasHidden && !_previewSlidesLoaded) {
        await _loadPreviewSlides();
    }
}
window.togglePreviewSlideList = togglePreviewSlideList;

async function _loadPreviewSlides() {
    if (!_previewJobId) return;
    const body = document.getElementById('previewSlideListBody');
    if (!body) return;
    body.innerHTML = '<div style="color:#9ca3af;font-size:0.85rem;">Betöltés…</div>';
    try {
        const r = await fetch(`${PN_API}/slides/${encodeURIComponent(_previewJobId)}`, {
            credentials: 'same-origin',
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        const data = await r.json();
        const slides = Array.isArray(data) ? data : (data.slides || []);
        if (!slides.length) {
            body.innerHTML = '<div style="color:#9ca3af;font-size:0.85rem;">Nincs dia.</div>';
            _previewSlidesLoaded = true;
            return;
        }
        body.innerHTML = slides.map(s => {
            const n = (s.slide != null) ? s.slide : (s.index != null ? s.index : s.number);
            const notesRaw = (s.notes || s.text || '').toString();
            const notes = notesRaw.length > 80 ? (notesRaw.slice(0, 80) + '…') : notesRaw;
            const safeNotes = notes
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
            return `
            <div class="pn-slide-row" data-slide="${n}">
                <div class="pn-slide-num">#${n}</div>
                <div class="pn-slide-notes" title="${safeNotes}">${safeNotes || '<em style="color:#6b7280;">(üres)</em>'}</div>
                <div class="pn-slide-status" id="pnSlideStatus-${n}"></div>
                <button class="btn btn-secondary" style="padding:4px 8px;font-size:0.78rem;border-radius:4px;" onclick="regeneratePreviewSlide(${n})" title="Újragenerálás">🔁 Újragenerál</button>
            </div>`;
        }).join('');
        _previewSlidesLoaded = true;
    } catch (e) {
        body.innerHTML = `<div style="color:#ef4444;font-size:0.85rem;">Slide-lista hiba: ${(e.message || e)}</div>`;
    }
}

// Per-slide in-flight guard: ha a user kétszer kattint, a 2. POST nem indul.
// A backend regenerate-slide kitörli a slide WAV-ot + output.mp4-et, így a
// race kerekes kettős futás file-conflikust csinál a compose lépésnél.
const _regenInFlight = new Set();

async function regeneratePreviewSlide(slideNum) {
    if (!_previewJobId) return;
    const guardKey = _previewJobId + ':' + slideNum;
    if (_regenInFlight.has(guardKey)) {
        // Csendben no-op: a folyamatban lévő ugyanaz, várjuk meg
        return;
    }
    _regenInFlight.add(guardKey);
    const statusEl = document.getElementById('pnSlideStatus-' + slideNum);
    if (statusEl) statusEl.textContent = 'Folyamatban… (1-3 perc)';
    try {
        const r = await fetch(`${PN_API}/regenerate-slide/${encodeURIComponent(_previewJobId)}`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slide: slideNum }),
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        if (statusEl) statusEl.textContent = '✅ Kész';
        // Cache-bust the video src so the freshly composed mp4 loads.
        // Use performance.now() (integer cast) — NOT new Date() constructors.
        const video = document.getElementById('previewVideo');
        if (video && _previewJobId) {
            const bust = Math.floor(performance.now());
            video.src = `${PN_API}/preview/${encodeURIComponent(_previewJobId)}/video.mp4?v=${bust}`;
            try { video.load(); } catch (_) {}
        }
    } catch (e) {
        if (statusEl) statusEl.textContent = '❌ ' + (e.message || e);
    } finally {
        _regenInFlight.delete(guardKey);
    }
}
window.regeneratePreviewSlide = regeneratePreviewSlide;
