// ppt_replace.js — PPT Háttércsere eszköz logika
const POLL_MS = 2000;
const PPT_API = 'api/ppt_replace';

// XSS-védelem: user-vezérelt érték (pl. job.name) escapelése innerHTML/attribútum elé.
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));

let currentJobId = null;
let pollTimer = null;
let selectedQuality = 'resnet50';
let originalFilename = '';
let currentMode = 'normal'; // 'normal' | 'translate' | 'reconstruct'

// Pending files (selected but not yet uploaded)
let pendingVideo = null;
let pendingPptx = null;

const MODE_HINTS = {
    normal:      'Van kész angol PPTX-ed, amit be kell illeszteni.',
    translate:   'Feltöltöd a magyar PPTX-et — a rendszer NLLB-vel lefordítja és beilleszti.',
    reconstruct: 'Csak a videót töltsd fel — a rendszer OCR-rel felismeri és AI-val lefordítja a szövegeket.',
};
const PPTX_LABELS = {
    normal:    '📊 Új Prezentáció (.pptx)',
    translate: '📊 Magyar Prezentáció (.pptx)',
};

function setMode(mode) {
    currentMode = mode;
    // Update pills
    ['normal', 'translate', 'reconstruct'].forEach(m => {
        const id = 'mode' + m.charAt(0).toUpperCase() + m.slice(1);
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle('active', m === mode);
    });
    // Update hint
    const hint = document.getElementById('modeHint');
    if (hint) hint.textContent = MODE_HINTS[mode] || '';
    // Show/hide PPTX zone
    const pptxWrapper = document.getElementById('pptxZoneWrapper');
    const dualGrid = document.getElementById('uploadDualGrid');
    if (pptxWrapper) pptxWrapper.style.display = mode === 'reconstruct' ? 'none' : '';
    if (dualGrid) dualGrid.style.gridTemplateColumns = mode === 'reconstruct' ? '1fr' : '1fr 1fr';
    // Update PPTX label
    const labelEl = document.getElementById('pptxZoneLabel');
    if (labelEl && PPTX_LABELS[mode]) labelEl.textContent = PPTX_LABELS[mode];
    // Clear PPTX if switching to reconstruct
    if (mode === 'reconstruct') {
        pendingPptx = null;
        setStatus('pptxStatus', 'Nem szükséges', '');
    }
    _checkBothSelected();
}
window.setMode = setMode;

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    initSharedSession();

    // Video input
    const videoInput = document.getElementById('videoInput');
    const videoDropZone = document.getElementById('videoDropZone');
    videoInput.addEventListener('change', e => setVideo(e.target.files[0]));
    videoDropZone.addEventListener('dragover', e => { e.preventDefault(); videoDropZone.classList.add('dragover'); });
    videoDropZone.addEventListener('dragleave', () => videoDropZone.classList.remove('dragover'));
    videoDropZone.addEventListener('drop', e => {
        e.preventDefault(); videoDropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) setVideo(e.dataTransfer.files[0]);
    });

    // PPTX input
    const pptxInput = document.getElementById('pptxInput');
    const pptxDropZone = document.getElementById('pptxDropZone');
    pptxInput.addEventListener('change', e => setPptx(e.target.files[0]));
    pptxDropZone.addEventListener('dragover', e => { e.preventDefault(); pptxDropZone.classList.add('dragover'); });
    pptxDropZone.addEventListener('dragleave', () => pptxDropZone.classList.remove('dragover'));
    pptxDropZone.addEventListener('drop', e => {
        e.preventDefault(); pptxDropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) setPptx(e.dataTransfer.files[0]);
    });

    // Init history locally so the active job shows up immediately without clicking pills
    renderHistory();

    document.getElementById('startBtn').addEventListener('click', startProcessing);
});

// ============================================================
// FILE SELECTION
// ============================================================
function setVideo(file) {
    if (!file) return;
    const allowed = ['.mp4', '.mov', '.mkv', '.f4v', '.avi'];
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!allowed.includes(ext)) {
        setStatus('videoStatus', `Nem engedélyezett formátum: ${ext}`, 'err');
        return;
    }
    pendingVideo = file;
    originalFilename = file.name;
    setStatus('videoStatus', `✓ ${file.name}`, 'ok');
    _checkBothSelected();
}

function setPptx(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.pptx')) {
        setStatus('pptxStatus', 'Csak .pptx formátum engedélyezett', 'err');
        return;
    }
    pendingPptx = file;
    setStatus('pptxStatus', `✓ ${file.name}`, 'ok');
    _checkBothSelected();
}

function _checkBothSelected() {
    const pptxOk = currentMode === 'reconstruct' || !!pendingPptx;
    document.getElementById('uploadBtn').disabled = !(pendingVideo && pptxOk);
}

function setStatus(elId, msg, cls) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = msg;
    el.className = 'upload-status' + (cls ? ' ' + cls : '');
}

// ============================================================
// UPLOAD BOTH FILES
// ============================================================
async function uploadBoth() {
    const needsPptx = currentMode !== 'reconstruct';
    if (!pendingVideo || (needsPptx && !pendingPptx)) return;

    const btn = document.getElementById('uploadBtn');
    btn.disabled = true;
    btn.textContent = 'Feltöltés...';

    setStatus('videoStatus', 'Feltöltés folyamatban...', '');
    if (needsPptx) setStatus('pptxStatus', 'Feltöltés folyamatban...', '');

    try {
        currentJobId = await _uploadVideoAndPptx(pendingVideo, needsPptx ? pendingPptx : null);

        setStatus('videoStatus', '✓ Feltöltve', 'ok');
        if (needsPptx) setStatus('pptxStatus', '✓ Feltöltve', 'ok');
        saveJobToHistory(currentJobId, pendingVideo.name);

        showSection('configSection');
        setStep(2);
    } catch (e) {
        setStatus('videoStatus', 'Hiba: ' + e.message, 'err');
        btn.disabled = false;
        btn.textContent = 'Feltöltés és tovább →';
        _checkBothSelected();
    }
}

// A videó DARABOLVA (5 MiB), a PPTX utána külön — egyben a Cloudflare-alagút
// ~100 MB fölött eldobja a kérést, így egy előadás-videóval ez a lap eddig
// használhatatlan volt. A backend 'ppt_replace' célja ppt_replace-jobot hoz
// létre, a PPTX-et az /upload-pptx csatolja. (Funkció-ellenőrzés, 7/12.)
// Tartalék: az egyben küldés, ha az UploadQueue nincs meg. → job_id.
async function _uploadVideoAndPptx(video, pptx) {
    if (!(window.UploadQueue && window.DedupUpload && DedupUpload.computeSignature)) {
        const formData = new FormData();
        formData.append('file', video);
        if (pptx) formData.append('pptx_file', pptx);
        const res = await fetch(`${PPT_API}/upload`, { method: 'POST', body: formData });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Feltöltés sikertelen');
        }
        return (await res.json()).job_id;
    }
    const jobId = await new Promise((resolve, reject) => {
        const q = new UploadQueue({
            maxConcurrent: 1,
            onProgress: ({ percent, state }) => {
                if (state && state !== 'done' && state !== 'error' && state !== 'cancelled') {
                    setStatus('videoStatus', `Feltöltés folyamatban... ${percent}%`, '');
                }
            },
            onComplete: ({ job_id }) => job_id ? resolve(job_id)
                : reject(new Error('a feltöltés nem adott vissza job-azonosítót')),
            onError: ({ error }) => reject(new Error(error)),
        });
        q.enqueue(video, { purpose: 'ppt_replace' });
    });
    if (pptx) {
        const fd = new FormData();
        fd.append('pptx_file', pptx);
        const res = await fetch(`${PPT_API}/upload-pptx/${jobId}`, { method: 'POST', body: fd });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error('PPTX: ' + (err.detail || 'HTTP ' + res.status));
        }
    }
    return jobId;
}

// ============================================================
// CONFIGURE
// ============================================================
function setQuality(variant) {
    selectedQuality = variant;
    document.getElementById('qualHigh').classList.toggle('active', variant === 'resnet50');
    document.getElementById('qualFast').classList.toggle('active', variant === 'mobilenetv3');
}
window.setQuality = setQuality;

// ============================================================
// PROCESSING
// ============================================================
async function startProcessing() {
    if (!currentJobId) return;
    const btn = document.getElementById('startBtn');
    btn.disabled = true;
    btn.textContent = 'Indítás...';
    restoreStatusSection();
    showSection('statusSection');
    setStep(3);

    const colorCorrect = document.getElementById('colorCorrectCheck').checked;

    try {
        const res = await fetch(`${PPT_API}/process/${currentJobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                segmentation_model: 'rvm',
                segmentation_variant: selectedQuality,
                color_correct: colorCorrect,
                feather_px: 3,
                output_crf: 18,
                auto_translate: currentMode === 'translate' || currentMode === 'reconstruct',
                translate_src_lang: 'hun_Latn',
                translate_tgt_lang: 'eng_Latn',
                reconstruct_from_video: currentMode === 'reconstruct',
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Indítási hiba');
        }
        startPolling();
    } catch (e) {
        alert('Hiba: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Feldolgozás indítása';
        showSection('configSection');
        setStep(2);
    }
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    restoreStatusSection();
    pollTimer = setInterval(checkStatus, POLL_MS);
    checkStatus();
}

// A hibapanel eddig a #statusSection TELJES tartalmát lecserélte: a következő
// job (másik history-elem, új feltöltés) updateStatusUI-ja a hiányzó
// #progressBar-on TypeError-t dobott, a poll elnyelte — a lap a régi
// hibapanelen ragadt, a Mégse/Folytatás gomb eltűnt. Most a panel csak
// FÉLRETESZI az eredeti elemeket, és minden új követés visszarakja őket.
// (Funkció-ellenőrzés, 7/12; ugyanez a leirat/felirat/szinkron lapon: UI-20.)
let _parkedStatus = null;

function showStatusError(status, jobId, canRetry = true) {
    const sec = document.getElementById('statusSection');
    if (!_parkedStatus) {
        _parkedStatus = document.createDocumentFragment();
        while (sec.firstChild) _parkedStatus.appendChild(sec.firstChild);
    }
    sec.innerHTML = `
        <div class="error-panel">
            <h3>❌ Hiba a feldolgozás során</h3>
            <p>${esc(status.error_detail || status.detail || status.error || 'Ismeretlen hiba történt.')}</p>
            <div class="error-panel-actions">
                ${canRetry ? `<button onclick="retryJob('${jobId}')" class="btn btn-accent">🔄 Újra feldolgozás (hibás törlése)</button>` : ''}
                <button onclick="deletePPTJob('${jobId}', event)" class="btn btn-secondary">🗑 Törlés</button>
            </div>
        </div>
    `;
}

function restoreStatusSection() {
    if (!_parkedStatus) return;
    document.getElementById('statusSection').replaceChildren(_parkedStatus);
    _parkedStatus = null;
}

async function checkStatus() {
    if (!currentJobId) return;
    try {
        const res = await fetch(`${PPT_API}/status/${currentJobId}`);
        if (res.status === 404) {
            // A job már nincs a szerveren: eddig örökké pollozott.
            clearInterval(pollTimer);
            showStatusError({ detail: 'Ez a feladat már nem létezik a szerveren (törölték, vagy lejárt a megőrzési ideje).' }, currentJobId, false);
            return;
        }
        const status = await res.json();
        updateStatusUI(status);

        if (status.stage === 'done') {
            clearInterval(pollTimer);
            showDownload();
        } else if (status.stage === 'cancelled' || status.stage === 'canceled') {
            clearInterval(pollTimer);
            document.getElementById('jobStatusTitle').textContent = 'Feldolgozás szüneteltetve';
            document.getElementById('jobStageBadge').textContent = 'Megszakítva';
            document.getElementById('statusDetail').textContent = 'A feldolgozás szüneteltetve. Nyomd meg a Folytatás gombot az újraindításhoz.';
            _showResumeUI();
        } else if (status.stage === 'error') {
            clearInterval(pollTimer);
            showStatusError(status, currentJobId);
        }
    } catch (e) {
        console.error('Polling hiba:', e);
    }
}

function updateStatusUI(status) {
    const stageNames = {
        uploaded: 'Feltöltve',
        ppt_analyze: 'Diaváltások keresése',
        ppt_segment: 'Előadó szegmentálás',
        ppt_translate: 'PPTX fordítása',
        ppt_reconstruct: 'Diák rekonstruálása',
        ppt_export: 'PPTX konvertálás',
        ppt_detect: 'OCR szövegolvasás',
        ppt_match: 'Diák egyeztetése',
        ppt_composite: 'Háttér cseréje',
        done: 'Kész',
        error: 'Hiba',
    };
    const stageName = stageNames[status.stage] || status.stage || '';
    const isPaused = status.stage === 'cancelled' || status.stage === 'canceled' || status.stage === 'error';
    if (!isPaused) {
        document.getElementById('jobStatusTitle').textContent = 'Feldolgozás: ' + stageName;
        document.getElementById('jobStageBadge').textContent = stageName;
    }
    document.getElementById('progressBar').style.width = (status.progress || 0) + '%';
    if (!isPaused) {
        document.getElementById('statusDetail').textContent = status.detail || 'Feldolgozás...';
    }
    
    // Toggle Pause & Resume buttons
    const cancelBtn = document.getElementById('cancelJobBtn');
    const resumeBtn = document.getElementById('resumeJobBtn');
    if (cancelBtn) cancelBtn.style.display = isPaused ? 'none' : 'block';
    if (resumeBtn) {
        if (isPaused) resumeBtn.classList.remove('hidden');
        else resumeBtn.classList.add('hidden');
    }
}

function _showResumeUI() {
    // Megjelenítjük a Folytatás gombot, elrejtjük a Cancel gombot
    const cancelBtn = document.getElementById('cancelJobBtn');
    const resumeBtn = document.getElementById('resumeJobBtn');
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (resumeBtn) resumeBtn.classList.remove('hidden');
}

async function cancelJob() {
    if (!currentJobId) return;
    if (!confirm('Biztosan megszakítod a feldolgozást? Később bármikor folytatható.')) return;
    clearInterval(pollTimer);
    try {
        await fetch(`api/cancel/${currentJobId}`, { method: 'POST' });
    } catch (e) { /* ignore */ }
    // Kis várakozás, hogy a szerver feldolgozza a cancel-t
    await new Promise(r => setTimeout(r, 1000));
    checkStatus(); // Refresh UI to trigger paused state
}
window.cancelJob = cancelJob;

async function resumeJob() {
    if (!currentJobId) return;
    const resumeBtn = document.getElementById('resumeJobBtn');
    if (resumeBtn) { resumeBtn.disabled = true; resumeBtn.textContent = 'Folytatás...'; }
    
    document.getElementById('jobStatusTitle').textContent = 'Folytatás indítása...';
    document.getElementById('statusDetail').textContent = 'Várakozás a korábbi szál leállására...';
    
    // A háttérszálnak kell 1-3 mp, hogy leálljon.
    // Újrapróbálkozunk max 5x, 2 mp-enként.
    const colorCorrect = document.getElementById('colorCorrectCheck')?.checked ?? true;
    let success = false;
    
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const res = await fetch(`${PPT_API}/process/${currentJobId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    segmentation_model: 'rvm',
                    segmentation_variant: selectedQuality,
                    color_correct: colorCorrect,
                    feather_px: 3,
                    output_crf: 18,
                    auto_translate: currentMode === 'translate' || currentMode === 'reconstruct',
                    translate_src_lang: 'hun_Latn',
                    translate_tgt_lang: 'eng_Latn',
                    reconstruct_from_video: currentMode === 'reconstruct',
                }),
            });
            if (res.ok) {
                success = true;
                break;
            }
            if (res.status === 423) {
                // Még fut a régi szál, várunk
                document.getElementById('statusDetail').textContent = `Várakozás... (${attempt + 1}/5)`;
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            // Egyéb hiba
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Nem sikerült újraindítani');
        } catch (e) {
            if (attempt === 4) {
                alert('Hiba a folytatásnál: ' + e.message);
                if (resumeBtn) { resumeBtn.disabled = false; resumeBtn.textContent = '▶ Folytatás'; }
                return;
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    
    if (success) {
        // Sikerült újraindítani — megjelenítjük a futó UI-t
        if (resumeBtn) { resumeBtn.classList.add('hidden'); resumeBtn.disabled = false; resumeBtn.textContent = '▶ Folytatás'; }
        const cancelBtn = document.getElementById('cancelJobBtn');
        if (cancelBtn) cancelBtn.style.display = 'block';
        startPolling();
    } else {
        if (resumeBtn) { resumeBtn.disabled = false; resumeBtn.textContent = '▶ Folytatás'; }
    }
}
window.resumeJob = resumeJob;

// ============================================================
// DOWNLOAD
// ============================================================
function showDownload() {
    const stem = originalFilename.replace(/\.[^/.]+$/, '');
    document.getElementById('outputFilename').textContent = stem + '_ppt_replaced.mp4';
    showSection('downloadSection');
    setStep(4);
}

async function downloadOutput() {
    if (!currentJobId) return;
    const a = document.createElement('a');
    a.href = `${PPT_API}/download/${currentJobId}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
window.downloadOutput = downloadOutput;

// ============================================================
// UI HELPERS
// ============================================================
function showSection(id) {
    ['uploadSection', 'configSection', 'statusSection', 'downloadSection'].forEach(sid => {
        const el = document.getElementById(sid);
        if (el) el.classList.toggle('hidden', sid !== id);
    });
}

function setStep(n) {
    for (let i = 1; i <= 4; i++) {
        const el = document.getElementById('step' + i);
        if (!el) continue;
        el.classList.remove('active', 'done');
        if (i < n) el.classList.add('done');
        else if (i === n) el.classList.add('active');
    }
}

function saveJobToHistory(jobId, name) {
    const history = JSON.parse(localStorage.getItem('pptReplaceJobs') || '[]');
    if (!history.find(j => j.id === jobId)) {
        history.unshift({ id: jobId, name, date: new Date().toISOString(), ws: (typeof currentWorkspaceLabel === 'function' ? currentWorkspaceLabel() : null) });   // ws: TD-027
        if (history.length > 20) history.pop();
        localStorage.setItem('pptReplaceJobs', JSON.stringify(history));
    }
    renderHistory();
}

let historyDateFilter = 'all';
function setHistoryDateFilter(value) {
    historyDateFilter = value;
    document.querySelectorAll('#historyDatePills .date-pill').forEach(p => p.classList.remove('active'));
    const map = { all: 'hpAll', today: 'hpToday', yesterday: 'hpYest' };
    if (map[value]) document.getElementById(map[value]).classList.add('active');
    renderHistory();
}
window.setHistoryDateFilter = setHistoryDateFilter;

function _matchHistoryDate(isoDate) {
    if (historyDateFilter === 'all') return true;
    if (!isoDate) return false;
    const day = isoDate.slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (historyDateFilter === 'today') return day === today;
    if (historyDateFilter === 'yesterday') return day === yest;
    return true;
}

function _fmtJobDate(isoDate) {
    if (!isoDate) return '';
    const d = new Date(isoDate);
    return d.toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function _enrichHistoryWithStage(history) {
    return await Promise.all(history.map(async job => {
        try {
            const r = await fetch(`${PPT_API}/status/${job.id}`);
            if (r.ok) {
                const s = await r.json();
                job._stage = s.stage;
            }
        } catch(e) { }
        return job;
    }));
}

async function retryJob(jobId) {
    // Az eredeti elemek vissza (a saját, csonka jelölése a Mégse gombot is
    // elvitte), rajtuk az átmeneti szöveg.
    restoreStatusSection();
    updateStatusUI({ stage: 'uploaded', progress: 0, detail: 'Korábbi mentett adatok betöltése...' });
    document.getElementById('jobStatusTitle').textContent = '🔄 Újraindítás folyamatban...';
    const btnEvent = window.event;
    if(btnEvent) btnEvent.stopPropagation();
    try {
        const res = await fetch(`${PPT_API}/retry/${jobId}`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json().catch(()=>({}));
            throw new Error(err.detail || "Nem sikerült az újraindítás");
        }
        currentJobId = jobId;
        startPolling();
    } catch (e) {
        alert("Hiba: " + e.message);
        // A job továbbra is hibás: a hibapanele térjen vissza.
        checkStatus();
    }
}

window.retryJobFromHistory = function(jobId, event) {
    if(event) event.stopPropagation();
    currentJobId = jobId;
    showSection('statusSection');
    setStep(3);
    retryJob(jobId);
};

async function renderHistory() {
    const container = document.getElementById('jobHistory');
    const history = JSON.parse(localStorage.getItem('pptReplaceJobs') || '[]');
    const filtered = history.filter(job => _matchHistoryDate(job.date) && (typeof isInCurrentWorkspace !== 'function' || isInCurrentWorkspace(job.ws)));
    
    if (filtered.length === 0) {
        const msg = historyDateFilter === 'all' ? 'Nincs korábbi feladat' : (historyDateFilter === 'today' ? 'Ma még nincs feltöltés.' : 'Tegnap nincs feltöltés.');
        container.innerHTML = `<div class="empty-history">${msg}</div>`;
        return;
    }

    _renderPPTHistoryItems(container, filtered);
    const enriched = await _enrichHistoryWithStage(filtered);
    _renderPPTHistoryItems(container, enriched);
}

function _renderPPTHistoryItems(container, items) {
    container.innerHTML = "";
    items.forEach(job => {
        const div = document.createElement('div');
        div.className = 'job-item';
        if (job.id === currentJobId) div.classList.add('active');
        if (job._stage === 'error') div.classList.add('stage-error');
        else if (job._stage === 'done') div.classList.add('stage-done');

        const retryBtn = (job._stage === 'error' || job._stage === 'done')
            ? `<button class="delete-btn" onclick="retryJobFromHistory('${job.id}', event)" title="Újra feldolgozás">🔄</button>`
            : '';

        div.innerHTML = `
            <div class="job-info grow" onclick="loadJob('${job.id}', ${esc(JSON.stringify(job.name))})">
                <div class="truncate">
                    ${esc(job.name)}
                </div>
                <div class="job-date">🕐 ${_fmtJobDate(job.date)}</div>
            </div>
            <div class="row-actions">
                ${retryBtn}
                <button class="delete-btn" onclick="deletePPTJob('${job.id}', event)" title="Feladat törlése">🗑️</button>
            </div>
        `;
        container.appendChild(div);
    });
}

// A korábbi "🗑️ Törlés" csak cancelJob-ot hívott — ez megszakította a
// futó feladatot, de nem törölte a fájlokat a szerverről. Most valódi
// DELETE megy, a backend /api/ppt_replace/job/{id} végpontra.
async function deletePPTJob(jobId, event) {
    if (event) event.stopPropagation();
    if (!confirm('Biztosan törlöd ezt a PPT csere feladatot? Minden hozzá tartozó fájl véglegesen eltűnik.')) return;
    try {
        const res = await fetch(`${PPT_API}/job/${jobId}`, { method: 'DELETE' });
        // 404: a szerveren már nincs meg — a cél teljesült (eddig a history-elem ott ragadt).
        if (!res.ok && res.status !== 404) {
            let detail = 'HTTP ' + res.status;
            try { const b = await res.json(); if (b && b.detail) detail = b.detail; } catch (_) {}
            throw new Error(detail);
        }
    } catch (e) {
        alert('Törlési hiba: ' + (e.message || 'ismeretlen hiba'));
        return;
    }
    let history = JSON.parse(localStorage.getItem('pptReplaceJobs') || '[]');
    history = history.filter(j => j.id !== jobId);
    localStorage.setItem('pptReplaceJobs', JSON.stringify(history));
    if (currentJobId === jobId) resetPage();
    renderHistory();
}
window.deletePPTJob = deletePPTJob;

window.loadJob = async function(jobId, name) {
    currentJobId = jobId;
    originalFilename = name || 'output';
    if (pollTimer) clearInterval(pollTimer);
    restoreStatusSection();
    renderHistory();
    
    // Először lekérdezzük a státuszt, hogy ne induljunk el vakon
    try {
        const res = await fetch(`${PPT_API}/status/${jobId}`);
        if (!res.ok) { showSection('uploadSection'); setStep(1); return; }
        const status = await res.json();
        
        if (status.stage === 'done') {
            showSection('downloadSection'); setStep(4);
            const stem = originalFilename.replace(/\.[^/.]+$/, '');
            document.getElementById('outputFilename').textContent = stem + '_ppt_replaced.mp4';
            return;
        }
        
        if (status.stage === 'cancelled' || status.stage === 'canceled' || status.stage === 'error') {
            // Szüneteltetve: mutatjuk a Folytatás gombot, NEM indítunk újra pollingot!
            showSection('statusSection'); setStep(3);
            updateStatusUI(status);
            document.getElementById('jobStatusTitle').textContent = 'Feldolgozás szüneteltetve';
            document.getElementById('jobStageBadge').textContent = 'Megszakítva';
            document.getElementById('statusDetail').textContent = 'A feldolgozás szüneteltetve. Nyomd meg a Folytatás gombot.';
            _showResumeUI();
            return;
        }
        
        // Egyébként futó munka — polling indítása
        showSection('statusSection'); setStep(3);
        startPolling();
    } catch(e) {
        showSection('statusSection'); setStep(3);
        startPolling();
    }
};

function resetPage() {
    currentJobId = null;
    originalFilename = '';
    pendingVideo = null;
    pendingPptx = null;
    if (pollTimer) clearInterval(pollTimer);
    restoreStatusSection();

    setStatus('videoStatus', 'Nincs kiválasztva', '');
    setStatus('pptxStatus', 'Nincs kiválasztva', '');
    document.getElementById('uploadBtn').disabled = true;
    document.getElementById('uploadBtn').textContent = 'Feltöltés és tovább →';
    document.getElementById('startBtn').disabled = false;
    document.getElementById('startBtn').textContent = 'Feldolgozás indítása';
    document.getElementById('colorCorrectCheck').checked = true;
    setQuality('resnet50');
    setMode('normal');
    showSection('uploadSection');
    setStep(1);
}
window.resetPage = resetPage;
