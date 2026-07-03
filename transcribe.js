// transcribe.js — Leirat eszköz logika
const POLL_MS = 2000;

// XSS-védelem: user-vezérelt érték (pl. job.name) escapelése innerHTML elé.
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));

let currentJobId = null;
let pollTimer = null;

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    initSharedSession();

    const fileInput = document.getElementById('fileInput');
    const dropZone = document.getElementById('dropZone');

    fileInput.addEventListener('change', e => handleFile(e.target.files[0]));

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });

    document.getElementById('startBtn').addEventListener('click', startProcessing);
    document.getElementById('cancelJobBtn').addEventListener('click', cancelJob);

    // TR-01: história-sidebar feltöltése belépéskor (korábban sosem hívódott init-kor).
    renderHistory();
});

// ============================================================
// UPLOAD
// ============================================================
async function handleFile(file) {
    if (!file) return;
    const nameEl = document.getElementById('fileName');
    nameEl.textContent = 'Feltöltés: ' + file.name;
    document.getElementById('dropZone').classList.add('loading');

    const owner = getOwner() || 'default';
    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch(`${API_URL}/upload?owner=${encodeURIComponent(owner)}&mode=transcript_only`, {
            method: 'POST', body: formData
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Feltöltés sikertelen');
        }
        const data = await res.json();
        currentJobId = data.job_id;
        nameEl.textContent = 'Feltöltve: ' + file.name;
        document.getElementById('startBtn').disabled = false;
        saveJobToHistory(currentJobId, file.name);
    } catch (e) {
        nameEl.textContent = 'Hiba: ' + e.message;
    } finally {
        document.getElementById('dropZone').classList.remove('loading');
    }
}

// ============================================================
// PROCESSING
// ============================================================
async function startProcessing() {
    if (!currentJobId) return;
    document.getElementById('startBtn').disabled = true;
    showSection('statusSection');
    setStep(2);

    try {
        await fetch(`${API_URL}/start/${currentJobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'transcript_only', auto_extract: false, enhance_ref: false })
        });
        startPolling();
    } catch (e) {
        alert('Indítási hiba: ' + e.message);
        document.getElementById('startBtn').disabled = false;
        showSection('uploadSection');
        setStep(1);
    }
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(checkStatus, POLL_MS);
    checkStatus();
}

async function checkStatus() {
    if (!currentJobId) return;
    try {
        const res = await fetch(`${API_URL}/status/${currentJobId}`);
        const status = await res.json();
        updateStatusUI(status);

        if (status.stage === 'done') {
            clearInterval(pollTimer);
            showSection('downloadSection');
            setStep(3);
        } else if (status.stage === 'error') {
            clearInterval(pollTimer);
            // Insert error panel dynamically
            document.getElementById('statusSection').innerHTML = `
                <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid #ef4444; border-radius: 8px; padding: 20px; text-align: center;">
                    <h3 style="color:#ef4444; margin-bottom:8px;">❌ Hiba a feldolgozás során</h3>
                    <p style="color:var(--text-secondary); margin-bottom:16px;">${status.error_detail || status.detail || status.error || 'Ismeretlen hiba történt.'}</p>
                    <div style="display:flex; justify-content:center; gap:12px;">
                        <button onclick="retryJob('${currentJobId}')" class="btn btn-accent" style="box-shadow: 0 0 10px rgba(99,102,241,0.5);">🔄 Újra feldolgozás</button>
                        <button onclick="resetPage();" class="btn btn-secondary">🗑 Törlés</button>
                    </div>
                </div>
            `;
        }
    } catch (e) {
        console.error('Polling hiba:', e);
    }
}

async function retryJob(jobId) {
    document.getElementById('statusSection').innerHTML = `
        <div class="status-header">
            <h2 id="jobStatusTitle">🔄 Újraindítás folyamatban...</h2>
            <span id="jobStageBadge" class="badge">retry</span>
        </div>
        <p id="statusDetail" class="status-detail">Korábbi mentett adatok betöltése...</p>
        <div class="progress-bar-container">
            <div id="progressBar" class="progress-bar" style="width: 10%;"></div>
        </div>
    `;
    const btnEvent = window.event;
    if(btnEvent) btnEvent.stopPropagation();
    try {
        const res = await fetch(`${API_URL}/retry/${jobId}`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json().catch(()=>({}));
            throw new Error(err.detail || "Nem sikerült az újraindítás");
        }
        currentJobId = jobId;
        startPolling();
    } catch (e) {
        alert("Hiba: " + e.message);
    }
}
window.retryJobFromHistory = function(jobId, event) {
    if(event) event.stopPropagation();
    currentJobId = jobId;
    showSection('statusSection');
    setStep(2);
    retryJob(jobId);
};

function updateStatusUI(status) {
    document.getElementById('jobStatusTitle').textContent = 'Átírás: ' + (status.stage || '');
    document.getElementById('jobStageBadge').textContent = status.stage || '';
    document.getElementById('progressBar').style.width = (status.progress || 0) + '%';
    document.getElementById('statusDetail').textContent = status.detail || '';
}

async function cancelJob() {
    if (!currentJobId) return;
    if (!confirm('Biztosan meg akarod szakítani?')) return;
    try {
        await fetch(`${API_URL}/cancel/${currentJobId}`, { method: 'POST' });
        resetPage();
    } catch (e) {
        alert('Mégse hiba: ' + e.message);
    }
}

// ============================================================
// DOWNLOAD
// ============================================================
async function downloadTxt() {
    if (!currentJobId) return;
    // First generate the transcript.txt, then download it
    try {
        const res = await fetch(`${API_URL}/job/${currentJobId}/export_transcript`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Export hiba');
        }
        downloadFileFromJob(currentJobId, 'transcript.txt');
    } catch (e) {
        alert('Letöltési hiba: ' + e.message);
    }
}
window.downloadTxt = downloadTxt;

function dlFile(filename) {
    downloadFileFromJob(currentJobId, filename);
}
window.dlFile = dlFile;

// ============================================================
// UI HELPERS
// ============================================================
function showSection(id) {
    ['uploadSection', 'statusSection', 'downloadSection'].forEach(sid => {
        const el = document.getElementById(sid);
        if (el) el.classList.toggle('hidden', sid !== id);
    });
}

function setStep(n) {
    for (let i = 1; i <= 3; i++) {
        const el = document.getElementById('step' + i);
        if (!el) continue;
        el.classList.remove('active', 'done');
        if (i < n) el.classList.add('done');
        else if (i === n) el.classList.add('active');
    }
}

function saveJobToHistory(jobId, name) {
    const history = JSON.parse(localStorage.getItem('transcribeJobs') || '[]');
    if (!history.find(j => j.id === jobId)) {
        history.unshift({ id: jobId, name, date: new Date().toISOString() });
        if (history.length > 20) history.pop();
        localStorage.setItem('transcribeJobs', JSON.stringify(history));
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
            const r = await fetch(`${API_URL}/status/${job.id}`);
            if (r.ok) {
                const s = await r.json();
                job._stage = s.stage;
            }
        } catch(e) { }
        return job;
    }));
}

async function renderHistory() {
    const container = document.getElementById('jobHistory');
    const history = JSON.parse(localStorage.getItem('transcribeJobs') || '[]');
    const filtered = history.filter(job => _matchHistoryDate(job.date));

    if (filtered.length === 0) {
        const msg = historyDateFilter === 'all' ? 'Nincs korábbi feladat' : (historyDateFilter === 'today' ? 'Ma még nincs feltöltés.' : 'Tegnap nincs feltöltés.');
        container.innerHTML = `<div style="padding:20px;color:#555;font-size:0.85rem;">${msg}</div>`;
        return;
    }

    _renderTranscribeHistoryItems(container, filtered);
    const enriched = await _enrichHistoryWithStage(filtered);
    _renderTranscribeHistoryItems(container, enriched);
}

function _renderTranscribeHistoryItems(container, items) {
    container.innerHTML = "";
    items.forEach(job => {
        const div = document.createElement('div');
        div.className = 'job-item';
        if (job.id === currentJobId) div.classList.add('active');
        if (job._stage === 'error') div.style.borderLeft = "3px solid #ef4444";
        else if (job._stage === 'done') div.style.borderLeft = "3px solid #10b981";

        const retryBtn = (job._stage === 'error' || job._stage === 'done')
            ? `<button class="delete-btn" onclick="retryJobFromHistory('${job.id}', event)" title="Újra feldolgozás" style="margin-right:4px;">🔄</button>`
            : '';
        // Konzisztencia a dub.html-lel: minden history-item mellett van
        // "Törlés" ikon. Backend + localStorage együtt takarítva.
        const deleteBtn = `<button class="delete-btn" onclick="deleteTranscribeJob('${job.id}', event)" title="Feladat törlése">🗑️</button>`;

        div.innerHTML = `
            <div class="job-info" onclick="loadJob('${job.id}')" style="flex:1; overflow:hidden;">
                <div style="font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                    ${esc(job.name)}
                </div>
                <div class="job-date">🕐 ${_fmtJobDate(job.date)}</div>
            </div>
            <div style="display:flex; flex-shrink:0;">
                ${retryBtn}${deleteBtn}
            </div>
        `;
        container.appendChild(div);
    });
}

// Feladat törlése a history-ból ÉS a szerverről. Backend-first: csak akkor
// takarítjuk a localStorage-t, ha a DELETE 2xx-et adott.
async function deleteTranscribeJob(jobId, event) {
    if (event) event.stopPropagation();
    if (!confirm('Biztosan törlöd ezt a leiratot? Minden hozzá tartozó fájl véglegesen eltűnik.')) return;
    try {
        const res = await fetch(`${API_URL}/job/${jobId}`, { method: 'DELETE' });
        if (!res.ok) {
            let detail = 'HTTP ' + res.status;
            try { const b = await res.json(); if (b && b.detail) detail = b.detail; } catch (_) {}
            throw new Error(detail);
        }
    } catch (e) {
        alert('Törlési hiba: ' + (e.message || 'ismeretlen hiba'));
        return;
    }
    let history = JSON.parse(localStorage.getItem('transcribeJobs') || '[]');
    history = history.filter(j => j.id !== jobId);
    localStorage.setItem('transcribeJobs', JSON.stringify(history));
    if (currentJobId === jobId) resetPage();
    renderHistory();
}
window.deleteTranscribeJob = deleteTranscribeJob;

window.loadJob = function(jobId) {
    currentJobId = jobId;
    showSection('statusSection');
    setStep(2);
    startPolling();
    renderHistory();
};

function resetPage() {
    currentJobId = null;
    if (pollTimer) clearInterval(pollTimer);
    document.getElementById('fileName').textContent = '';
    document.getElementById('startBtn').disabled = true;
    showSection('uploadSection');
    setStep(1);
}
window.resetPage = resetPage;
