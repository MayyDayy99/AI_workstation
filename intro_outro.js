// intro_outro.js — Intro-Outro eszköz logika
const POLL_MS = 2000;
const IO_API = 'api/intro_outro';

const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));

let currentJobId = null;
let pollTimer = null;
let _sseStatus = null;
let _pollTimer_io = null;
let selectedLang = 'hun';
let selectedPreset = 'youtube';
let selectedTheme = 'sajat';
let originalFilename = '';

// True ha a felhasználó a batch listáról érkezett (?job_id=xxx vagy
// ?bulk=...). Ekkor a "Feldolgozás indítása" gomb hatására visszadobjuk a
// batch oldalra, hogy a folyamatos lista mutassa a state-változást — a
// single-mode status view nem kell, mert a batch lista is poll-ol.
let _resumedFromBatch = false;

// Bulk üzemmódban (?bulk=id1,id2,...) az itt felsorolt job-okra alkalmazzuk
// ugyanazt a beállítást. Üres lista = nem bulk mód.
let _bulkJobIds = [];

// --- Batch Mode State ---
let currentMode = 'single';
let batchItems = []; // { file, jobId, lesson, positions: null, status: 'ready' }
let currentBatchIndex = -1; // -1 means global editing, >=0 means item override

let globalPositions = {
    subject: { x: 50, y: 41 },
    lesson:  { x: 50, y: 50 },
    teacher: { x: 50, y: 59 }
};

let previewLocked = true; // Defined missing variable
let positions = JSON.parse(JSON.stringify(globalPositions));

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    // Shared init (shared.js)
    if (typeof initSharedSession === 'function') initSharedSession();
    
    // Determine mode from URL
    const isBatchPage = window.location.pathname.includes('batch_mode') || window.location.pathname.includes('batch');
    console.log("Intro-Outro Pathname:", window.location.pathname, "isBatch:", isBatchPage);
    
    if (isBatchPage) {
        setAppMode('batch');
    } else {
        setAppMode('single');
    }

    // Shared UI initialization
    if (typeof applyOwnerDisplay === 'function') applyOwnerDisplay();
    if (typeof updateHistory === 'function') updateHistory();
    // Monitor is already started inside initSharedSession in shared.js
    
    // Step 1: Upload listeners
    const videoInput = document.getElementById('videoInput');
    const dropZone = document.getElementById('videoDropZone');

    if (videoInput) {
        videoInput.addEventListener('change', e => {
            if (currentMode === 'batch') handleBatchFiles(e.target.files);
            else handleVideoFile(e.target.files[0]);
        });
    }
    
    if (dropZone) {
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', e => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            if (e.dataTransfer.files.length) {
                if (currentMode === 'batch') handleBatchFiles(e.dataTransfer.files);
                else handleVideoFile(e.dataTransfer.files[0]);
            }
        });
    }

    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) nextBtn.addEventListener('click', showConfig);
    
    const startBtn = document.getElementById('startBtn');
    if (startBtn) startBtn.addEventListener('click', startProcessing);

    setupPreviewDrag();

    // Ha a batch listáról ?job_id=xxx-szel jöttünk, ugorjuk át az upload
    // lépést és tegyük az oldalt a config nézetre az adott job-bal.
    _tryResumeFromUrl();
});

// ============================================================
// RESUME FROM BATCH LIST (?job_id=xxx)
// ============================================================
// A batch lista "Beállítás" gombja erre az URL-re navigál:
//     intro_outro.html?job_id=<job_id>
// Ekkor a feltöltés már megtörtént, csak a config + indítás van hátra.
async function _tryResumeFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const bulk = params.get('bulk');
    const jid = params.get('job_id');

    // Bulk: több job-ra ugyanaz a beállítás → ugrunk a config-ra,
    // a "Feldolgozás" gombra mind enqueue-ődik, aztán visszadobunk
    // a batch listára.
    if (bulk) {
        const ids = bulk.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length === 0) return;
        _bulkJobIds = ids;
        _resumedFromBatch = true;

        const titleEl = document.getElementById('uploadTitle');
        if (titleEl) titleEl.textContent = `⚙ ${ids.length} videó közös beállítása`;

        // Skip upload step → straight to config
        showSection('configSection');
        setStep(2);
        if (typeof updatePreviewText === 'function') updatePreviewText();
        if (typeof _updatePosInputs === 'function') _updatePosInputs();
        return;
    }

    if (!jid) return;

    try {
        const r = await fetch(`${IO_API}/status/${jid}`);
        if (!r.ok) {
            console.warn('Resume: job not accessible:', jid);
            return;
        }
        const status = await r.json();
        currentJobId = jid;
        _resumedFromBatch = true;

        // metadata.json-ből az eredeti fájlnév — szebb fejléc-szöveghez
        try {
            const job_dir_resp = await fetch(`api/job/${jid}/metadata`);
            if (job_dir_resp.ok) {
                const meta = await job_dir_resp.json();
                originalFilename = meta.original_filename || '';
                const titleEl = document.getElementById('uploadTitle');
                if (titleEl && originalFilename) titleEl.textContent = '✅ Beállítás: ' + originalFilename;
            }
        } catch (_) { /* nem kritikus */ }

        const stage = status.stage || 'uploaded';
        if (stage === 'queued' || stage === 'processing') {
            showSection('statusSection');
            setStep(3);
            startPolling();
        } else if (stage === 'done') {
            // Már kész — irány vissza a batch listára, ott letölthető
            window.location.href = 'intro_outro_batch.html';
        } else {
            // 'uploaded', 'error' vagy bármi más → engedjük konfigurálni
            showConfig();
        }
    } catch (e) {
        console.error('_tryResumeFromUrl failed:', e);
    }
}
window._tryResumeFromUrl = _tryResumeFromUrl;

function setupPreviewDrag() {
    let draggingElement = null;
    let offset = { x: 0, y: 0 };

    function startDrag(e) {
        if (previewLocked) return;
        const target = e.target.closest('.preview-text');
        if (!target) return;

        draggingElement = target;
        draggingElement.style.transition = 'none'; // Disable transition while dragging
        draggingElement.style.zIndex = '1000';
        draggingElement.style.filter = 'drop-shadow(0 0 10px rgba(0,0,0,0.5))';
        draggingElement.classList.add('dragging');

        const rect = draggingElement.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        const clientY = e.clientY || (e.touches && e.touches[0].clientY);
        
        offset.x = clientX - rect.left - rect.width / 2;
        offset.y = clientY - rect.top - rect.height / 2;

        e.preventDefault();
    }

    function doDrag(e) {
        if (!draggingElement) return;

        const canvas = document.getElementById('previewCanvas');
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();

        const clientX = e.clientX || (e.touches && e.touches[0].clientX);
        const clientY = e.clientY || (e.touches && e.touches[0].clientY);

        // Calculate position in percentages relative to canvas
        let newX = ((clientX - rect.left - offset.x) / rect.width) * 100;
        let newY = ((clientY - rect.top - offset.y) / rect.height) * 100;

        newX = Math.max(0, Math.min(100, newX));
        newY = Math.max(0, Math.min(100, newY));

        draggingElement.style.left = newX + '%';
        draggingElement.style.top = newY + '%';

        const key = draggingElement.dataset.key;
        if (positions && key) {
            positions[key] = { x: newX, y: newY };
        }
        // Drag közben élőben frissítjük a koordináta-inputokat is, hogy a
        // felhasználó pontosan lássa a pillanatnyi pozíciót pixel/%-ban.
        if (typeof _updatePosInputs === 'function') _updatePosInputs();
    }

    function stopDrag() {
        if (draggingElement) {
            draggingElement.style.transition = '';
            draggingElement.style.zIndex = '';
            draggingElement.style.filter = '';
            draggingElement.classList.remove('dragging');
            draggingElement = null;
        }
    }

    // Mouse Events
    document.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', doDrag);
    document.addEventListener('mouseup', stopDrag);

    // Touch Events for mobile support
    document.addEventListener('touchstart', startDrag, { passive: false });
    document.addEventListener('touchmove', doDrag, { passive: false });
    document.addEventListener('touchend', stopDrag);
}

// ============================================================
// POSITION TOOLBAR (középre, vonalzó, pixel/% pontos beállítás)
// ============================================================
// A backend ProcessingConfig opening_positions mezője % értékeket vár
// (0-100), így a belső reprezentáció (positions{}) %-ban marad. A px
// megjelenítés csak a UI-en — konverzió a render felbontás alapján.
// Az intro/outro mindig 16:9 1920×1080-ra renderel (lásd a
// determine_target_from_main 16:9 lock-ját a normalize.py-ben).
const _RENDER_W = 1920;
const _RENDER_H = 1080;
const _DEFAULT_POSITIONS = {
    subject: { x: 50, y: 41 },
    lesson:  { x: 50, y: 50 },
    teacher: { x: 50, y: 59 }
};
const _POS_KEYS = ['subject', 'lesson', 'teacher'];

function _applyPositionToDom(key) {
    const elId = 'preview' + key.charAt(0).toUpperCase() + key.slice(1);
    const el = document.getElementById(elId);
    if (!el || !positions[key]) return;
    el.style.left = positions[key].x + '%';
    el.style.top  = positions[key].y + '%';
}

function _updatePosInputs() {
    const unitSel = document.getElementById('posUnit');
    const unit = unitSel ? unitSel.value : 'pct';
    for (const key of _POS_KEYS) {
        const cap = key.charAt(0).toUpperCase() + key.slice(1);
        const xEl = document.getElementById('pos' + cap + 'X');
        const yEl = document.getElementById('pos' + cap + 'Y');
        if (!xEl || !yEl || !positions[key]) continue;
        let x = positions[key].x;
        let y = positions[key].y;
        if (unit === 'px') {
            x = Math.round(x / 100 * _RENDER_W);
            y = Math.round(y / 100 * _RENDER_H);
        } else {
            // 1 tizedes pontosság %-ban — elég pontos a UI-hoz, nem zsúfolt
            x = Math.round(x * 10) / 10;
            y = Math.round(y * 10) / 10;
        }
        xEl.value = x;
        yEl.value = y;
    }
}
window._updatePosInputs = _updatePosInputs;

window.centerAllTexts = function() {
    for (const key of _POS_KEYS) {
        if (!positions[key]) continue;
        positions[key].x = 50;
        _applyPositionToDom(key);
    }
    _updatePosInputs();
};

window.resetPositions = function() {
    for (const key of _POS_KEYS) {
        positions[key] = { ..._DEFAULT_POSITIONS[key] };
        _applyPositionToDom(key);
    }
    _updatePosInputs();
};

window.toggleRuler = function() {
    const cb = document.getElementById('rulerToggle');
    const on = cb ? cb.checked : true;
    const display = on ? 'block' : 'none';
    const h = document.getElementById('rulerHorizontal');
    const v = document.getElementById('rulerVertical');
    if (h) h.style.display = display;
    if (v) v.style.display = display;
};

window.changePosUnit = function() {
    _updatePosInputs();
};

window.onPosInputChange = function(key, axis, raw) {
    if (!positions[key]) return;
    const unitSel = document.getElementById('posUnit');
    const unit = unitSel ? unitSel.value : 'pct';
    let pct = parseFloat(raw);
    if (isNaN(pct)) {
        _updatePosInputs();  // visszaállítja a régi értéket
        return;
    }
    if (unit === 'px') {
        pct = axis === 'x' ? (pct / _RENDER_W) * 100 : (pct / _RENDER_H) * 100;
    }
    pct = Math.max(0, Math.min(100, pct));
    positions[key][axis] = pct;
    _applyPositionToDom(key);
    _updatePosInputs();
};

window.togglePreviewLock = function() {
    previewLocked = !previewLocked;
    const btn = document.getElementById('previewLockBtn');
    if (btn) {
        btn.innerText = previewLocked ? '🔒' : '🔓';
        btn.title = previewLocked ? 'Pozíció zárolásának feloldása' : 'Pozíciók mentése és zárolása';
        btn.style.filter = previewLocked ? 'grayscale(100%)' : 'none';
        btn.style.transform = previewLocked ? 'scale(1)' : 'scale(1.2)';
    }
    
    const texts = document.querySelectorAll('.preview-text');
    texts.forEach(t => {
        t.style.cursor = previewLocked ? 'default' : 'grab';
        t.style.pointerEvents = previewLocked ? 'none' : 'auto'; // CRITICAL: enable pointer events when unlocked
    });
    
    console.log("Preview Locked:", previewLocked);
};

function setAppMode(mode) {
    currentMode = mode;
    console.log("App Mode detected:", mode);
    
    // Reset state
    currentJobId = null;
    batchItems = [];
    currentBatchIndex = -1;

    const fileList = document.getElementById('fileListContainer');
    if (fileList) fileList.classList.add('hidden');
    
    const nextBtn = document.getElementById('nextBtn');
    if (nextBtn) nextBtn.disabled = true;

    const videoInput = document.getElementById('videoInput');
    if (videoInput) videoInput.value = '';
}
window.setAppMode = setAppMode;

function filenameToTitle(filename) {
    return filename.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
}

function handleBatchFiles(files) {
    if (!files.length) return;
    batchItems = Array.from(files).map(file => ({
        file: file,
        jobId: null,
        lesson: filenameToTitle(file.name),
        subject: null, // Override for subject
        teacher: null, // Override for teacher
        positions: null, // Override for positions
        status: 'ready'
    }));
    
    const list = document.getElementById('selectedFilesList');
    list.innerHTML = '';
    batchItems.forEach(item => {
        const li = document.createElement('li');
        li.innerText = `📄 ${item.file.name}`;
        list.appendChild(li);
    });
    document.getElementById('fileListContainer').classList.remove('hidden');
    document.getElementById('nextBtn').disabled = false;
}

// ============================================================
// UPLOAD
// ============================================================
async function handleVideoFile(file) {
    if (!file) return;
    // Dedup: feltöltés előtt megnézzük, van-e már azonos fájl (fail-open).
    if (window.DedupUpload && (await DedupUpload.guard(file)) === 'skip') {
        const t = document.getElementById('uploadTitle');
        if (t) t.textContent = 'Kihagyva (már feltöltve): ' + file.name;
        return;
    }
    console.log("Handling single video file:", file.name);
    
    const nameEl = document.getElementById('uploadTitle');
    const dz = document.getElementById('videoDropZone');
    const nextBtn = document.getElementById('nextBtn');
    
    if (nameEl) nameEl.textContent = '🚀 Feltöltés: ' + file.name + '...';
    if (dz) dz.classList.add('loading');
    if (nextBtn) nextBtn.disabled = true;
    
    originalFilename = file.name;

    const owner = (typeof getOwner === 'function') ? getOwner() : 'default';
    const formData = new FormData();
    formData.append('file', file);

    try {
        const url = `${IO_API}/upload?owner=${encodeURIComponent(owner)}`;
        console.log("Fetching upload URL:", url);
        const res = await fetch(url, { method: 'POST', body: formData });
        
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Feltöltés sikertelen (Szerver hiba)');
        }
        
        const data = await res.json();
        currentJobId = data.job_id;
        console.log("Upload Success! Job ID:", currentJobId);
        
        if (nameEl) nameEl.textContent = '✅ Feltöltve: ' + file.name;
        if (nextBtn) nextBtn.disabled = false;
        
        if (typeof saveJobToHistory === 'function') saveJobToHistory(currentJobId, file.name);
    } catch (e) {
        console.error("Upload Error:", e);
        if (nameEl) nameEl.textContent = '❌ Hiba: ' + e.message;
    } finally {
        if (dz) dz.classList.remove('loading');
    }
}

// ============================================================
// CONFIGURE
// ============================================================
async function showConfig() {
    if (currentMode === 'batch') {
        const uploadSection = document.getElementById('uploadSection');
        // Add a temporary progress info
        const progDiv = document.createElement('div');
        progDiv.id = 'batchUploadProgress';
        progDiv.style.marginTop = '20px';
        progDiv.innerHTML = `
            <p style="font-size: 0.8rem; color: var(--text-secondary);">Fájlok előkészítése... <span id="batchUploadCount">0</span>/${batchItems.length}</p>
            <div class="progress-bar" style="height:8px; background:var(--bg-dark); border-radius:4px; overflow:hidden;">
                <div id="batchUploadFill" class="progress-fill" style="width: 0%; height:100%; background:var(--accent); transition: width 0.3s;"></div>
            </div>
        `;
        uploadSection.appendChild(progDiv);
        
        for (let i = 0; i < batchItems.length; i++) {
            // Dedup: a duplikátumokat kihagyjuk a batch feltöltésből (fail-open).
            if (window.DedupUpload && (await DedupUpload.guard(batchItems[i].file)) === 'skip') {
                batchItems[i].skipped = true;
                continue;
            }
            const formData = new FormData();
            formData.append('file', batchItems[i].file);
            const owner = getOwner() || 'default';
            try {
                const res = await fetch(`${IO_API}/upload?owner=${encodeURIComponent(owner)}`, {
                    method: 'POST', body: formData
                });
                if (res.ok) {
                    const data = await res.json();
                    batchItems[i].jobId = data.job_id;
                    saveJobToHistory(data.job_id, batchItems[i].file.name);
                }
                const pct = ((i + 1) / batchItems.length) * 100;
                document.getElementById('batchUploadFill').style.width = pct + '%';
                document.getElementById('batchUploadCount').innerText = i+1;
            } catch (err) {
                console.error("Batch upload failed for item", i, err);
            }
        }
        renderBatchTable();
        document.getElementById('batchTableContainer').classList.remove('hidden');
        progDiv.remove();
    }

    showSection('configSection');
    setStep(2);
    updatePreviewText();
    // Pozíció toolbar input mezőinek kitöltése a meglévő positions{}-ből.
    if (typeof _updatePosInputs === 'function') _updatePosInputs();
}

function setLang(lang) {
    selectedLang = lang;
    document.getElementById('langHun').classList.toggle('active', lang === 'hun');
    document.getElementById('langEng').classList.toggle('active', lang === 'eng');
}
window.setLang = setLang;

function setPreset(preset) {
    selectedPreset = preset;
    document.querySelectorAll('.preset-pill[data-preset]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === preset);
    });
}
window.setPreset = setPreset;

function setTheme(theme) {
    selectedTheme = theme;
    document.querySelectorAll('#brandToggleContainer .preset-pill').forEach(b => {
        b.classList.toggle('active', b.dataset.theme === theme);
    });
    
    const openingContainer = document.getElementById('openingToggleContainer');
    if (theme === 'custom') {
        if (openingContainer) openingContainer.style.display = 'none';
        const off = document.getElementById('openingTextsContainer'); if(off) off.classList.add('hidden');
        const cuf = document.getElementById('customUploadContainer'); if(cuf) cuf.classList.remove('hidden');
    } else {
        if (openingContainer) openingContainer.style.display = 'flex';
        const cuf = document.getElementById('customUploadContainer'); if(cuf) cuf.classList.add('hidden');
        toggleOpeningFields();
    }
}
window.setTheme = setTheme;

function toggleOpeningFields() {
    if (selectedTheme === 'custom') return;
    const chk = document.getElementById('hasOpeningCheck');
    const isChecked = chk ? chk.checked : false;
    const flds = document.getElementById('openingTextsContainer');
    if(flds) {
        if (isChecked) {
            flds.classList.remove('hidden');
        } else {
            flds.classList.add('hidden');
        }
    }
}
window.toggleOpeningFields = toggleOpeningFields;

// ============================================================
// VISUAL PREVIEW & DRAG LOGIC
// ============================================================
window.updatePreviewText = function(source = 'input') {
    let subject = '';
    let lesson = '';
    let teacher = '';

    if (currentMode === 'batch') {
        if (currentBatchIndex >= 0) {
            const item = batchItems[currentBatchIndex];
            
            // Sync from main inputs to item if typing
            if (source === 'input') {
                const subIn = document.getElementById('openingSubject');
                const lesIn = document.getElementById('openingLesson');
                const teaIn = document.getElementById('openingTeacher');
                
                if (subIn) item.subject = subIn.value;
                if (lesIn) {
                    item.lesson = lesIn.value;
                    const rowTextarea = document.querySelector(`#batchTableBody tr:nth-child(${currentBatchIndex + 1}) textarea`);
                    if (rowTextarea) rowTextarea.value = lesIn.value;
                }
                if (teaIn) item.teacher = teaIn.value;
            }

            subject = item.subject !== null ? item.subject : (document.getElementById('openingSubject').value || 'Tárgy címe');
            lesson = item.lesson;
            teacher = item.teacher !== null ? item.teacher : (document.getElementById('openingTeacher').value || 'Oktató neve');
            
            if (!item.positions) {
                item.positions = JSON.parse(JSON.stringify(globalPositions));
            }
            positions = item.positions;
        } else {
            // Global mode
            subject = document.getElementById('openingSubject').value || 'Tárgy címe';
            lesson = document.getElementById('openingLesson').value || '[Lecke címe]';
            teacher = document.getElementById('openingTeacher').value || 'Oktató neve';
            positions = globalPositions;
        }
    } else {
        // Single mode
        subject = document.getElementById('openingSubject').value || 'Tárgy címe';
        lesson = document.getElementById('openingLesson').value || 'Fejezet / Lecke címe';
        teacher = document.getElementById('openingTeacher').value || 'Oktató neve';
    }

    document.getElementById('previewSubject').innerText = subject;
    document.getElementById('previewLesson').innerText = lesson;
    document.getElementById('previewTeacher').innerText = teacher;

    // Apply positions
    ['subject', 'lesson', 'teacher'].forEach(key => {
        const el = document.getElementById('preview' + key.charAt(0).toUpperCase() + key.slice(1));
        const pos = positions[key];
        if (el && pos) {
            el.style.left = pos.x + '%';
            el.style.top = pos.y + '%';
        }
    });
};

window.togglePreviewLock = function() {
    previewLocked = !previewLocked;
    const btn = document.getElementById('previewLockBtn');
    const hint = document.getElementById('previewHint');
    const texts = document.querySelectorAll('.preview-text');
    
    if (previewLocked) {
        btn.innerText = '🔒';
        btn.style.filter = 'grayscale(100%)';
        btn.title = 'Pozíció zárolásának feloldása';
        hint.innerText = 'Kattints a lakatra a szövegek szabad húzásához!';
        texts.forEach(t => t.style.pointerEvents = 'none');
    } else {
        btn.innerText = '🔓';
        btn.style.filter = 'none';
        btn.title = 'Pozíció zárolása';
        hint.innerText = 'Húzd a szövegeket a kívánt helyre (kattints a lakatra a rögzítéshez)!';
        texts.forEach(t => { t.style.pointerEvents = 'auto'; t.style.cursor = 'grab'; });
    }
};

// Global listeners moved to setupPreviewDrag for better encapsulation

// ============================================================
// PROCESSING
// ============================================================
async function startProcessing() {
    // Bulk: a batch listáról jött több job — ugyanazt a beállítást alkalmazzuk
    // mindegyikre, majd vissza a batch listára.
    if (_bulkJobIds.length > 0) {
        await _startBulkProcessing();
        return;
    }

    if (currentMode === 'batch') {
        startBatchProcessing();
        return;
    }

    if (!currentJobId) return;
    const btn = document.getElementById('startBtn');
    btn.disabled = true;
    btn.textContent = 'Indítás...';
    showSection('statusSection');
    setStep(3);

    const loudness = document.getElementById('loudnessCheck').checked;
    
    let customIntroRes = null, customOutroRes = null;
    if (selectedTheme === 'custom') {
        const iFile = document.getElementById('customIntroInput').files[0];
        const oFile = document.getElementById('customOutroInput').files[0];
        try {
            if (iFile) {
                const fd = new FormData(); fd.append('file', iFile);
                const r = await fetch(`${IO_API}/upload-asset/${currentJobId}?type=intro`, {method:'POST', body:fd});
                if(r.ok) { const d = await r.json(); customIntroRes = d.filename; }
            }
            if (oFile) {
                const fd = new FormData(); fd.append('file', oFile);
                const r = await fetch(`${IO_API}/upload-asset/${currentJobId}?type=outro`, {method:'POST', body:fd});
                if(r.ok) { const d = await r.json(); customOutroRes = d.filename; }
            }
        } catch(e) {
            console.error(e);
        }
    }
    
    const hasOpening = document.getElementById('hasOpeningCheck') ? document.getElementById('hasOpeningCheck').checked : false;
    const openingTexts = (hasOpening && selectedTheme !== 'custom') ? {
        subject: document.getElementById('openingSubject') ? document.getElementById('openingSubject').value : '',
        lesson: document.getElementById('openingLesson') ? document.getElementById('openingLesson').value : '',
        teacher: document.getElementById('openingTeacher') ? document.getElementById('openingTeacher').value : ''
    } : {};

    try {
        const res = await fetch(`${IO_API}/process/${currentJobId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                language: selectedLang,
                preset: selectedPreset,
                loudness: loudness,
                theme: selectedTheme,
                has_opening: hasOpening && selectedTheme !== 'custom',
                opening_texts: openingTexts,
                opening_positions: positions, // We always pass positions now
                custom_intro_filename: customIntroRes,
                custom_outro_filename: customOutroRes
            })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Indítási hiba');
        }
        // Ha a batch listáról jöttünk, dobjuk vissza a felhasználót oda.
        // A batch lista poll-ol, így onnan látja a state-átmeneteket.
        if (_resumedFromBatch) {
            window.location.href = 'intro_outro_batch.html';
            return;
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

// Bulk: a batch listáról ?bulk=id1,id2,... -szel jött N db job → ugyanazt a
// config-ot alkalmazzuk mindenre, enqueue-eljük, vissza a batch listára. A
// per-job progress követés a batch lista pollingjával történik (5 s) — ezért
// itt nem szükséges a régi pollJobSync ágazat.
async function _startBulkProcessing() {
    const btn = document.getElementById('startBtn');
    const total = _bulkJobIds.length;
    btn.disabled = true;
    btn.textContent = `Feldolgozás indítása (${total})…`;

    const loudness = document.getElementById('loudnessCheck').checked;
    const hasOpening = document.getElementById('hasOpeningCheck')
        ? document.getElementById('hasOpeningCheck').checked : false;
    const openingTexts = (hasOpening && selectedTheme !== 'custom') ? {
        subject: document.getElementById('openingSubject') ? document.getElementById('openingSubject').value : '',
        lesson:  document.getElementById('openingLesson')  ? document.getElementById('openingLesson').value  : '',
        teacher: document.getElementById('openingTeacher') ? document.getElementById('openingTeacher').value : ''
    } : {};

    // Custom intro/outro asset-ek párhuzamosan minden job-ra (a /upload-asset
    // endpoint per-job tárolja). A korábbi sequential ciklus N×fájlméret
    // időt vett igénybe — Promise.allSettled-del egyetlen "leglassabb"
    // upload ideje az egész.
    let customIntroName = null, customOutroName = null;
    if (selectedTheme === 'custom') {
        const iFile = document.getElementById('customIntroInput')?.files?.[0];
        const oFile = document.getElementById('customOutroInput')?.files?.[0];

        const uploadAsset = async (jid, file, type) => {
            try {
                const fd = new FormData(); fd.append('file', file);
                const r = await fetch(`${IO_API}/upload-asset/${jid}?type=${type}`, { method:'POST', body:fd });
                if (r.ok) { const d = await r.json(); return d.filename; }
            } catch (e) {
                console.warn('Custom asset upload failed for', jid, type, e);
            }
            return null;
        };

        const assetJobs = [];
        for (const jid of _bulkJobIds) {
            if (iFile) assetJobs.push(uploadAsset(jid, iFile, 'intro').then(n => { if (n) customIntroName = n; }));
            if (oFile) assetJobs.push(uploadAsset(jid, oFile, 'outro').then(n => { if (n) customOutroName = n; }));
        }
        if (assetJobs.length > 0) await Promise.allSettled(assetJobs);
    }

    const payload = {
        language: selectedLang,
        preset: selectedPreset,
        loudness: loudness,
        theme: selectedTheme,
        has_opening: hasOpening && selectedTheme !== 'custom',
        opening_texts: openingTexts,
        opening_positions: positions,
        custom_intro_filename: customIntroName,
        custom_outro_filename: customOutroName
    };

    // /process hívások FIRE-AND-FORGET módban: a fetch-et nem await-eljük,
    // hanem `keepalive: true`-val a böngésző-tab navigációja után is
    // végigfut. A user a config-oldalon 15+ fájlnál korábban 12-20 másodpercig
    // ragadt (await Promise.allSettled a 40 enqueue-ra), holott a backend
    // adatait nincs is szüksége a frontendnek visszatérítve — a batch lista
    // polling-ja (5 mp) úgyis felfedezi az új 'queued' state-eket.
    //
    // `keepalive: true` követelmények: ≤ 64 KB request body (a payload JSON
    // pár száz byte → bőven elég). A részleges hibákat a batch lista mutatja
    // 'error' state-tel; nincs alert, az UI-ot nem blokkoljuk.
    for (const jid of _bulkJobIds) {
        try {
            fetch(`${IO_API}/process/${jid}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                keepalive: true,
                credentials: 'same-origin',
            }).catch((e) => console.warn('bulk enqueue fail', jid, e));
        } catch (e) {
            console.warn('bulk enqueue threw', jid, e);
        }
    }

    // Azonnali redirect — a hálózati request-ek a háttérben végigfutnak.
    window.location.href = 'intro_outro_batch.html';
}

async function startBatchProcessing() {
    const btn = document.getElementById('startBtn');
    btn.disabled = true;
    showSection('statusSection');
    setStep(3);

    const loudness = document.getElementById('loudnessCheck').checked;
    const hasOpening = document.getElementById('hasOpeningCheck') ? document.getElementById('hasOpeningCheck').checked : false;

    // A folyamatos queue-lista inicializálása: minden batchItem egy kártya
    // a #batchQueueList-ben, kezdetben "Sorban áll" állapotban. A feldolgozás
    // közben sorról sorra frissítjük a státuszt — ez adja a folytonos
    // visszajelzést a többi batch oldallal egyező módon.
    _renderIoBatchQueue(batchItems);
    _updateIoBatchSummary(0);

    for (let i = 0; i < batchItems.length; i++) {
        const item = batchItems[i];
        _updateIoQueueRow(i, { state: 'running', label: 'Folyamatban', percent: 0 });

        // Use item-specific data or fall back to global inputs
        const finalSubject = item.subject !== null ? item.subject : (document.getElementById('openingSubject').value || '');
        const finalTeacher = item.teacher !== null ? item.teacher : (document.getElementById('openingTeacher').value || '');
        const finalPositions = item.positions || globalPositions;

        const payload = {
            language: selectedLang,
            preset: selectedPreset,
            loudness: loudness,
            theme: selectedTheme,
            has_opening: hasOpening,
            opening_texts: {
                subject: finalSubject,
                lesson: item.lesson,
                teacher: finalTeacher
            },
            opening_positions: finalPositions
        };

        try {
            const resp = await fetch(`${IO_API}/process/${item.jobId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (resp.ok) {
                await pollJobSync(item.jobId, (pct) => {
                    // Sor-szintű progress frissítés
                    _updateIoQueueRow(i, { state: 'running', label: 'Folyamatban', percent: pct });
                    // Összesített progress
                    const totalPct = ((i / batchItems.length) * 100) + (pct / batchItems.length);
                    _updateIoBatchSummary(totalPct);
                });
                item.status = 'completed';
                _updateIoQueueRow(i, { state: 'done', label: 'Kész', percent: 100 });
            } else {
                item.status = 'error';
                let detail = `HTTP ${resp.status}`;
                try { const b = await resp.json(); if (b && b.detail) detail = b.detail; } catch(_) {}
                _updateIoQueueRow(i, { state: 'error', label: 'Hibás', error: detail });
            }
        } catch (err) {
            console.error("Batch processing error for item", i, err);
            item.status = 'error';
            _updateIoQueueRow(i, { state: 'error', label: 'Hibás', error: err.message || 'Ismeretlen hiba' });
        }
        renderBatchTable();
    }

    _updateIoBatchSummary(100, true);
    showDownload();
    renderBatchDownloadList();
}

// A folyamatos queue-lista renderelése. Reuse a globális .batch-item CSS-t,
// ugyanúgy néz ki mint a többi batch oldalon (batch.html, subtitle_batch,
// transcribe_batch).
function _renderIoBatchQueue(items) {
    const container = document.getElementById('batchQueueList');
    if (!container) return;
    const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]));
    container.innerHTML = items.map((item, idx) => `
    <div class="batch-item status-queued" data-io-index="${idx}">
        <div class="batch-info" style="flex:1;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <h4 style="display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap;">
                    ${esc(item.file.name)}
                    ${item.lesson ? `<span style="font-size:0.7rem; font-weight:400; background:rgba(245,158,11,0.15); color:#fcd34d; border:1px solid rgba(245,158,11,0.3); border-radius:4px; padding:1px 7px;">${esc(item.lesson)}</span>` : ''}
                </h4>
            </div>
            <div class="batch-meta io-meta">Sorban áll</div>
            <div class="io-progress" style="display:none; height:4px; width:100%; background:#333; margin-top:0.5rem; border-radius:2px;">
                <div class="io-progress-fill" style="height:100%; width:0%; background:#6366f1; transition:width 0.3s;"></div>
            </div>
            <div class="io-error" style="display:none; color:#ef4444; font-size:0.8rem; margin-top:0.25rem;"></div>
        </div>
        <div class="batch-actions io-badge" style="margin-left:1rem; font-size:1.5rem;">🕒</div>
    </div>
    `).join('');
}

function _updateIoQueueRow(idx, { state, label, percent, error }) {
    const container = document.getElementById('batchQueueList');
    if (!container) return;
    const row = container.querySelector(`[data-io-index="${idx}"]`);
    if (!row) return;

    // Státusz-osztály csere a bal oldali sáv színezéséhez.
    row.classList.remove('status-queued', 'status-running', 'status-done', 'status-error');
    row.classList.add(`status-${state}`);

    const meta = row.querySelector('.io-meta');
    const prog = row.querySelector('.io-progress');
    const fill = row.querySelector('.io-progress-fill');
    const err = row.querySelector('.io-error');
    const badge = row.querySelector('.io-badge');

    if (meta) meta.textContent = (state === 'running') ? `${label || 'Folyamatban'}: ${Math.round(percent || 0)}%` : (label || '');

    if (state === 'running') {
        if (prog) prog.style.display = '';
        if (fill) fill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
        if (err) err.style.display = 'none';
        if (badge) badge.innerHTML = '<span class="spin">⏳</span>';
    } else if (state === 'done') {
        if (prog) { prog.style.display = ''; }
        if (fill) { fill.style.width = '100%'; fill.style.background = '#10b981'; }
        if (err) err.style.display = 'none';
        if (badge) badge.textContent = '✅';
    } else if (state === 'error') {
        if (prog) prog.style.display = 'none';
        if (err) { err.style.display = ''; err.textContent = `❌ ${error || 'Ismeretlen hiba'}`; }
        if (badge) badge.textContent = '❌';
    } else {
        // queued
        if (prog) prog.style.display = 'none';
        if (err) err.style.display = 'none';
        if (badge) badge.textContent = '🕒';
    }
}

function _updateIoBatchSummary(totalPct, done = false) {
    const bar = document.getElementById('batchProgressBar');
    const detail = document.getElementById('batchStatusDetail');
    const count = document.getElementById('batchProgressCount');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, totalPct))}%`;
    if (detail) detail.textContent = done ? 'Minden feladat kész.' : `Feldolgozás folyamatban… (${Math.round(totalPct)}%)`;
    if (count) {
        const completed = (batchItems || []).filter(x => x.status === 'completed').length;
        count.textContent = `${completed} / ${(batchItems || []).length}`;
    }
}

async function pollJobSync(jid, onProgress) {
    return new Promise((resolve) => {
        const interval = setInterval(async () => {
            try {
                const resp = await fetch(`${IO_API}/status/${jid}`);
                if (!resp.ok) { clearInterval(interval); resolve('error'); return; }
                const data = await resp.json();
                
                if (data.progress) onProgress(data.progress);
                
                if (data.stage === 'done' || data.stage === 'error') {
                    clearInterval(interval);
                    resolve(data.stage);
                }
            } catch (e) {
                clearInterval(interval);
                resolve('error');
            }
        }, 2000);
    });
}

function renderBatchTable() {
    const tbody = document.getElementById('batchTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    batchItems.forEach((item, index) => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid var(--border)';
        if (index === currentBatchIndex) tr.style.background = 'rgba(99, 102, 241, 0.15)';
        
        const hasOverrides = (item.subject !== null || item.teacher !== null || item.positions !== null);
        const overrideBadge = hasOverrides ? `<span style="background: var(--accent); color: white; border-radius: 4px; padding: 2px 6px; font-size: 0.65rem; margin-top: 4px; display: inline-block;">Egyedi</span>` : '';

        tr.innerHTML = `
            <td style="padding: 12px; color: var(--text-secondary); max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.file.name}</td>
            <td style="padding: 12px;">
                <textarea class="settings-input" style="width: 100%; height: 40px; font-size: 0.8rem; padding: 4px;" 
                    oninput="updateBatchLesson(${index}, this.value)">${item.lesson}</textarea>
                ${overrideBadge}
            </td>
            <td style="padding: 12px; text-align: center;">
                <button class="btn ${index === currentBatchIndex ? 'btn-accent' : 'btn-secondary'}" style="padding: 4px 8px; font-size: 0.7rem;" onclick="editBatchItem(${index})">
                    <i class="${index === currentBatchIndex ? 'fas fa-check' : 'far fa-eye'}"></i>
                    ${index === currentBatchIndex ? 'Kész' : 'Szerkeszt'}
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

window.updateBatchLesson = function(index, value) {
    if (batchItems[index]) {
        batchItems[index].lesson = value;
        if (index === currentBatchIndex) {
            const mainInput = document.getElementById('openingLesson');
            if (mainInput) mainInput.value = value;
            updatePreviewText('table');
        }
    }
};

window.editBatchItem = function(index) {
    const titleEl = document.getElementById('inputGroupTitle');
    const lessonInput = document.getElementById('openingLesson');
    const subjectInput = document.getElementById('openingSubject');
    const teacherInput = document.getElementById('openingTeacher');

    if (currentBatchIndex === index) {
        currentBatchIndex = -1;
        if (titleEl) titleEl.innerText = 'Globális adatok';
    } else {
        currentBatchIndex = index;
        const item = batchItems[index];
        if (titleEl) titleEl.innerText = `Egyedi adatok (${item.file.name})`;
        
        // Load item data into inputs
        if (lessonInput) lessonInput.value = item.lesson;
        if (subjectInput) subjectInput.value = item.subject !== null ? item.subject : '';
        if (teacherInput) teacherInput.value = item.teacher !== null ? item.teacher : '';
    }
    
    const note = document.getElementById('itemOverrideNote');
    if (note) note.classList.toggle('hidden', currentBatchIndex < 0);
    
    renderBatchTable();
    updatePreviewText();
};

window.finishItemEdit = function() {
    currentBatchIndex = -1;
    const titleEl = document.getElementById('inputGroupTitle');
    if (titleEl) titleEl.innerText = 'Globális adatok';
    
    const note = document.getElementById('itemOverrideNote');
    if (note) note.classList.add('hidden');
    renderBatchTable();
    updatePreviewText();
};

window.resetToGlobal = function() {
    if (currentBatchIndex >= 0) {
        batchItems[currentBatchIndex].positions = null;
        updatePreviewText();
    }
};

function renderBatchDownloadList() {
    const container = document.getElementById('downloadSection');
    let listDiv = document.getElementById('batchDownloadList');
    if (!listDiv) {
        listDiv = document.createElement('div');
        listDiv.id = 'batchDownloadList';
        listDiv.style.marginTop = '24px';
        container.appendChild(listDiv);
    }
    
    listDiv.innerHTML = '<h3 style="margin-bottom:16px;">✨ Eredmények:</h3>';
    
    batchItems.forEach((item, index) => {
        const d = document.createElement('div');
        d.className = 'card';
        d.style.marginBottom = '8px';
        d.style.display = 'flex';
        d.style.justifyContent = 'space-between';
        d.style.alignItems = 'center';
        d.style.padding = '12px';
        d.style.background = 'var(--bg-card)';
        
        if (item.status === 'error') {
            d.style.borderLeft = '4px solid #ef4444';
            d.innerHTML = `
                <span style="font-size:0.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:12px; color:#ef4444;">❌ ${item.file.name} (Hiba)</span>
                <button onclick="retryBatchItem(${index})" class="btn btn-secondary" style="padding: 6px 16px; font-size:0.8rem; border-color:#ef4444; color:#ef4444;">🔄 Újra</button>
            `;
        } else {
            d.style.borderLeft = '4px solid #10b981';
            d.innerHTML = `
                <span style="font-size:0.9rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-right:12px;">✅ ${item.file.name}</span>
                <button onclick="downloadBatchItem('${item.jobId}', '${item.file.name}')" class="btn btn-primary" style="padding: 6px 16px; font-size:0.8rem;">Letöltés</button>
            `;
        }
        listDiv.appendChild(d);
    });
    
    // Hide single download button
    const singleDl = container.querySelector('.btn-accent');
    if (singleDl) singleDl.style.display = 'none';
}

function downloadBatchItem(jobId, filename) {
    if (!jobId) return;
    const url = `${IO_API}/download/${jobId}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = ''; 
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
window.downloadBatchItem = downloadBatchItem;

async function retryBatchItem(index) {
    const item = batchItems[index];
    if (!item || !item.jobId) return;
    
    const d = document.querySelectorAll('#batchDownloadList .card')[index];
    if (d) {
        d.innerHTML = `<span style="font-size:0.9rem; color:var(--text-secondary);">⌛ ${item.file.name} újraindítása...</span>`;
    }
    
    try {
        const res = await fetch(`${IO_API}/retry/${item.jobId}`, { method: 'POST' });
        if (!res.ok) throw new Error("Nem sikerült az újraindítás");
        
        // Wait for it to finish
        const stage = await pollJobSync(item.jobId, (pct) => {});
        if (stage === 'done') {
            item.status = 'completed';
        } else {
            item.status = 'error';
        }
    } catch(e) {
        item.status = 'error';
    }
    renderBatchDownloadList();
}
window.retryBatchItem = retryBatchItem;


function startStatusUpdates() {
    // Polling safety net
    _stopStatusUpdates();
    _pollTimer_io = setInterval(checkStatus, POLL_MS);
    checkStatus();
    // Try SSE
    try {
        if (!currentJobId) return;
        _sseStatus = new EventSource(`api/intro_outro/status/${encodeURIComponent(currentJobId)}/stream`);
        _sseStatus.addEventListener('status', ev => {
            // Stop polling once SSE is alive
            if (_pollTimer_io) { clearInterval(_pollTimer_io); _pollTimer_io = null; }
            try {
                const status = JSON.parse(ev.data);
                updateStatusUI(status);
                if (status.stage === 'done') {
                    // Remove error panel if present from a previous run
                    const ep = document.getElementById('errorActionPanel'); if (ep) ep.remove();
                    showDownload();
                    _stopStatusUpdates();
                } else if (status.stage === 'uploaded') {
                    // Video uploaded but never processed — redirect to config panel
                    _stopStatusUpdates();
                    const sb = document.getElementById('startBtn');
                    if (sb) { sb.disabled = false; sb.textContent = 'Feldolgozás indítása'; }
                    showSection('configSection');
                    setStep(2);
                } else if (status.stage === 'error') {
                    _stopStatusUpdates();
                    showErrorActions(status);
                } else if (status.stage === 'cancelled' || status.stage === 'canceled') {
                    _stopStatusUpdates();
                }
            } catch (e) { console.warn('SSE status parse:', e); }
        });
        _sseStatus.onerror = () => {
            if (_sseStatus && _sseStatus.readyState === EventSource.CLOSED) {
                _sseStatus = null;
                if (!_pollTimer_io) _pollTimer_io = setInterval(checkStatus, POLL_MS);
            }
        };
    } catch (e) { console.warn('SSE status init failed:', e); }
}

function _stopStatusUpdates() {
    if (_pollTimer_io) { clearInterval(_pollTimer_io); _pollTimer_io = null; }
    if (_sseStatus) { try { _sseStatus.close(); } catch(_) {} _sseStatus = null; }
    // Also clear legacy pollTimer in case any old code path is still using it
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// Thin wrapper kept for backward compatibility with existing callers.
function startPolling() {
    startStatusUpdates();
}

async function checkStatus() {
    if (!currentJobId) return;
    try {
        const res = await fetch(`${IO_API}/status/${currentJobId}`);
        const status = await res.json();
        updateStatusUI(status);

        if (status.stage === 'done') {
            _stopStatusUpdates();
            // Remove error panel if present from a previous run
            const ep = document.getElementById('errorActionPanel'); if (ep) ep.remove();
            showDownload();
        } else if (status.stage === 'uploaded') {
            // Video uploaded but never processed — redirect to config panel
            _stopStatusUpdates();
            document.getElementById('startBtn').disabled = false;
            document.getElementById('startBtn').textContent = 'Feldolgozás indítása';
            showSection('configSection');
            setStep(2);
        } else if (status.stage === 'error') {
            _stopStatusUpdates();
            showErrorActions(status);
        }
    } catch (e) {
        console.error('Polling hiba:', e);
    }
}

function updateStatusUI(status) {
    const title = document.getElementById('jobStatusTitle');
    const badge = document.getElementById('jobStageBadge');
    const bar   = document.getElementById('progressBar');
    const detail = document.getElementById('statusDetail');
    if (title)  title.textContent  = 'Feldolgozás: ' + (status.stage || '');
    if (badge)  badge.textContent  = status.stage || '';
    if (bar)    bar.style.width    = (status.progress || 0) + '%';
    if (detail) {
        // ETA hozzáfűzés a status szövegéhez — a `<span>` HTML-t enged, hogy
        // a "⏳ ~7 perc" külön színnel/cím-tooltippel jelenjen meg.
        const etaHtml = (typeof formatEtaHtml === 'function')
            ? formatEtaHtml(status.created_at, status.progress)
            : '';
        const text = status.detail || 'Feldolgozás...';
        // innerHTML, hogy az etaHtml-renderelődjön; a status.detail backend-stamp,
        // nem user-input, ezért XSS-mentes (backend literál).
        detail.innerHTML = text + etaHtml;
    }
}

function showErrorActions(status) {
    // Remove any existing error action panel
    const existing = document.getElementById('errorActionPanel');
    if (existing) existing.remove();

    const section = document.getElementById('statusSection');
    if (!section) return;

    const panel = document.createElement('div');
    panel.id = 'errorActionPanel';
    panel.style.cssText = [
        'margin-top:24px',
        'padding:20px',
        'background:rgba(239,68,68,0.08)',
        'border:1px solid rgba(239,68,68,0.35)',
        'border-radius:12px',
        'display:flex',
        'flex-direction:column',
        'gap:12px',
    ].join(';');

    const errMsg = status.error_detail || status.detail || 'Ismeretlen hiba';
    panel.innerHTML = `
        <div style="color:#ef4444; font-weight:600; font-size:0.95rem;">⚠️ Feldolgozási hiba</div>
        <div style="font-size:0.85rem; color:var(--text-secondary); word-break:break-word;">${errMsg}</div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button class="btn btn-accent" id="retryBtn" onclick="retryJob()" style="flex:1; min-width:140px;">
                🔄 Újra feldolgozás
            </button>
            <button class="btn btn-secondary" id="deleteJobBtn" onclick="deleteCurrentJob()" style="flex:1; min-width:140px; border-color:rgba(239,68,68,0.5); color:#ef4444;">
                🗑️ Törlés
            </button>
        </div>
        <div style="font-size:0.8rem; color:var(--text-secondary); margin-top:4px;">
            Az <strong>Újra feldolgozás</strong> az eredeti videót az utolsó beállításokkal dolgozza fel újra.<br>
            A <strong>Törlés</strong> teljesen eltávolítja a job-ot és az összes fájlt.
        </div>
    `;
    section.appendChild(panel);
}

// ============================================================
// DOWNLOAD
// ============================================================
function showDownload() {
    const filenameEl = document.getElementById('outputFilename');
    if (filenameEl) {
        const stem = originalFilename.replace(/\.[^/.]+$/, '');
        filenameEl.textContent = stem + '_intro_outro.mp4';
    }
    showSection('downloadSection');
    setStep(4);
}

async function downloadOutput() {
    if (!currentJobId) return;
    const url = `${IO_API}/download/${currentJobId}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
window.downloadOutput = downloadOutput;

// ============================================================
// RETRY JOB
// ============================================================
// IO-2: a korábbi retryJob/retryJobFromHistory defek halott kódok voltak — a
// lentebbi (retryBtn-állapotot kezelő) definíciók felülirják őket. Törölve.

// ============================================================
// DELETE JOB
// ============================================================
// Backend végpont helyesen: DELETE /api/intro_outro/job/{id}.
// A korábbi /item/{id} út 404-et adott, amit a néma catch{} elnyelt,
// így a user úgy látta "törölve", de a szerveren a job maradt.
async function deleteCurrentJob() {
    if (!currentJobId) return;
    if (!confirm('Biztosan törlöd ezt a feladatot? Ez végleges.')) return;
    try {
        const res = await fetch(`${IO_API}/job/${currentJobId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Nem sikerült a törlés: HTTP ' + res.status);
    } catch (e) {
        alert('Törlési hiba: ' + e.message);
        return;
    }
    resetPage();
    renderHistory();
}
window.deleteCurrentJob = deleteCurrentJob;

// NOTE: volt itt egy másik deleteJob(jobId, event) definíció, de azt később
// a fájlban egy duplikátum felülírta. A duplikátumot is javítottuk (helyes
// végpont + backend-first sorrend), úgyhogy itt a kódot töröltük.

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
    const history = JSON.parse(localStorage.getItem('introOutroJobs') || '[]');
    if (!history.find(j => j.id === jobId)) {
        history.unshift({ id: jobId, name, date: new Date().toISOString() });
        if (history.length > 20) history.pop();
        localStorage.setItem('introOutroJobs', JSON.stringify(history));
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

async function renderHistory() {
    const container = document.getElementById('jobHistory');
    const history = JSON.parse(localStorage.getItem('introOutroJobs') || '[]');
    const filtered = history.filter(job => _matchHistoryDate(job.date));
    if (filtered.length === 0) {
        const msg = historyDateFilter === 'all' ? 'Nincs korábbi feladat'
            : (historyDateFilter === 'today' ? 'Ma még nincs feltöltés.' : 'Tegnap nincs feltöltés.');
        container.innerHTML = `<div style="padding:20px;color:#555;font-size:0.85rem;">${msg}</div>`;
        return;
    }
    // Render immediately with any cached _stage, then enrich from server
    _renderHistoryItems(container, filtered);
    const enriched = await _enrichHistoryWithStage(filtered);
    _renderHistoryItems(container, enriched);
}

function _renderHistoryItems(container, items) {
    container.innerHTML = items.map(job => {
        const stageCls = job._stage === 'error' ? ' style="border-left:3px solid #ef4444;"' : (job._stage === 'done' ? ' style="border-left:3px solid #10b981;"' : '');
        const retryBtn = (job._stage === 'error' || job._stage === 'done')
            ? `<button onclick="retryJobFromHistory('${job.id}', event)" class="btn btn-secondary" style="padding:4px 8px; font-size:0.75rem; border-radius:4px; margin-right:2px;" title="Újra feldolgozás">🔄</button>`
            : '';
        return `
        <div class="job-item${job.id === currentJobId ? ' active' : ''}" onclick="loadJob('${esc(job.id)}', ${esc(JSON.stringify(job.name))})"${stageCls} style="display:flex; justify-content:space-between; align-items:center;">
            <div class="job-info" style="flex:1; overflow:hidden;">
                <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(job.name)}</div>
                <div class="job-date">🕐 ${_fmtJobDate(job.date)}</div>
            </div>
            <div style="display:flex;gap:2px;flex-shrink:0;">
                ${retryBtn}
                <button onclick="deleteJob('${job.id}', event)" class="btn btn-secondary" style="padding:4px 8px; font-size:0.8rem; border-radius:4px;" title="Törlés">❌</button>
            </div>
        </div>`;
    }).join('');
}


// Fetch the current server-side stage for a job and cache it on the history object
async function _enrichHistoryWithStage(history) {
    const enriched = await Promise.all(history.map(async job => {
        try {
            const r = await fetch(`${IO_API}/status/${job.id}`);
            if (r.ok) {
                const s = await r.json();
                job._stage = s.stage;
            }
        } catch(e) { /* silent */ }
        return job;
    }));
    return enriched;
}

window.loadJob = async function(jobId, name) {
    currentJobId = jobId;
    originalFilename = name || 'output';
    
    if (currentMode === 'batch') {
        showSection('downloadSection');
        setStep(4);
        batchItems = [{
            file: { name: originalFilename },
            jobId: jobId,
            status: 'completed'
        }];
        try {
            const r = await fetch(`${IO_API}/status/${jobId}`);
            if (r.ok) {
                const s = await r.json();
                if (s.stage === 'error') batchItems[0].status = 'error';
                else if (s.stage !== 'done') {
                    // if it's running, mock it as error right now so they can retry, or just show list
                    if (s.stage !== 'error' && s.stage !== 'done') {
                        showSection('statusSection');
                        setStep(3);
                        startPolling();
                        return; // Exit here, let polling update the UI (which we need to mock a bit)
                    }
                }
            }
        } catch(e) {}
        renderBatchDownloadList();
        renderHistory();
        return;
    }

    showSection('statusSection');
    setStep(3);
    startPolling();
    renderHistory();
};

function resetPage() {
    currentJobId = null;
    originalFilename = '';
    _stopStatusUpdates();
    const vfn = document.getElementById('videoFileName'); if(vfn) vfn.textContent = '';
    document.getElementById('nextBtn').disabled = true;
    document.getElementById('startBtn').disabled = false;
    document.getElementById('startBtn').textContent = 'Feldolgozás indítása';
    selectedLang = 'hun';
    selectedPreset = 'youtube';
    selectedTheme = 'sajat';
    setLang('hun');
    setPreset('youtube');
    setTheme('sajat');
    
    if(document.getElementById('loudnessCheck')) document.getElementById('loudnessCheck').checked = false;
    if(document.getElementById('hasOpeningCheck')) document.getElementById('hasOpeningCheck').checked = false;
    if(document.getElementById('textSubject')) document.getElementById('textSubject').value = '';
    if(document.getElementById('textLesson')) document.getElementById('textLesson').value = '';
    if(document.getElementById('textTeacher')) document.getElementById('textTeacher').value = '';
    if(document.getElementById('customIntroInput')) document.getElementById('customIntroInput').value = '';
    if(document.getElementById('customOutroInput')) document.getElementById('customOutroInput').value = '';
    
    showSection('uploadSection');
    setStep(1);
}
window.resetPage = resetPage;

// ============================================================
// DELETE JOB
// ============================================================
async function deleteJob(jobId, event) {
    if (event) event.stopPropagation();
    if (!confirm('Biztosan törölni szeretnéd ezt a feladatot?')) return;

    // Backend-first: csak akkor tüntetjük el a UI-ból, ha a szerver tényleg
    // törölte. A korábbi "optimistic" verzió előbb nyúlt a localStorage-hoz,
    // és ha a backend hibára futott, a user már nem látta a tételt, de a
    // server-en maradt → "nem működik a törlés" tünet.
    try {
        const res = await fetch(`${IO_API}/job/${jobId}`, { method: 'DELETE' });
        if (!res.ok) {
            let detail = 'HTTP ' + res.status;
            try { const b = await res.json(); if (b && b.detail) detail = b.detail; } catch (_) {}
            throw new Error(detail);
        }
    } catch (e) {
        alert('Törlési hiba: ' + (e.message || 'ismeretlen hiba'));
        return;
    }

    let history = JSON.parse(localStorage.getItem('introOutroJobs') || '[]');
    history = history.filter(j => j.id !== jobId);
    localStorage.setItem('introOutroJobs', JSON.stringify(history));

    if (currentJobId === jobId) {
        resetPage();
    } else {
        renderHistory();
    }
}
window.deleteJob = deleteJob;

// ============================================================
// RETRY JOB
// ============================================================
async function retryJob(jobId) {
    const jid = jobId || currentJobId;
    if (!jid) return;

    const retryBtn = document.getElementById('retryBtn');
    if (retryBtn) { retryBtn.disabled = true; retryBtn.textContent = '⏳ Küldés...'; }

    try {
        const res = await fetch(`${IO_API}/retry/${jid}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || 'Újraindítás sikertelen');
        }

        // Remove error panel, go back to status view and start polling
        const ep = document.getElementById('errorActionPanel'); if (ep) ep.remove();
        currentJobId = jid;
        showSection('statusSection');
        setStep(3);
        startPolling();

    } catch(e) {
        alert('Hiba az újraindításkor: ' + e.message);
        if (retryBtn) { retryBtn.disabled = false; retryBtn.textContent = '🔄 Újra feldolgozás'; }
    }
}
window.retryJob = retryJob;

async function retryJobFromHistory(jobId, event) {
    event.stopPropagation();
    currentJobId = jobId;
    showSection('statusSection');
    setStep(3);
    await retryJob(jobId);
}
window.retryJobFromHistory = retryJobFromHistory;

async function deleteCurrentJob() {
    if (!currentJobId) return;
    if (!confirm('Biztosan törlöd a job-ot és az összes fájlt?')) return;
    await deleteJob(currentJobId, { stopPropagation: () => {} });
}
window.deleteCurrentJob = deleteCurrentJob;

// IO-1: custom intro/outro file picker. intro_outro.html onchange calls
// handleCustomFile('intro'|'outro') but it was never defined → ReferenceError
// and the filename label never updated. Just reflect the chosen file's name.
window.handleCustomFile = function (kind) {
    const input = document.getElementById(kind === 'intro' ? 'customIntroInput' : 'customOutroInput');
    const label = document.getElementById(kind === 'intro' ? 'customIntroName' : 'customOutroName');
    if (input && label) {
        label.textContent = (input.files && input.files[0]) ? input.files[0].name : 'Nincs kiválasztva';
    }
};
