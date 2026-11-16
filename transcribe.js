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
    const uploaded = (jobId) => {
        currentJobId = jobId;
        nameEl.textContent = 'Feltöltve: ' + file.name;
        document.getElementById('startBtn').disabled = false;
        saveJobToHistory(currentJobId, file.name);
    };

    // DARABOLT feltöltés (5 MiB-os darabok), ahogy a szinkron-lapon: a
    // Cloudflare-alagút ~100 MB fölött eldobja az egyben küldött kérést, így
    // egy előadás-videó innen eddig nem jutott fel. A 'dub_single' cél a
    // szerveren a megadott módú jobot hozza létre (input.mp4), indítás
    // nélkül — a lap feltölt → indít menete változatlan. (Funkció-ellenőrzés, 4/12.)
    if (window.UploadQueue && window.DedupUpload && DedupUpload.computeSignature) {
        await new Promise((resolve) => {
            const q = new UploadQueue({
                maxConcurrent: 1,
                onProgress: ({ percent, state }) => {
                    if (state && state !== 'done' && state !== 'error' && state !== 'cancelled') {
                        nameEl.textContent = `Feltöltés: ${file.name} (${percent}%)`;
                    }
                },
                onComplete: ({ job_id }) => {
                    if (job_id) uploaded(job_id);
                    else nameEl.textContent = 'Hiba: a feltöltés nem adott vissza job-azonosítót.';
                    resolve();
                },
                onError: ({ error }) => { nameEl.textContent = 'Hiba: ' + error; resolve(); },
            });
            q.enqueue(file, { mode: 'transcript_only', purpose: 'dub_single' });
        });
        document.getElementById('dropZone').classList.remove('loading');
        return;
    }

    // Tartalék: egyben (ha az UploadQueue nem töltődött be) — Cloudflare-en
    // át nagy fájlra 413-at adhat, ezért a darabolt út az elsődleges.
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
        uploaded(data.job_id);
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
    restoreStatusSection();
    showSection('statusSection');
    setStep(2);

    try {
        // A fetch csak hálózati hibánál dob: egy elutasított indítás (423,
        // 429, 5xx) eddig csendben pollozásba futott, és a lap örökké a
        // „Feltöltve" állapotot mutatta egy sosem sorba állított jobra.
        const res = await fetch(`${API_URL}/start/${currentJobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'transcript_only', auto_extract: false, enhance_ref: false })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
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
    restoreStatusSection();
    pollTimer = setInterval(checkStatus, POLL_MS);
    checkStatus();
}

// A hibapanel eddig a #statusSection TELJES tartalmát lecserélte. A
// következő job — másik history-elem, új feltöltés — így már nem találta az
// állapot-elemeit: az updateStatusUI TypeError-t dobott, a poll elnyelte, egy
// kész job letöltése sosem nyílt meg, a Mégse gomb pedig végleg eltűnt. Most
// a panel csak FÉLRETESZI az eredeti elemeket, és minden új követés
// (startPolling) visszarakja őket — ugyanazokat, a rájuk kötött
// eseménykezelőkkel együtt. (Funkció-ellenőrzés, 4/12.)
let _parkedStatus = null;

function showStatusError(status, jobId, canRetry = true) {
    const sec = document.getElementById('statusSection');
    if (!_parkedStatus) {
        _parkedStatus = document.createDocumentFragment();
        while (sec.firstChild) _parkedStatus.appendChild(sec.firstChild);
    }
    // A hibaüzenet a szervertől jön → esc(), ahogy a szinkron-lapon.
    sec.innerHTML = `
        <div class="error-panel">
            <h3>❌ Hiba a feldolgozás során</h3>
            <p>${esc(status.error_detail || status.detail || status.error || 'Ismeretlen hiba történt.')}</p>
            <div class="error-panel-actions">
                ${canRetry ? `<button onclick="retryJob('${jobId}')" class="btn btn-accent">🔄 Újra feldolgozás</button>` : ''}
                <button onclick="deleteTranscribeJob('${jobId}', event)" class="btn btn-secondary">🗑 Törlés</button>
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
        const res = await fetch(`${API_URL}/status/${currentJobId}`);
        if (res.status === 404) {
            // A job már nincs a szerveren (törölték, vagy a lomtárból
            // lejárt): eddig a lap 2 mp-enként örökké pollozott egy üres
            // állapotra, angol „Job not found" felirattal.
            clearInterval(pollTimer);
            showStatusError({ detail: 'Ez a feladat már nem létezik a szerveren (törölték, vagy lejárt a megőrzési ideje).' }, currentJobId, false);
            return;
        }
        const status = await res.json();
        updateStatusUI(status);

        if (status.stage === 'done') {
            clearInterval(pollTimer);
            showSection('downloadSection');
            setStep(3);
        } else if (status.stage === 'error') {
            clearInterval(pollTimer);
            showStatusError(status, currentJobId);
        }
    } catch (e) {
        console.error('Polling hiba:', e);
    }
}

async function retryJob(jobId) {
    // Az eredeti elemek vissza (a saját, csonka jelölése a Mégse gombot is
    // elvitte), rajtuk az átmeneti szöveg.
    restoreStatusSection();
    updateStatusUI({ stage: 'retry', progress: 0, detail: 'Korábbi mentett adatok betöltése...' });
    document.getElementById('jobStatusTitle').textContent = '🔄 Újraindítás folyamatban...';
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
        // A job továbbra is hibás: a hibapanele térjen vissza, ne ragadjon
        // a lap az „Újraindítás folyamatban..." feliraton.
        checkStatus();
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
        history.unshift({ id: jobId, name, date: new Date().toISOString(), ws: (typeof currentWorkspaceLabel === 'function' ? currentWorkspaceLabel() : null) });   // ws: TD-027
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
    const filtered = history.filter(job => _matchHistoryDate(job.date) && (typeof isInCurrentWorkspace !== 'function' || isInCurrentWorkspace(job.ws)));

    if (filtered.length === 0) {
        const msg = historyDateFilter === 'all' ? 'Nincs korábbi feladat' : (historyDateFilter === 'today' ? 'Ma még nincs feltöltés.' : 'Tegnap nincs feltöltés.');
        container.innerHTML = `<div class="empty-history">${msg}</div>`;
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
        if (job._stage === 'error') div.classList.add('stage-error');
        else if (job._stage === 'done') div.classList.add('stage-done');

        const retryBtn = (job._stage === 'error' || job._stage === 'done')
            ? `<button class="delete-btn" onclick="retryJobFromHistory('${job.id}', event)" title="Újra feldolgozás">🔄</button>`
            : '';
        // Konzisztencia a dub.html-lel: minden history-item mellett van
        // "Törlés" ikon. Backend + localStorage együtt takarítva.
        const deleteBtn = `<button class="delete-btn" onclick="deleteTranscribeJob('${job.id}', event)" title="Feladat törlése">🗑️</button>`;

        div.innerHTML = `
            <div class="job-info grow" onclick="loadJob('${job.id}')">
                <div class="truncate">
                    ${esc(job.name)}
                </div>
                <div class="job-date">🕐 ${_fmtJobDate(job.date)}</div>
            </div>
            <div class="row-actions">
                ${retryBtn}${deleteBtn}
            </div>
        `;
        container.appendChild(div);
    });
}

// Feladat törlése a history-ból ÉS a szerverről. Backend-first: csak akkor
// takarítjuk a localStorage-t, ha a DELETE 2xx-et (vagy 404-et) adott.
async function deleteTranscribeJob(jobId, event) {
    if (event) event.stopPropagation();
    if (!confirm('Biztosan törlöd ezt a leiratot? Minden hozzá tartozó fájl véglegesen eltűnik.')) return;
    try {
        const res = await fetch(`${API_URL}/job/${jobId}`, { method: 'DELETE' });
        // A 404 azt jelenti, hogy a szerveren már nincs meg — a cél teljesült.
        // Eddig ilyenkor hibát kapott, és a history-elem örökre ott ragadt.
        if (!res.ok && res.status !== 404) {
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
    restoreStatusSection();
    document.getElementById('fileName').textContent = '';
    document.getElementById('startBtn').disabled = true;
    showSection('uploadSection');
    setStep(1);
}
window.resetPage = resetPage;
