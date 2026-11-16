// API_URL is declared globally in shared.js, which is loaded BEFORE app.js on
// every page that uses app.js (dub.html, subtitle.html). Re-declaring it here
// threw "Uncaught SyntaxError: redeclaration of const API_URL" at parse time,
// which aborted ALL of app.js — so none of the event handlers (incl. the video
// upload) were ever wired. Rely on shared.js's declaration instead.
const POLLING_INTERVAL = 2000;

const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));

let currentJobId = null;
let pollTimer = null;
let segmentsData = [];
let lastStatus = null;
let currentJobMode = 'dub_full'; // tracks current job's mode
let historyDateFilter = 'all'; // 'all' | 'today' | 'yesterday'

function setHistoryDateFilter(value) {
    historyDateFilter = value;
    // Az aria-pressed a .active vizuális jelzés hangos párja: enélkül a
    // képernyőolvasó nem mondja meg, melyik szűrő van bekapcsolva.
    ['hpAll', 'hpToday', 'hpYest'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove('active');
            el.setAttribute('aria-pressed', 'false');
        }
    });
    const map = { all: 'hpAll', today: 'hpToday', yesterday: 'hpYest' };
    const active = document.getElementById(map[value]);
    if (active) {
        active.classList.add('active');
        active.setAttribute('aria-pressed', 'true');
    }
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

// Monitor and Auth functions moved to shared.js

// DOM Elements
const videoDrop = document.getElementById('videoDropZone');
const videoInput = document.getElementById('videoInput');
const videoName = document.getElementById('videoFileName');

const voiceDrop = document.getElementById('voiceDropZone');
const voiceInput = document.getElementById('voiceInput');
const voiceName = document.getElementById('voiceFileName');

const startBtn = document.getElementById('startBtn');

// Sections
const uploadSection = document.getElementById('uploadSection');
const statusSection = document.getElementById('statusSection');
const editorSection = document.getElementById('editorSection');
const downloadSection = document.getElementById('downloadSection');

// Status Elements
const statusTitle = document.getElementById('jobStatusTitle');
const statusBadge = document.getElementById('jobStageBadge');
const progressBar = document.getElementById('progressBar');
const progressTrack = document.getElementById('progressTrack');
const statusDetail = document.getElementById('statusDetail');
const forceContainer = document.getElementById('forceContainer');
const forceStartBtn = document.getElementById('forceStartBtn');

// Editor
const segmentsTable = document.getElementById('segmentsTable').querySelector('tbody');
const saveSegmentsBtn = document.getElementById('saveSegmentsBtn');
const generateDubBtn = document.getElementById('generateDubBtn');
const exportSubtitlesBtn = document.getElementById('exportSubtitlesBtn');

// Setup Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    // applyOwnerDisplay and startMonitor are now provided by shared.js
    if (typeof applyOwnerDisplay === 'function') applyOwnerDisplay();
    if (typeof renderHistory === 'function') renderHistory();  // was loadHistory() — removed in a refactor; renderHistory() is the current name
    // Restore last mode selection
    const savedMode = localStorage.getItem('dubLastMode');
    if (savedMode) {
        const radio = document.querySelector(`input[name="procMode"][value="${savedMode}"]`);
        if (radio) radio.checked = true;
    }
    // Save mode immediately whenever a radio button is selected
    document.querySelectorAll('input[name="procMode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            localStorage.setItem('dubLastMode', radio.value);
        });
    });
    // Start server monitor
    if (typeof startMonitor === 'function') startMonitor();
});

// Drag & Drop — a hangminta-blokk a subtitle.html-en nem szerepel, ezért
// voiceDrop/voiceInput ott NULL. .filter(Boolean) megóv a TypeError-tól.
[videoDrop, voiceDrop].filter(Boolean).forEach(zone => {
    zone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
    });
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', (e) => {
        // Only remove if leaving the zone itself, not a child element
        if (!zone.contains(e.relatedTarget)) {
            zone.classList.remove('dragover');
        }
    });
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('dragover');
        if (zone === videoDrop && e.dataTransfer.files.length) {
            handleVideoFiles(e.dataTransfer.files);
        } else if (zone === voiceDrop && e.dataTransfer.files.length) {
            handleVoiceFiles(e.dataTransfer.files);
        }
    });
});

if (videoInput) videoInput.addEventListener('change', (e) => handleVideoFiles(e.target.files));
if (voiceInput) voiceInput.addEventListener('change', (e) => handleVoiceFiles(e.target.files));



// Defensive event-wiring. Several legacy editor handlers (saveSegments,
// exportSubtitles, retranslateSegments, forceStart) were removed in a past
// refactor but their buttons + this wiring stayed. Referencing the now-missing
// functions threw a ReferenceError that aborted ALL remaining top-level code in
// app.js — so even the handlers below (and DOM init) never ran. Guard the
// element AND the handler so a missing one degrades gracefully instead of
// breaking the whole page. (These four buttons are non-functional until the
// handlers are properly restored — tracked separately.)
const _bind = (el, evt, fn) => { if (el && typeof fn === 'function') el.addEventListener(evt, fn); };
_bind(startBtn, 'click', typeof startPipeline === 'function' ? startPipeline : null);
_bind(saveSegmentsBtn, 'click', typeof saveSegments === 'function' ? saveSegments : null);
_bind(generateDubBtn, 'click', typeof startGeneration === 'function' ? startGeneration : null);
_bind(exportSubtitlesBtn, 'click', typeof exportSubtitles === 'function' ? exportSubtitles : null);
_bind(document.getElementById('retranslateBtn'), 'click', typeof retranslateSegments === 'function' ? retranslateSegments : null);
_bind(document.getElementById('vttInput'), 'change', (e) => handleVttUpload(e.target.files));
_bind(forceStartBtn, 'click', typeof forceStart === 'function' ? forceStart : null);
// DUB-1: the ✕ Mégse (cancelJobBtn) button was rendered + made visible but had
// NO click handler — the only cancel affordance on the page was dead. cancelJob
// (shared.js) POSTs the cancel; re-poll so the UI reflects the cancelled state.
_bind(document.getElementById('cancelJobBtn'), 'click', () => {
    if (currentJobId && typeof window.cancelJob === 'function') {
        Promise.resolve(window.cancelJob(currentJobId)).then((ok) => { if (ok) startPolling(); });
    }
});

async function handleVttUpload(files) {
    if (files.length === 0 || !currentJobId) return;
    const file = files[0];

    // Disable UI
    const importBtn = document.getElementById('importVttBtn');
    importBtn.textContent = "Importing...";
    importBtn.disabled = true;

    const formData = new FormData();
    formData.append('file', file);

    try {
        const res = await fetch(`${API_URL}/job/${currentJobId}/import_vtt`, {
            method: 'POST',
            body: formData
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Import failed");
        }

        const data = await res.json();
        console.log("VTT Import Result:", data);

        if (data.segments && Array.isArray(data.segments)) {
            segmentsData = data.segments;
            renderSegments();
            alert(`Sikeresen importálva ${segmentsData.length} szegmens.\nNézd át alaposan a generálás előtt.`);
        } else {
            alert("Figyelem: az import sikerült, de nem érkezett vissza szegmens.");
        }

    } catch (e) {
        console.error("VTT Import Error", e);
        alert("VTT import hiba: " + e.message);
    } finally {
        importBtn.textContent = "VTT import";
        importBtn.disabled = false;
        document.getElementById('vttInput').value = ""; // convert to empty to clear selection
    }
}

function handleVideoFiles(files) {
    if (files.length > 0) {
        uploadVideo(files[0]);
    }
}

function handleVoiceFiles(files) {
    if (files.length > 0) {
        uploadVoice(files[0]);
    }
}

async function uploadVideo(file) {
    // Dedup: feltöltés előtt azonos-fájl ellenőrzés (fail-open).
    if (window.DedupUpload && (await DedupUpload.guard(file)) === 'skip') {
        videoName.textContent = 'Kihagyva (már feltöltve): ' + file.name;
        return;
    }
    videoName.textContent = "Feltöltés: " + file.name;
    videoDrop.classList.add('loading');

    // CHUNKED feltöltés (5 MB-os darabok) — átcsúszik a Cloudflare-alagút
    // ~100 MB-os request-body limitjén, így nagy videó is feltölthető. A
    // 'dub_single' purpose a szerveren dub-jobot hoz létre (input.mp4) és
    // visszaadja a job_id-t AUTO-indítás nélkül, így marad az interaktív
    // (feltölt → hangminta → Szinkron indítása) flow.
    if (window.UploadQueue && window.DedupUpload && DedupUpload.computeSignature) {
        await new Promise((resolve) => {
            const q = new UploadQueue({
                maxConcurrent: 1,
                onProgress: ({ percent, state }) => {
                    if (state && state !== 'done' && state !== 'error' && state !== 'cancelled') {
                        videoName.textContent = `Feltöltés: ${file.name} (${percent}%)`;
                    }
                },
                onComplete: ({ job_id }) => {
                    if (job_id) {
                        currentJobId = job_id;
                        videoName.textContent = "Feltöltve: " + file.name;
                        addToHistory(currentJobId, file.name);
                        updateStartButton();
                    } else {
                        videoName.textContent = "Hiba: a feltöltés nem adott vissza job-azonosítót.";
                    }
                    videoDrop.classList.remove('loading');
                    resolve();
                },
                onError: ({ error }) => {
                    videoName.textContent = "Hiba: " + error;
                    videoDrop.classList.remove('loading');
                    resolve();
                },
            });
            q.enqueue(file, { mode: 'dub_full', purpose: 'dub_single' });
        });
        return;
    }

    // Fallback: egyszeri POST (ha az UploadQueue nem töltődött be). Cloudflare-en
    // át nagy fájlra 413-at adhat — ezért a chunked út az elsődleges.
    const formData = new FormData();
    formData.append('file', file);
    try {
        const res = await fetch(`${API_URL}/upload`, {
            method: 'POST',
            body: formData
        });
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { const b = await res.json(); if (b && b.detail) detail = b.detail; } catch(_) {}
            throw new Error(detail);
        }
        const data = await res.json();
        currentJobId = data.job_id;
        videoName.textContent = "Feltöltve: " + file.name;
        addToHistory(currentJobId, file.name);
        updateStartButton();
    } catch (e) {
        videoName.textContent = "Hiba: " + e.message;
    } finally {
        videoDrop.classList.remove('loading');
    }
}

async function uploadVoice(file) {
    if (!currentJobId) {
        alert("Először tölts fel videót, hogy legyen hová csatolni a hangmintát.");
        return;
    }
    const formData = new FormData();
    formData.append('file', file);

    voiceName.textContent = "Feltöltés: " + file.name;

    try {
        const res = await fetch(`${API_URL}/upload_voice_ref?job_id=${currentJobId}`, {
            method: 'POST',
            body: formData
        });
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { const b = await res.json(); if (b && b.detail) detail = b.detail; } catch(_) {}
            throw new Error(detail);
        }
        voiceName.textContent = "Feltöltve: " + file.name;
        updateStartButton();
    } catch (e) {
        voiceName.textContent = "Hiba: " + e.message;
    }
}

function updateStartButton() {
    // Check if video is uploaded
    // Voice is optional (if auto is checked)
    if (currentJobId) {
        startBtn.disabled = false;
    } else {
        startBtn.disabled = true;
    }
}

async function startPipeline() {
    if (!currentJobId) return;

    startBtn.disabled = true;
    restoreStatusSection();
    statusSection.classList.remove('hidden');

    try {
        // A subtitle.html nem tartalmaz hangminta-blokkot — a 2 mező ilyenkor
        // hiányzik, és csendben false-ra esik. (Felirat-pipeline-nak nem kell.)
        const autoExtract = document.getElementById('autoExtractVoice')?.checked || false;
        const enhanceRef = document.getElementById('enhanceRef')?.checked || false;
        const mode = document.querySelector('input[name="procMode"]:checked').value;

        // Save mode preference
        localStorage.setItem('dubLastMode', mode);

        // A fetch csak hálózati hibánál dob: egy elutasított indítás (423,
        // 429, 5xx) eddig csendben pollozásba futott, és a lap örökké a
        // „Feltöltve" állapotot mutatta egy sosem sorba állított jobra.
        const res = await fetch(`${API_URL}/start/${currentJobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                auto_extract: autoExtract,
                enhance_ref: enhanceRef,
                mode: mode
            })
        });
        if (!res.ok) throw await _saveError(res);
        startPolling();
    } catch (e) {
        alert("Nem sikerült a feladatot elindítani: " + e.message);
        startBtn.disabled = false;
        statusSection.classList.add('hidden');
    }
}

async function startGeneration() {
    if (!currentJobId) return;
    // A TTS a MENTETT szövegből dolgozik: a mentetlen javítás előbb menjen fel,
    // különben a szinkron a javítatlan szövegből készül. (UI-18)
    if (hasUnsavedChanges() && !(await saveSegments())) return;

    generateDubBtn.disabled = true;
    statusSection.classList.remove('hidden');
    editorSection.classList.add('hidden'); // Hide editor while generating

    try {
        const res = await fetch(`${API_URL}/generate/${currentJobId}`, { method: 'POST' });
        if (!res.ok) throw await _saveError(res);
        // Polling should already be running or we restart it
        startPolling();
    } catch (e) {
        alert("Nem sikerült a szinkron generálása: " + e.message);
        generateDubBtn.disabled = false;
        editorSection.classList.remove('hidden');
    }
}

function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    restoreStatusSection();
    pollTimer = setInterval(checkStatus, POLLING_INTERVAL);
    checkStatus(); // Immediate check
}

// A hibapanel eddig a #statusSection TELJES tartalmát lecserélte. A fenti
// statusTitle/progressBar/… konstansok így leválasztott elemekre mutattak: a
// következő job (másik history-elem) állapota láthatatlanul frissült, a régi
// job hibapanele maradt kint — a „Újra feldolgozás" gombja a RÉGI jobot
// indította volna újra —, és a Mégse gomb végleg eltűnt. Most a panel csak
// FÉLRETESZI az eredeti elemeket, és minden új követés (startPolling)
// visszarakja őket: ugyanazokat, így a konstansok és az eseménykezelők is
// érvényesek maradnak. (Funkció-ellenőrzés, 4/12.)
let _parkedStatus = null;

function showStatusError(status, jobId, canRetry = true) {
    if (!_parkedStatus) {
        _parkedStatus = document.createDocumentFragment();
        while (statusSection.firstChild) _parkedStatus.appendChild(statusSection.firstChild);
    }
    statusSection.innerHTML = `
        <div class="error-panel">
            <h3>❌ Hiba a feldolgozás során</h3>
            <p>${esc(status.error || status.detail || 'Ismeretlen hiba történt.')}</p>
            <div class="error-panel-actions">
                ${canRetry ? `<button onclick="retryJob('${jobId}')" class="btn btn-accent">🔄 Újra feldolgozás (hibás törlése)</button>` : ''}
                <button onclick="deleteJob('${jobId}', event)" class="btn btn-secondary">🗑 Törlés</button>
            </div>
        </div>
    `;
}

function restoreStatusSection() {
    if (!_parkedStatus) return;
    statusSection.replaceChildren(_parkedStatus);
    _parkedStatus = null;
}

async function checkStatus() {
    if (!currentJobId) return;

    try {
        const res = await fetch(`${API_URL}/status/${currentJobId}`);
        if (res.status === 404) {
            // A job már nincs a szerveren (törölték, vagy a lomtárból
            // lejárt): eddig a lap örökké pollozott egy üres állapotra.
            clearInterval(pollTimer);
            showStatusError({ detail: 'Ez a feladat már nem létezik a szerveren (törölték, vagy lejárt a megőrzési ideje).' }, currentJobId, false);
            return;
        }
        const status = await res.json();

        updateStatusUI(status);
        lastStatus = status;

        if (status.job_mode) currentJobMode = status.job_mode;

        if (status.stage === 'edit_ready') {
            clearInterval(pollTimer);
            loadSegments();
            statusSection.classList.add('hidden');
            editorSection.classList.remove('hidden');
            if (currentJobMode === 'subtitles_only') {
                generateDubBtn.classList.add('hidden');
                exportSubtitlesBtn.classList.remove('hidden');
            } else {
                generateDubBtn.classList.remove('hidden');
                exportSubtitlesBtn.classList.add('hidden');
            }
            const retranslateBtn = document.getElementById('retranslateBtn');
            retranslateBtn.textContent = "Fordítás újra";
            retranslateBtn.disabled = false;
        } else if (status.stage === 'done') {
            clearInterval(pollTimer);
            statusSection.classList.add('hidden');
            showDownloads(currentJobId);
        } else if (status.stage === 'error') {
            clearInterval(pollTimer);
            showStatusError(status, currentJobId);
        }
    } catch (e) {
        console.error("Polling error", e);
    }
}

async function retryJob(jobId) {
    // Az eredeti elemek vissza (a saját jelölése más id-kat hordott, ezért a
    // konstansokon át SOHA nem frissült, és a Mégse gombot is elvitte), rajtuk
    // az átmeneti szöveg.
    restoreStatusSection();
    updateStatusUI({ stage: 'retry', progress: 0, detail: 'Korábbi mentett adatok betöltése...' });
    statusTitle.textContent = '🔄 Újraindítás folyamatban...';
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
    statusSection.classList.remove('hidden');
    uploadSection.classList.add('hidden');
    editorSection.classList.add('hidden');
    downloadSection.classList.add('hidden');
    retryJob(jobId);
};

// ... existing code down to renderHistory ...

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
    const history = JSON.parse(localStorage.getItem('dubJobs') || '[]');
    const filtered = history.filter(job => _matchHistoryDate(job.date) && (typeof isInCurrentWorkspace !== 'function' || isInCurrentWorkspace(job.ws)));

    if (filtered.length === 0) {
        const msg = historyDateFilter === 'all' ? 'Nincs korábbi feladat' : (historyDateFilter === 'today' ? 'Ma még nincs feltöltés.' : 'Tegnap nincs feltöltés.');
        container.innerHTML = `<div class="empty-history">${msg}</div>`;
        return;
    }

    _renderAppHistoryItems(container, filtered);
    const enriched = await _enrichHistoryWithStage(filtered);
    _renderAppHistoryItems(container, enriched);
}

function _renderAppHistoryItems(container, items) {
    container.innerHTML = "";
    items.forEach(job => {
        const div = document.createElement('div');
        div.className = 'job-item';
        if (isDownloaded(job.id)) div.classList.add('downloaded');
        if (job.id === currentJobId) div.classList.add('active');
        if (job._stage === 'error') div.classList.add('stage-error');
        else if (job._stage === 'done') div.classList.add('stage-done');

        const retryBtn = (job._stage === 'error' || job._stage === 'done')
            ? `<button class="delete-btn" onclick="retryJobFromHistory('${job.id}', event)" title="Újra feldolgozás">🔄</button>`
            : '';

        div.innerHTML = `
            <div class="job-info grow" onclick="loadJobFromHistory('${job.id}')">
                <div class="truncate">
                    ${esc(job.name)}
                </div>
                <div class="job-date">🕐 ${_fmtJobDate(job.date)}</div>
            </div>
            <div class="row-actions">
                ${retryBtn}
                <button class="delete-btn" onclick="deleteJob('${job.id}', event)" title="Törlés">🗑️</button>
            </div>
        `;
        container.appendChild(div);
    });
}

function loadJobFromHistory(jobId) {
    // Másik job megnyitása a mentetlen szerkesztést csendben eldobná. (UI-18)
    if (hasUnsavedChanges() && jobId !== currentJobId &&
        !confirm('A szerkesztésed még nincs mentve. Eldobod, és megnyitod a másik feladatot?')) return;
    currentJobId = jobId;
    statusSection.classList.remove('hidden');
    uploadSection.classList.add('hidden');
    // startPolling, nem egyszeri checkStatus: egy még FUTÓ job különben egy
    // pillanatképen ragadt — sosem frissült, és a szerkesztő sem nyílt meg,
    // amikor elkészült. (A felirat- és a leirat-lap is így teszi.)
    startPolling();
    renderHistory();
}

async function deleteJob(jobId, event) {
    if (event) event.stopPropagation(); // prevent click bubbling to loadJob

    if (!confirm("Biztosan törlöd ezt a feladatot? Minden hozzá tartozó fájl (feltöltés, szinkron, felirat, előzmények) véglegesen eltűnik.")) {
        return;
    }

    // Backend-first: csak akkor töröljük a lokális history-t, ha a szerver
    // tényleg törölte. A korábbi "csendes console.warn" miatt a user azt
    // látta, hogy eltűnt, pedig a szerveren maradt — így ugyanaz a név nem
    // volt újra feltölthető, és törölni sem tudta.
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

    // Delete from LocalStorage
    let history = JSON.parse(localStorage.getItem('dubJobs') || '[]');
    history = history.filter(j => j.id !== jobId);
    localStorage.setItem('dubJobs', JSON.stringify(history));

    // Update UI
    if (currentJobId === jobId) {
        currentJobId = null;
        if (pollTimer) clearInterval(pollTimer);
        restoreStatusSection();
        statusSection.classList.add('hidden');
        uploadSection.classList.remove('hidden');
    }
    renderHistory();
}

// ---- RESTORED download/save helpers (deleted by e76f86d, called by dub.html buttons) ----
function getBaseName(name) {
    if (!name) return "dubbed";
    return name.replace(/\.[^/.]+$/, "");
}

function downloadFile(filename) {
    if (!window.currentDownloadJobId) {
        alert('No job selected');
        return;
    }

    // Determine download name based on requested filename and original job name
    let downloadName = filename;

    // Find job name from history if available (as we don't have it globally stored easily otherwise)
    // Actually we shoud have stored it in global var
    let jobName = "dubbed";

    // Try to get from local storage history
    const history = JSON.parse(localStorage.getItem('dubJobs') || '[]');
    const job = history.find(j => j.id === window.currentDownloadJobId);
    if (job && job.name) {
        jobName = getBaseName(job.name);
    }

    // Map internal filenames to user-friendly names with original prefix
    if (filename === 'dubbed.mp4') {
        downloadName = `${jobName}.mp4`;
    } else if (filename === 'dubbed_with_bg.mp4') {
        downloadName = `${jobName}_with_bg.mp4`;
    } else if (filename === 'voice_only.wav') {
        downloadName = `${jobName}_voice.wav`;
    } else if (filename === 'mix.wav') {
        downloadName = `${jobName}_mix.wav`;
    } else if (filename === 'original_audio.wav') {
        downloadName = `${jobName}_original.wav`;
    } else if (filename === 'dubbed.vtt') {
        downloadName = `${jobName}.vtt`;
    } else if (filename === 'en.srt') {
        downloadName = `${jobName}.srt`;
    } else if (filename === 'segments.json') {
        downloadName = `${jobName}.json`;
    }

    // Add cache buster and download_name param
    const url = `${API_URL}/download/${window.currentDownloadJobId}/${filename}?t=${Date.now()}&download_name=${encodeURIComponent(downloadName)}`;

    // Standard download approach: create link, set download attr, click it
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName; // This is a hint to browser, server Header takes precedence usually
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

function downloadFileByName(filename) {
    // Some files have dynamic base names – look up the VTT with correct prefix
    if (filename === 'en.vtt') {
        const history = JSON.parse(localStorage.getItem('dubJobs') || '[]');
        const job = history.find(j => j.id === window.currentDownloadJobId);
        const base = job && job.name ? getBaseName(job.name) : 'video';
        downloadFile(`${base}_DUB_EN.vtt`);
    } else {
        downloadFile(filename);
    }
}

function downloadBilingualVtt() {
    // The bilingual VTT has a dynamic name – find it or fall back to the known pattern
    const history = JSON.parse(localStorage.getItem('dubJobs') || '[]');
    const job = history.find(j => j.id === window.currentDownloadJobId);
    const base = job && job.name ? getBaseName(job.name) : 'video';
    downloadFile(`${base}_DUB_EN_bilingual.vtt`);
}

window.saveToLocalDisk = async function () {
    if (!window.currentDownloadJobId) {
        alert('No job selected');
        return;
    }

    const btn = document.getElementById('saveToDiskBtn');
    const originalText = btn.textContent;
    btn.textContent = "Saving...";
    btn.disabled = true;

    try {
        const response = await fetch(`${API_URL}/export_local/${window.currentDownloadJobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                include_video: true,
                include_vtt: true,
                include_wav: false
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Save failed');
        }

        const data = await response.json();
        if (data.ok) {
            const paths = data.saved_paths.join('\n');
            alert(`Success! Files saved to:\n${paths}`);
        } else {
            alert('Save completed but no files were written (check logs).');
        }

    } catch (error) {
        alert('Failed to save to disk: ' + error.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
};

function previewFile(filename) {
    if (!window.currentDownloadJobId) {
        alert('No job selected');
        return;
    }

    const url = `${API_URL}/download/${window.currentDownloadJobId}/${filename}?preview=true`;

    // Open in new window for preview
    window.open(url, '_blank');
}

// Hook into download actions to mark as downloaded
const originalDownload = window.downloadFile;
window.downloadFile = function (filename) {
    if (typeof currentJobId !== 'undefined' && currentJobId) {
        markAsDownloaded(currentJobId);
    }
    originalDownload(filename);
}

const originalSaveLocal = window.saveToLocalDisk;
window.saveToLocalDisk = async function () {
    await originalSaveLocal();
    if (typeof currentJobId !== 'undefined' && currentJobId) {
        markAsDownloaded(currentJobId);
    }
}


// ============================================================================
// RESTORED FUNCTIONS — these 12 functions were deleted from app.js by commit
// e76f86d (the 'unified ... bombproof' refactor removed 377 lines) but their
// references throughout this file were left intact, so app.js threw
// 'X is not defined' at runtime (addToHistory, updateStatusUI, renderSegments,
// showDownloads, loadSegments, isDownloaded, markAsDownloaded, saveSegments,
// exportSubtitles, retranslateSegments, forceStart, loadSubtitleQualityReport).
// The service-worker cache had been masking this by serving a pre-e76f86d copy.
// Restored verbatim from e76f86d~1; all are hoisted function declarations and
// the dependency graph is self-consistent with the current app.js + shared.js.
// ============================================================================

function addToHistory(jobId, name) {
    // We don't really rely on local storage for list anymore if we trust server, 
    // but the app currently uses it. We'll continue using it for "Downloaded" state.
    const history = JSON.parse(localStorage.getItem('dubJobs') || '[]');
    // Avoid dupes
    if (!history.find(j => j.id === jobId)) {
        // ws: a munkaterület-címke (TD-027) — a lista ezzel szűr
        const newEntry = { id: jobId, name: name, date: new Date().toISOString(), ws: (typeof currentWorkspaceLabel === 'function' ? currentWorkspaceLabel() : null) };
        history.unshift(newEntry);
        if (history.length > 30) history.pop();
        localStorage.setItem('dubJobs', JSON.stringify(history));
    }
    renderHistory();
}

function isDownloaded(jobId) {
    let downloaded = JSON.parse(localStorage.getItem('downloadedJobs') || '{}');
    return !!downloaded[jobId];
}

async function loadSegments() {
    const res = await fetch(`${API_URL}/job/${currentJobId}`);
    const data = await res.json();
    segmentsData = data.segments;
    markUnsaved(false);   // frissen a szerverről
    renderSegments();
}

function markAsDownloaded(jobId) {
    let downloaded = JSON.parse(localStorage.getItem('downloadedJobs') || '{}');
    downloaded[jobId] = true;
    localStorage.setItem('downloadedJobs', JSON.stringify(downloaded));
    renderHistory();
}

function renderSegments() {
    segmentsTable.innerHTML = "";

    segmentsData.forEach((seg, index) => {
        const tr = document.createElement('tr');

        const timeTd = document.createElement('td');
        timeTd.textContent = `${seg.start.toFixed(2)} - ${seg.end.toFixed(2)}`;

        const huTd = document.createElement('td');
        const huTextarea = document.createElement('textarea');
        huTextarea.value = seg.hu;
        huTextarea.dataset.index = index;
        huTextarea.placeholder = "Hungarian text...";
        huTextarea.addEventListener('input', function () {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
            segmentsData[index].hu = this.value;
            markUnsaved();
        });
        huTd.appendChild(huTextarea);

        const enTd = document.createElement('td');
        const enTextarea = document.createElement('textarea');
        enTextarea.value = seg.en;
        enTextarea.dataset.index = index;
        enTextarea.placeholder = "English translation...";
        enTextarea.addEventListener('input', function () {
            this.style.height = 'auto';
            this.style.height = (this.scrollHeight) + 'px';
            segmentsData[index].en = this.value;
            markUnsaved();
        });

        enTd.appendChild(enTextarea);

        tr.appendChild(timeTd);
        tr.appendChild(huTd);
        tr.appendChild(enTd);
        segmentsTable.appendChild(tr);

        // Initial resize after append
        setTimeout(() => {
            huTextarea.style.height = 'auto';
            huTextarea.style.height = (huTextarea.scrollHeight) + 'px';
            enTextarea.style.height = 'auto';
            enTextarea.style.height = (enTextarea.scrollHeight) + 'px';
        }, 0);
    });
}

function showDownloads(jobId) {
    downloadSection.classList.remove('hidden');
    window.currentDownloadJobId = jobId;

    // Toggle between subtitle and dub download views
    const subDiv = document.getElementById('subtitleDownloads');
    const dubDiv = document.getElementById('dubDownloads');
    if (currentJobMode === 'subtitles_only') {
        subDiv.classList.remove('hidden');
        dubDiv.classList.add('hidden');
        loadSubtitleQualityReport(jobId);
    } else {
        subDiv.classList.add('hidden');
        dubDiv.classList.remove('hidden');
    }
}

function updateStatusUI(status) {
    statusTitle.textContent = "Job Status: " + status.stage;
    statusBadge.textContent = status.stage;
    statusDetail.textContent = status.detail;
    progressBar.style.width = status.progress + "%";
    // A sáv szélessége csak vizuális; a role="progressbar" értékét külön kell
    // frissíteni, különben a képernyőolvasó végig 0%-ot mond.
    if (progressTrack) progressTrack.setAttribute('aria-valuenow', String(Math.round(status.progress || 0)));

    if (status.stage === 'queued' || status.stage === 'queued_tts' || status.stage === 'extract' || status.stage === 'asr' || status.stage === 'translate' || status.stage === 'tts') {
        forceContainer.classList.remove('hidden');
        // „⚡ Sor elejére": csak adminnak, és csak ha a job tényleg sorban áll,
        // nem az első helyen (a /api/status adja a helyét). A Mégse mindig látszik.
        const canBump = (status.stage === 'queued' || status.stage === 'queued_tts')
            && (status.queue_position || 0) > 1 && isCurrentUserAdmin();
        // Null-guard (DUB-2): retryJob replaces #statusSection.innerHTML, which
        // destroys #forceStartBtn / #cancelJobBtn. The next poll then hit
        // getElementById(...).style on null → TypeError, swallowed by the poll's
        // try/catch, which froze the status UI forever (lastStatus was already
        // set, so the stage-transition block never ran).
        const _fsb = document.getElementById('forceStartBtn');
        if (_fsb) _fsb.style.display = canBump ? 'block' : 'none';
        const _fh = document.getElementById('forceHint');
        if (_fh) _fh.classList.toggle('hidden', !canBump);

        // Always show cancel if running/queued
        const _cjb = document.getElementById('cancelJobBtn');
        if (_cjb) _cjb.style.display = 'block';
    } else {
        forceContainer.classList.add('hidden');
    }
}


// A mentés HTTP-hibáját is hibaként kell kezelni: a fetch csak hálózati
// hibánál dob, egy 500-as vagy 401-es válasznál nem — a gomb eddig ilyenkor
// is sikert jelzett, miközben a szerkesztés nem ért a szerverre. (UI-18)
async function _saveError(res) {
    let detail = `HTTP ${res.status}`;
    try { const b = await res.json(); if (b && b.detail) detail = b.detail; } catch (_) {}
    const err = new Error(detail);
    err.status = res.status;
    return err;
}

// Igazat ad vissza, ha a szerkesztés a szerverre ért — a generálás és az
// export erre vár, mielőtt a mentett fájlból dolgozni kezdene.
async function saveSegments() {
    saveSegmentsBtn.disabled = true;
    saveSegmentsBtn.textContent = "Saving...";
    let ok = false;
    try {
        const res = await fetch(`${API_URL}/job/${currentJobId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ segments: segmentsData })
        });
        if (!res.ok) throw await _saveError(res);
        ok = true;
        markUnsaved(false);
        saveSegmentsBtn.textContent = "Saved";
        setTimeout(() => saveSegmentsBtn.textContent = "Save Changes", 1000);
    } catch (e) {
        saveSegmentsBtn.textContent = "Nincs mentve";
        // 401-nél a shared.js már kiírta a teendőt (belépés egy új lapon).
        if (e.status !== 401) alert("Nem sikerült menteni: " + e.message);
    } finally {
        saveSegmentsBtn.disabled = false;
    }
    return ok;
}

async function exportSubtitles() {
    if (!currentJobId) return;
    // Az export a MENTETT segments.json-ből dolgozik (UI-18).
    if (hasUnsavedChanges() && !(await saveSegments())) return;
    exportSubtitlesBtn.disabled = true;
    exportSubtitlesBtn.textContent = '⏳ Exportálás...';
    try {
        const res = await fetch(`${API_URL}/job/${currentJobId}/export_subtitles`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Export failed');
        }
        editorSection.classList.add('hidden');
        showDownloads(currentJobId);
    } catch (e) {
        alert('Export hiba: ' + e.message);
    } finally {
        exportSubtitlesBtn.disabled = false;
        exportSubtitlesBtn.textContent = '📥 Export Subtitles';
    }
}

async function retranslateSegments() {
    const retranslateBtn = document.getElementById('retranslateBtn');
    retranslateBtn.disabled = true;
    retranslateBtn.textContent = "Fordítás...";

    statusSection.classList.remove('hidden');
    editorSection.classList.add('hidden');

    try {
        const res = await fetch(`${API_URL}/job/${currentJobId}/retranslate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ segments: segmentsData })
        });
        if (!res.ok) throw await _saveError(res);
        // A backend a kapott szegmenseket a sorba állítás ELŐTT elmenti.
        markUnsaved(false);

        // Start polling to wait for completion
        startPolling();
    } catch (e) {
        alert("Failed to retranslate: " + e.message);
        retranslateBtn.textContent = "Fordítás újra";
        retranslateBtn.disabled = false;
        editorSection.classList.remove('hidden');
        statusSection.classList.add('hidden');
    }
}

// „⚡ Sor elejére" (admin): a sorban álló jobot a sor elejére teszi, bármelyik
// szakaszára vár. A futó feladatot nem szakítja meg, a GPU-korlátot sem kerüli
// meg. Eddig „Azonnali indítás" néven a /start-ot hívta force-szal, amit a
// backend figyelmen kívül hagyott — a gomb semmit nem csinált.
async function forceStart() {
    if (!currentJobId) return;

    forceStartBtn.disabled = true;
    try {
        const res = await fetch(`${API_URL}/queue/${currentJobId}/prioritize`, { method: 'POST' });
        if (!res.ok) throw await _saveError(res);
        setTimeout(checkStatus, 300);
    } catch (e) {
        alert("Nem sikerült a sor elejére tenni: " + e.message);
    } finally {
        forceStartBtn.disabled = false;
    }
}

async function loadSubtitleQualityReport(jobId) {
    try {
        const res = await fetch(`${API_URL}/download/${jobId}/subtitles_report.json?preview=true`);
        if (!res.ok) return;
        const report = await res.json();
        const card = document.getElementById('subtitleQualityCard');
        const body = document.getElementById('subtitleQualityBody');
        if (!card || !body) return;
        body.innerHTML = `
            <span>📝 <b>${report.total_cues || '–'}</b> felirat cue</span>
            <span>⏱ Átlag hossz: <b>${report.avg_dur || '–'}s</b></span>
            <span>📏 Átlag chars: <b>${report.avg_chars || '–'}</b></span>
            <span>🔀 Mergek: <b>${report.merges || 0}</b></span>
        `;
        card.classList.remove('hidden');
    } catch (e) { /* silent if no report */ }
}
