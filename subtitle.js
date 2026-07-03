// subtitle.js — Felirat eszköz logika
const POLL_MS = 2000;

// XSS-védelem: user-vezérelt érték (pl. job.name) escapelése innerHTML elé.
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));

let currentJobId = null;
let pollTimer = null;
let segmentsData = [];

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    initSharedSession();

    const videoInput = document.getElementById('videoInput');
    const videoDropZone = document.getElementById('videoDropZone');

    videoInput.addEventListener('change', e => handleVideoFile(e.target.files[0]));

    videoDropZone.addEventListener('dragover', e => { e.preventDefault(); videoDropZone.classList.add('dragover'); });
    videoDropZone.addEventListener('dragleave', () => videoDropZone.classList.remove('dragover'));
    videoDropZone.addEventListener('drop', e => {
        e.preventDefault();
        videoDropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) handleVideoFile(e.dataTransfer.files[0]);
    });

    document.getElementById('startBtn').addEventListener('click', startProcessing);
    document.getElementById('saveSegmentsBtn').addEventListener('click', saveSegments);
    document.getElementById('exportSubtitlesBtn').addEventListener('click', exportSubtitles);
    document.getElementById('retranslateBtn').addEventListener('click', retranslate);
    document.getElementById('cancelJobBtn').addEventListener('click', cancelJob);

    // SUB-002: história-sidebar feltöltése belépéskor (korábban sosem hívódott init-kor).
    renderHistory();
});

// ============================================================
// UPLOAD
// ============================================================
async function handleVideoFile(file) {
    if (!file) return;
    const nameEl = document.getElementById('videoFileName');
    nameEl.textContent = 'Feltöltés: ' + file.name;
    document.getElementById('videoDropZone').classList.add('loading');

    const owner = getOwner() || 'default';
    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch(`${API_URL}/upload?owner=${encodeURIComponent(owner)}&mode=subtitles_only`, {
            method: 'POST', body: formData
        });
        if (!res.ok) throw new Error('Feltöltés sikertelen');
        const data = await res.json();
        currentJobId = data.job_id;
        nameEl.textContent = 'Feltöltve: ' + file.name;
        document.getElementById('startBtn').disabled = false;
        saveJobToHistory(currentJobId, file.name);
    } catch (e) {
        nameEl.textContent = 'Hiba: ' + e.message;
    } finally {
        document.getElementById('videoDropZone').classList.remove('loading');
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
            body: JSON.stringify({ mode: 'subtitles_only', auto_extract: false, enhance_ref: false })
        });
        startPolling();
    } catch (e) {
        alert('Indítási hiba: ' + e.message);
        document.getElementById('startBtn').disabled = false;
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

        if (status.stage === 'edit_ready') {
            clearInterval(pollTimer);
            await loadSegments();
            showSection('editorSection');
            setStep(3);
        } else if (status.stage === 'done') {
            clearInterval(pollTimer);
            showDownloads();
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

// ---- RESTORED: 14 symbols deleted by e76f86d (the placeholder below) ----
// subtitle.js was left with this stub comment + live references to the
// deleted functions, so the page threw ReferenceError at init. Restored
// verbatim from e76f86d~1; renderHistory/loadJob kept at the CURRENT version.
let historyDateFilter = 'all';

function updateStatusUI(status) {
    document.getElementById('jobStatusTitle').textContent = 'Feldolgozás: ' + (status.stage || '');
    document.getElementById('jobStageBadge').textContent = status.stage || '';
    document.getElementById('progressBar').style.width = (status.progress || 0) + '%';
    document.getElementById('statusDetail').textContent = status.detail || '';
}

async function loadSegments() {
    const res = await fetch(`${API_URL}/job/${currentJobId}`);
    const data = await res.json();
    segmentsData = data.segments || [];
    renderSegments();
}

async function saveSegments() {
    const btn = document.getElementById('saveSegmentsBtn');
    btn.disabled = true;
    btn.textContent = 'Mentés...';
    try {
        await fetch(`${API_URL}/job/${currentJobId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ segments: segmentsData })
        });
        btn.textContent = 'Mentve ✓';
        setTimeout(() => { btn.textContent = 'Mentés'; }, 1500);
    } catch (e) {
        alert('Mentési hiba: ' + e.message);
        btn.textContent = 'Mentés';
    } finally {
        btn.disabled = false;
    }
}

async function retranslate() {
    const btn = document.getElementById('retranslateBtn');
    btn.disabled = true;
    btn.textContent = 'Fordítás...';
    showSection('statusSection');
    setStep(2);

    try {
        await fetch(`${API_URL}/job/${currentJobId}/retranslate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ segments: segmentsData })
        });
        startPolling();
    } catch (e) {
        alert('Fordítási hiba: ' + e.message);
        btn.textContent = 'Fordítás újra';
        btn.disabled = false;
        showSection('editorSection');
        setStep(3);
    }
}

async function exportSubtitles() {
    const btn = document.getElementById('exportSubtitlesBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Exportálás...';
    try {
        const res = await fetch(`${API_URL}/job/${currentJobId}/export_subtitles`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Export hiba');
        }
        showDownloads();
    } catch (e) {
        alert('Export hiba: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '📥 Export feliratok';
    }
}

function showDownloads() {
    showSection('downloadSection');
    setStep(4);
    loadSubtitleQualityReport();
}

function dlFile(filename) {
    downloadFileFromJob(currentJobId, filename);
}

function showSection(id) {
    ['uploadSection', 'statusSection', 'editorSection', 'downloadSection'].forEach(sid => {
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
    const history = JSON.parse(localStorage.getItem('subtitleJobs') || '[]');
    if (!history.find(j => j.id === jobId)) {
        history.unshift({ id: jobId, name, date: new Date().toISOString() });
        if (history.length > 20) history.pop();
        localStorage.setItem('subtitleJobs', JSON.stringify(history));
    }
    renderHistory();
}

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

window.dlFile = dlFile;

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
    const history = JSON.parse(localStorage.getItem('subtitleJobs') || '[]');
    const filtered = history.filter(job => _matchHistoryDate(job.date));

    if (filtered.length === 0) {
        const msg = historyDateFilter === 'all' ? 'Nincs korábbi feladat' : (historyDateFilter === 'today' ? 'Ma még nincs feltöltés.' : 'Tegnap nincs feltöltés.');
        container.innerHTML = `<div style="padding:20px;color:#555;font-size:0.85rem;">${msg}</div>`;
        return;
    }

    _renderSubtitleHistoryItems(container, filtered);
    const enriched = await _enrichHistoryWithStage(filtered);
    _renderSubtitleHistoryItems(container, enriched);
}

function _renderSubtitleHistoryItems(container, items) {
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
        const deleteBtn = `<button class="delete-btn" onclick="deleteSubtitleJob('${job.id}', event)" title="Feladat törlése">🗑️</button>`;

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
async function deleteSubtitleJob(jobId, event) {
    if (event) event.stopPropagation();
    if (!confirm('Biztosan törlöd ezt a feliratot? Minden hozzá tartozó fájl véglegesen eltűnik.')) return;
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
    let history = JSON.parse(localStorage.getItem('subtitleJobs') || '[]');
    history = history.filter(j => j.id !== jobId);
    localStorage.setItem('subtitleJobs', JSON.stringify(history));
    if (currentJobId === jobId) resetPage();
    renderHistory();
}
window.deleteSubtitleJob = deleteSubtitleJob;
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
    segmentsData = [];
    document.getElementById('videoFileName').textContent = '';
    document.getElementById('startBtn').disabled = true;
    showSection('uploadSection');
    setStep(1);
}
window.resetPage = resetPage;

// ---- RESTORED (deps of the above): renderSegments + loadSubtitleQualityReport (e76f86d) ----
function renderSegments() {
    const tbody = document.querySelector('#segmentsTable tbody');
    tbody.innerHTML = '';
    segmentsData.forEach((seg, idx) => {
        const tr = document.createElement('tr');
        const timeTd = document.createElement('td');
        timeTd.textContent = `${seg.start.toFixed(2)} – ${seg.end.toFixed(2)}`;

        const huTd = document.createElement('td');
        const huTa = document.createElement('textarea');
        huTa.value = seg.hu || '';
        huTa.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = this.scrollHeight + 'px';
            segmentsData[idx].hu = this.value;
        });
        huTd.appendChild(huTa);

        const enTd = document.createElement('td');
        const enTa = document.createElement('textarea');
        enTa.value = seg.en || '';
        enTa.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = this.scrollHeight + 'px';
            segmentsData[idx].en = this.value;
        });
        enTd.appendChild(enTa);

        tr.appendChild(timeTd);
        tr.appendChild(huTd);
        tr.appendChild(enTd);
        tbody.appendChild(tr);

        setTimeout(() => {
            huTa.style.height = huTa.scrollHeight + 'px';
            enTa.style.height = enTa.scrollHeight + 'px';
        }, 0);
    });
}

async function loadSubtitleQualityReport() {
    try {
        const res = await fetch(`${API_URL}/download/${currentJobId}/subtitles_report.json?preview=true`);
        if (!res.ok) return;
        const report = await res.json();
        const card = document.getElementById('subtitleQualityCard');
        const body = document.getElementById('subtitleQualityBody');
        body.innerHTML = `
            <span style="margin-right:16px;">📝 <b>${report.total_cues || '–'}</b> felirat cue</span>
            <span style="margin-right:16px;">⏱ Átlag hossz: <b>${report.avg_dur || '–'}s</b></span>
            <span style="margin-right:16px;">📏 Átlag chars: <b>${report.avg_chars || '–'}</b></span>
            <span>🔀 Mergek: <b>${report.merges || 0}</b></span>
        `;
        card.classList.remove('hidden');
    } catch (e) { /* silent */ }
}
