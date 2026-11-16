/**
 * batch_core.js - Centralized logic for all batch processing pages
 * Required: shared.js, upload_queue.js, dedup.js
 */

const API_BATCH_URL = 'api/batch';
let myJobsActive = false;
let ownerFilterValue = '';
let dateFilterValue = 'all';
let currentBatchMode = 'dub_full'; // 'dub_full' or 'transcript_only'

// Global chunked upload queue — concurrency configurable via the UI slider.
// One instance per page; tokens link back to virtual rows in _activeUploads.
let _uploadQueue = null;

// SSE-vel kapcsolatos állapot. A `_sseAlive` flag azt jelzi, hogy az
// EventSource jelenleg nyitott + frissítéseket kap. A 15 sec backup-polling
// CSAK akkor fut, ha ez false.
let _sseSource = null;
let _sseAlive = false;
let _sseFailCount = 0;
const _SSE_MAX_FAILS = 3;

/**
 * Initialize the batch page
 * @param {string} mode - 'dub_full' or 'transcript_only'
 */
function initBatchPage(mode) {
    currentBatchMode = mode;

    // Auth & UI init
    if (typeof applyOwnerDisplay === 'function') applyOwnerDisplay();
    if (typeof startMonitor === 'function') startMonitor();

    // Build the upload queue (must come before any drop-handling).
    _initUploadQueue();
    _setupConcurrencySlider();

    // Initial load — a SSE-handshake előtt egy gyors GET-tel a kezdeti UI-t
    // is megrajzoljuk; a SSE-első snapshot 1-2 mp-en belül átveszi.
    loadBatchStatus();

    // SSE elsődleges, polling fallback. A _startBatchSSE() megpróbálja
    // megnyitni az EventSource-ot; ha sikertelen (proxy-block, browser-no-
    // support, vagy 3 reconnect-fail), a polling marad életben.
    _startBatchSSE();

    // Polling-safety-net: 15 sec, csak akkor pollol, ha a SSE NEM élt
    // (open-status-flag). Ha a SSE megy, fals-eseti backup-frissítés ritkán.
    setInterval(() => {
        if (!_sseAlive) loadBatchStatus();
    }, 15000);

    // Setup DropZone
    setupDropZone();

    // Share Target landing: if the SW redirected here with ?shared=pending,
    // pull the file(s) from IndexedDB and enqueue them.
    _handleSharedPending();
}

function _startBatchSSE() {
    // EventSource csatlakozás a /api/batch/stream-re. A backend a teljes
    // {queue_counts, items} payload-ot küldi minden változáskor (`state`
    // event, value_stream pattern), heartbeat 25 sec-enként.
    //
    // Reconnect: a browser EventSource alapból ~3 sec-en belül újrapróbál
    // disconnect után. Ha 3-szor egymás után fail-el az `onerror`-on, a
    // SSE-t lemondjuk és visszaesünk pure-polling-ra (a 15 sec backup-
    // poll életben marad). Ezzel proxy-blokk / régi-böngésző sem akadály.
    if (typeof EventSource === 'undefined') {
        console.warn('EventSource not supported — staying on polling.');
        return;
    }
    try { if (_sseSource) _sseSource.close(); } catch (_) {}
    _sseAlive = false;
    _sseSource = new EventSource(`${API_BATCH_URL}/stream`);

    _sseSource.addEventListener('state', (evt) => {
        try {
            const data = JSON.parse(evt.data);
            _sseAlive = true;
            _sseFailCount = 0;
            // Pontosan azt a szűrő-flow-t alkalmazzuk mint a loadBatchStatus
            // polling-ágon, hogy a kettő közti váltás vizuálisan no-op.
            if (data && data.queue_counts) _renderQueueStatsFromCounts(data.queue_counts);
            if (data && Array.isArray(data.items)) {
                // 1) mode-szűrés (dub_full / transcript_only / subtitles_only / intro_outro)
                const items = data.items.filter(i => {
                    if (currentBatchMode === 'dub_full') return !i.mode || i.mode === 'dub_full';
                    return i.mode === currentBatchMode;
                });
                // 2) owners-dropdown frissítés (mode-szűrt)
                updateOwnersList(items);
                // 3) saját-munka / owner-szűrés / dátum-szűrés
                const me = getOwner();
                let visible = items;
                if (myJobsActive && me) visible = items.filter(i => i.owner === me);
                else if (ownerFilterValue) visible = items.filter(i => i.owner === ownerFilterValue);
                visible = visible.filter(_matchesDateFilter);
                // 4) cache + render
                _lastBatchItems = visible;
                renderBatchList(visible);
            }
        } catch (e) {
            console.warn('SSE state parse failed:', e);
        }
    });

    _sseSource.addEventListener('error', (evt) => {
        _sseAlive = false;
        _sseFailCount++;
        if (_sseFailCount >= _SSE_MAX_FAILS) {
            console.warn('SSE failed 3× in a row — falling back to polling.');
            try { _sseSource.close(); } catch (_) {}
            _sseSource = null;
            // A 15 sec backup-poll életben marad; explicit indítás nem kell.
        }
    });

    // Tab-leállás védelme: a böngészők néha NEM bontják a SSE-t background-
    // tabon; visibilitychange-en újra-handshake-kel ha kell.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !_sseAlive) {
            _sseFailCount = 0;
            _startBatchSSE();
        }
    });
}

// A queue_counts-ből frissíti a #queueStats sávot. Egységes a polling-
// loadBatchStatus formátumával, hogy a kettő közti váltás vizuálisan no-op.
function _renderQueueStatsFromCounts(counts) {
    const el = document.getElementById('queueStats');
    if (!el) return;
    const c = counts || {};
    el.textContent = `Sorban: ${c.queued || 0} · Fut: ${c.running || 0} · Kész: ${c.done || 0} · Hibás: ${c.error || 0}`;
}

function _initUploadQueue() {
    if (!window.UploadQueue) {
        console.error('UploadQueue not loaded — upload_queue.js must come before batch_core.js');
        return;
    }
    _uploadQueue = new window.UploadQueue({
        maxConcurrent: window.UploadQueue.loadConcurrency(),
        onProgress: (e) => {
            // Map UploadQueue states onto the virtual-row Map.
            // States: hashing | init | uploading | finalizing | done | error | cancelled | skipped | queued
            const visibleState = (() => {
                switch (e.state) {
                    case 'hashing':
                    case 'init':
                        return 'hashing';
                    case 'uploading':
                        return 'uploading';
                    case 'finalizing':
                        return 'finalizing';
                    case 'queued':
                        return 'queued';
                    case 'error':
                        return 'error';
                    default:
                        return e.state;
                }
            })();
            _activeUploads.set(e.token, {
                name: e.name,
                totalBytes: e.totalBytes,
                sentBytes: e.sentBytes,
                percent: e.percent,
                state: visibleState,
            });
            renderBatchListFromCache();
        },
        onComplete: (r) => {
            // Item appears in the next /api/batch/items poll; remove the
            // virtual row after a short grace period so the user sees the
            // "100%" badge before it disappears.
            _scheduleRemoveUpload(r.token, 3500);
            loadBatchStatus();
        },
        onError: (e) => {
            const entry = _activeUploads.get(e.token);
            if (entry) {
                entry.state = 'error';
                entry.error = e.error;
                renderBatchListFromCache();
            }
            _scheduleRemoveUpload(e.token, 12000);
        },
        onQueue: (q) => {
            const statusDiv = document.getElementById('uploadStatus');
            if (!statusDiv) return;
            if (q.active === 0 && q.queued === 0) return;  // leave the final message alone
            statusDiv.classList.remove('hidden');
            statusDiv.innerHTML = `<p>Feltöltés: <b>${q.active}</b> fut, <b>${q.queued}</b> vár (max párhuzamosság: ${q.max})</p>`;
        },
    });
}

function _setupConcurrencySlider() {
    const slider = document.getElementById('concurrencyRange');
    const display = document.getElementById('concurrencyValue');
    if (!slider) return;
    const initial = window.UploadQueue ? window.UploadQueue.loadConcurrency() : 2;
    slider.value = String(initial);
    if (display) display.textContent = String(initial);
    slider.addEventListener('input', () => {
        const n = parseInt(slider.value, 10);
        if (display) display.textContent = String(n);
        if (_uploadQueue) _uploadQueue.setConcurrency(n);
    });
}

async function _handleSharedPending() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get('shared') !== 'pending') return;
        if (!window.indexedDB) return;
        // Open the share-cache DB the service worker wrote to.
        const db = await new Promise((resolve, reject) => {
            const req = window.indexedDB.open('shareCache', 1);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains('pending')) {
                    req.result.createObjectStore('pending', { keyPath: 'id', autoIncrement: true });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        const tx = db.transaction('pending', 'readwrite');
        const store = tx.objectStore('pending');
        const all = await new Promise((resolve, reject) => {
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        for (const rec of all) {
            if (rec && rec.file && _uploadQueue) {
                _uploadQueue.enqueue(rec.file, _uploadExtras());
            }
        }
        // Clear after enqueue.
        await new Promise((resolve) => {
            const clr = store.clear();
            clr.onsuccess = () => resolve();
            clr.onerror = () => resolve();
        });
        // Tidy up the URL so a refresh doesn't re-fire.
        try {
            const cleanUrl = window.location.pathname;
            window.history.replaceState({}, '', cleanUrl);
        } catch (e) { /* noop */ }
    } catch (e) {
        console.warn('_handleSharedPending failed (fail-open):', e);
    }
}

function _uploadExtras() {
    const extras = {
        mode: currentBatchMode,
    };
    if (typeof window.getBatchUploadExtras === 'function') {
        try {
            const e = window.getBatchUploadExtras() || {};
            for (const [k, v] of Object.entries(e)) {
                if (v !== undefined && v !== null) extras[k] = v;
            }
        } catch (err) { /* defensive */ }
    }
    // Pre-process checkbox a HTML-en: ha "+ Brand intro/outro is" be van pipálva,
    // a flow-engine pre-process intro_outro-t fűz a feldolgozási lánc elé.
    const preCb = document.getElementById('preIntroOutroCheckbox');
    if (preCb && preCb.checked) {
        const themeSel = document.getElementById('preIntroOutroTheme');
        const theme = themeSel ? themeSel.value : 'sajat';
        extras.chain_before = [
            { type: 'intro_outro', config: { theme: theme, preset: 'youtube' } },
        ];
    }
    return extras;
}

function setupDropZone() {
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    if (!dropZone || !fileInput) return;

    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, e => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    // Highlight drop area
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('dragover');
        }, false);
    });

    // Handle dropped files
    dropZone.addEventListener('drop', (e) => {
        handleFiles(e.dataTransfer.files);
    }, false);

    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
    }, false);
}

// =============================================================
// UPLOAD WITH LIVE PROGRESS
// =============================================================
// A fetch() API nem ad upload-progress event-et, ezért XMLHttpRequest-et
// használunk. Minden feltöltés alatti fájl egy virtuális „uploading" kártyát
// kap a lista tetején — így az 5-15 GB-os videóknál is azonnal látszik,
// hogy hol tart a feltöltés, és a feltöltés → sorban áll → futás átmenet
// folytonos lesz.
//
// _activeUploads kulcs: egyedi token (timestamp+rand), érték:
//   { name, totalBytes, sentBytes, percent, state: 'uploading'|'queued'|'error', error?: str }
// A renderBatchList() a lista elejére ezeket is kiteszi, amíg valamelyik
// backend-row job_id-t nem kap — akkor ez a virtuális sor eltűnik.

const _activeUploads = new Map();

function _uploadToken() {
    return 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

async function handleFiles(files) {
    // The chunked upload queue handles N files with a user-controlled
    // concurrency (default 2). Dedup is done server-side inside /init
    // (returns "duplicate" status if the user has uploaded this file
    // before) — no need for a separate pre-flight guard here.
    if (!_uploadQueue) _initUploadQueue();
    if (!_uploadQueue) return;

    const statusDiv = document.getElementById('uploadStatus');
    if (statusDiv) {
        statusDiv.classList.remove('hidden');
        statusDiv.innerHTML = `<p>Feltöltés sorba állítva: ${files.length} fájl…</p>`;
    }

    const arr = Array.from(files);
    const extras = _uploadExtras();
    for (const f of arr) {
        _uploadQueue.enqueue(f, extras);
    }

    // The onQueue/onProgress/onComplete callbacks take it from here.
}

function _scheduleRemoveUpload(token, delayMs) {
    setTimeout(() => {
        _activeUploads.delete(token);
        renderBatchListFromCache();
    }, delayMs);
}

// A legutóbbi item-lista, amit a loadBatchStatus lementett. Kell a virtuális
// upload-kártyákhoz, hogy ne kelljen újabb API-hívást indítani csak a
// progress frissítés miatt.
let _lastBatchItems = [];

function renderBatchListFromCache() {
    renderBatchList(_lastBatchItems);
}

function _fmtTimestamp(raw) {
    if (!raw) return '';
    const d = new Date(raw.replace(' ', 'T') + 'Z');
    return d.toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function applyDateFilter(value) {
    dateFilterValue = value;
    document.querySelectorAll('.date-pill').forEach(p => p.classList.remove('active'));
    const map = { all: 'datePillAll', today: 'datePillToday', yesterday: 'datePillYest' };
    if (map[value]) {
        const el = document.getElementById(map[value]);
        if (el) el.classList.add('active');
    }
    loadBatchStatus();
}

function _matchesDateFilter(item) {
    if (dateFilterValue === 'all') return true;
    const raw = item.created_at || item.updated_at;
    if (!raw) return true;
    const itemDay = raw.slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (dateFilterValue === 'today') return itemDay === today;
    if (dateFilterValue === 'yesterday') return itemDay === yest;
    return true;
}

function toggleMyJobs() {
    myJobsActive = !myJobsActive;
    const btn = document.getElementById('myJobsBtn');
    const wrap = document.getElementById('ownerFilterWrap');
    if (!btn) return;

    btn.classList.toggle('active', myJobsActive);
    btn.setAttribute('aria-pressed', String(myJobsActive));
    if (wrap) wrap.classList.toggle('is-disabled', myJobsActive);
    if (myJobsActive) {
        ownerFilterValue = '';
        const sel = document.getElementById('ownerFilter');
        if (sel) sel.value = '';
    }
    loadBatchStatus();
}

function applyOwnerFilter(value) {
    ownerFilterValue = value;
    if (value) {
        myJobsActive = false;
        const btn = document.getElementById('myJobsBtn');
        if (btn) {
            btn.classList.remove('active');
            btn.setAttribute('aria-pressed', 'false');
        }
    }
    loadBatchStatus();
}

async function manualRefresh(btn) {
    const icon = btn.querySelector('span') || btn.querySelector('#refreshIcon');
    if (icon) icon.classList.add('spin-anim');
    await loadBatchStatus();
    if (icon) setTimeout(() => icon.classList.remove('spin-anim'), 1000);
}

async function loadBatchStatus() {
    try {
        const res = await fetch(`${API_BATCH_URL}/status`);
        if (!res.ok) throw new Error("Status fetch failed");
        const data = await res.json();
        
        const statsEl = document.getElementById('queueStats');
        if (statsEl) {
            const c = data.queue_counts || {};
            // Egységes magyar terminológia, egybehangolva a többi UI-szöveggel.
            statsEl.innerText = `Sorban: ${c.queued || 0} · Fut: ${c.running || 0} · Kész: ${c.done || 0} · Hibás: ${c.error || 0}`;
        }

        const listRes = await fetch(`${API_BATCH_URL}/items?limit=1000`);
        if (!listRes.ok) throw new Error("Items fetch failed");
        const allItems = await listRes.json();
        
        // Filter by page mode
        const items = allItems.filter(i => {
           if (currentBatchMode === 'dub_full') {
               return !i.mode || i.mode === 'dub_full';
           } else {
               return i.mode === currentBatchMode;
           }
        });

        // Update Owners Filter list
        updateOwnersList(items);

        const me = getOwner();
        let visibleItems = items;
        if (myJobsActive && me) visibleItems = items.filter(i => i.owner === me);
        else if (ownerFilterValue) visibleItems = items.filter(i => i.owner === ownerFilterValue);
        
        visibleItems = visibleItems.filter(_matchesDateFilter);

        _lastBatchItems = visibleItems;
        renderBatchList(visibleItems);

    } catch (e) {
        console.error("Batch load error:", e);
    }
}

function updateOwnersList(items) {
    const sel = document.getElementById('ownerFilter');
    if (!sel) return;
    const curVal = sel.value;
    const owners = [...new Set(items.map(i => i.owner).filter(Boolean))].sort();
    
    sel.innerHTML = '<option value="">— Mindenki —</option>';
    owners.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = '👤 ' + o;
        sel.appendChild(opt);
    });
    if (curVal) sel.value = curVal;
}

function renderBatchList(items) {
    const container = document.getElementById('batchList');
    if (!container) return;

    const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));

    // Aktív virtuális feltöltések — ezek a lista tetejére kerülnek, amíg
    // a backend fel nem fedezi a fájlt és valódi DB-row-t nem készít
    // belőle. Egy fájlnév-egyezés duplikációt okozna; elrejtjük a
    // virtuális sort, ha van egyező fájlnevű backend item ami < 60 s-kal
    // ezelőtti (tehát frissen megjelent).
    const now = Date.now();
    const backendNames = new Set();
    for (const it of items) {
        const ts = it.created_at ? new Date(it.created_at.replace(' ', 'T') + 'Z').getTime() : 0;
        if (now - ts < 60000) backendNames.add(it.original_filename);
    }

    const uploadKeyed = [];
    for (const [token, u] of _activeUploads) {
        if (u.state !== 'error' && backendNames.has(u.name)) continue;
        uploadKeyed.push({
            key: 'upload-' + token,
            html: _renderUploadingRow(token, u),
        });
    }

    if (items.length === 0 && uploadKeyed.length === 0) {
        // Empty-state — közvetlenül cseréljük az innerHTML-t, nincs lista-diff.
        container.innerHTML = `<div class="empty-history">${myJobsActive ? 'Nincs saját feladatod.' : 'A sor üres. Tölts fel fájlokat!'}</div>`;
        return;
    }

    const htmlItems = items.map(item => {
        let detailedStatus = "", progressBar = "", actionBtn = "";
        const dlState = JSON.parse(localStorage.getItem('downloadedJobsByType') || '{}')[item.job_id] || {};
        const deleteBtnHtml = `<button class="btn btn-secondary delete-btn-batch" onclick="deleteItem(${item.id})" title="Feladat és fájlok törlése">🗑️</button>`;
        const status = item.job_status;

        if (item.status === 'running') {
            actionBtn = `<button class="btn btn-secondary btn-xs btn-danger-quiet" onclick="cancelItem(${item.id})">Leállítás</button>`;
            const isErrorStage = !status || status.stage === 'error' || status.stage === 'cancelled' || status.stage === 'canceled';
            if (!isErrorStage) {
                const stageLabel = (typeof formatStageHu === 'function') ? formatStageHu(status.stage) : status.stage;
                const etaSrc = (status && status.created_at) || item.created_at;
                const etaHtml = (typeof formatEtaHtml === 'function') ? formatEtaHtml(etaSrc, status.progress) : '';
                // Stuck-jelzés: ha az updated_at > 30 perce nem frissült, badge.
                // Mind a backend stuck_job_watchdog mind ez a kliens-render
                // ugyanazt a 30 perces küszöböt használja.
                const stuckHtml = (typeof formatStuckHtml === 'function') ? formatStuckHtml(status && status.updated_at) : '';
                detailedStatus = `<div class="batch-note tone-progress">${stageLabel}: ${status.detail || ''} (${status.progress}%)${etaHtml}${stuckHtml}</div>`;
                progressBar = `<div class="batch-progress"><div class="batch-progress-fill" style="width:${status.progress}%"></div></div>`;
            } else {
                detailedStatus = `<div class="batch-note tone-danger">⚠️ Beragadt</div>`;
            }
        } else if (item.status === 'done') {
            // A "Mentve az Exports mappába" sor mellé inline ✅, ha bármi már
            // le lett töltve. A .saved-label class hagy a bulk_download.js-nek
            // hozzá-illeszteni a pipát, ha a user a render UTÁN tölt le.
            const savedMark = (Object.keys(dlState).length > 0) ? ' <span class="saved-mark" title="Letöltve">✅</span>' : '';
            detailedStatus = `<div class="saved-label batch-note tone-success is-sm">Mentve az Exports mappába${savedMark}</div>`;
            let baseName = item.original_filename;
            const lastDot = baseName.lastIndexOf('.'); 
            if (lastDot !== -1) baseName = baseName.substring(0, lastDot);
            
            
            // data-job-id + data-dltype attribútumokat is rakunk minden
            // letöltő linkre, hogy a tömeges letöltő (downloadAllVisible)
            // a markAsDownloaded-et közvetlenül tudja hívni, ne az
            // onclick-string eval()-ozásával (CSP nem engedi az unsafe-eval-t).
            if (currentBatchMode === 'dub_full') {
                const videoUrl = `api/download/${item.job_id}/dubbed_with_bg.mp4?download_name=${encodeURIComponent(baseName + ".mp4")}`;
                const audioUrl = `api/download/${item.job_id}/voice_only.wav?download_name=${encodeURIComponent(baseName + "_voice.wav")}`;
                // Quick-combo gomb: kész dub-job → "+ Folytasd intro/outro-val".
                // Csak akkor mutatjuk, ha a QuickCombo modul betöltve (a /batch.html
                // mostantól include-olja). Az asset-resolver a dubbed.mp4-ből
                // hardlinkel — nulla letöltés/újra-feltöltés.
                const qcBtn = (typeof QuickCombo !== 'undefined')
                    ? QuickCombo.buttonHtml({ jobId: item.job_id, sourceNodeType: 'dub', comboType: 'intro_outro' })
                    : '';
                actionBtn = `
                    <div class="batch-item-action-row">
                        <a href="${videoUrl}" class="btn btn-accent ${dlState.video ? 'downloaded' : ''}" download="${esc(baseName)}.mp4" data-job-id="${item.job_id}" data-dltype="video" onclick="markAsDownloaded('${item.job_id}', 'video')">⬇ Videó ${dlState.video ? '✅' : ''}</a>
                        <a href="${audioUrl}" class="btn btn-secondary ${dlState.audio ? 'downloaded' : ''}" download="${esc(baseName)}_voice.wav" data-job-id="${item.job_id}" data-dltype="audio" onclick="markAsDownloaded('${item.job_id}', 'audio')">🎙️ Hang ${dlState.audio ? '✅' : ''}</a>
                        ${qcBtn}
                        ${deleteBtnHtml}
                    </div>`;
            } else if (currentBatchMode === 'transcript_only') {
                // transcript_only pipeline output: hu.srt (magyar ASR-leirat SRT-ben)
                // + segments.json. A 'dubbed.srt' a dub_full mode terméke — itt
                // nem létezik, ezért 'hu.srt'-t kérünk. A TXT a GET-variánsra
                // megy (export_transcript_get a backend-en).
                const txtUrl = `api/job/${item.job_id}/export_transcript?download_name=${encodeURIComponent(baseName + ".txt")}`;
                const srtUrl = `api/download/${item.job_id}/hu.srt?download_name=${encodeURIComponent(baseName + ".srt")}`;
                const jsonUrl = `api/download/${item.job_id}/segments.json?download_name=${encodeURIComponent(baseName + ".json")}`;
                actionBtn = `
                    <div class="batch-item-action-row">
                        <a href="${txtUrl}" class="btn btn-secondary ${dlState.txt ? 'downloaded' : ''}" download="${esc(baseName)}.txt" data-job-id="${item.job_id}" data-dltype="txt" onclick="markAsDownloaded('${item.job_id}', 'txt')">⬇ TXT ${dlState.txt ? '✅' : ''}</a>
                        <a href="${srtUrl}" class="btn btn-secondary ${dlState.srt ? 'downloaded' : ''}" download="${esc(baseName)}.srt" data-job-id="${item.job_id}" data-dltype="srt" onclick="markAsDownloaded('${item.job_id}', 'srt')">📝 SRT ${dlState.srt ? '✅' : ''}</a>
                        <a href="${jsonUrl}" class="btn btn-secondary ${dlState.json ? 'downloaded' : ''}" download="${esc(baseName)}.json" data-job-id="${item.job_id}" data-dltype="json" onclick="markAsDownloaded('${item.job_id}', 'json')">{} JSON ${dlState.json ? '✅' : ''}</a>
                        ${deleteBtnHtml}
                    </div>`;
            } else if (currentBatchMode === 'intro_outro') {
                // The intro-outro pipeline writes <job_dir>/output.mp4 and the
                // download endpoint serves it with a friendly filename based
                // on the original upload name.
                const videoUrl = `api/intro_outro/download/${item.job_id}`;
                actionBtn = `
                    <div class="batch-item-action-row">
                        <a href="${videoUrl}" class="btn btn-accent ${dlState.video ? 'downloaded' : ''}" download="${esc(baseName)}_intro_outro.mp4" data-job-id="${item.job_id}" data-dltype="video" onclick="markAsDownloaded('${item.job_id}', 'video')">⬇ Videó ${dlState.video ? '✅' : ''}</a>
                        ${deleteBtnHtml}
                    </div>`;
            }
        } else if (item.status === 'queued') {
            actionBtn = `<button class="btn btn-secondary btn-xs" onclick="cancelItem(${item.id})">Mégse</button>`;
        } else if (item.status === 'error' || item.status === 'canceled' || item.status === 'cancelled') {
            actionBtn = `<div class="batch-item-action-row"><button class="btn btn-secondary btn-xs" onclick="retryItem(${item.id})">Újra</button>${deleteBtnHtml}</div>`;
        }

        const badgeHtml = item.owner ? `<span class="badge badge-soft">👤 ${esc(item.owner)}</span>` : '';

        // Render-signature: a state-ből minden olyan mező, ami befolyásolja
        // a megjelenítést. Ha a sig új-régi egyezik, a smooth-renderer
        // teljesen kihagyja az innerHTML-csere lépést → no flicker.
        // Az ETA dinamikusan változik (now-tól függ), de a sigben nem szerepel:
        // ha minden más egyezik, az ETA-update külön nem indítja a re-render-t,
        // az minden szakaszosan magától beáll a következő poll-ban — de a
        // wrapper egyébként is stabilan ott marad, így nem zavaró.
        const dlCount = Object.keys(dlState).length;
        const sig = [
            item.status,
            (status && status.stage) || '',
            (status && (status.progress || 0)) | 0,
            item.attempts || 0,
            dlCount,
            item.error_message ? 'E' : '',
        ].join(':');
        return {
            key: 'batch-' + item.id,
            html: `
        <div class="batch-item status-${item.status} ${dlCount > 0 ? 'downloaded' : ''}" data-list-key="batch-${item.id}" data-render-sig="${sig}">
            <div class="batch-info">
                <div class="batch-row-head">
                    <h4 class="batch-title">
                        ${esc(item.original_filename)}
                        ${badgeHtml}
                    </h4>
                    <div class="batch-row-actions">${actionBtn}</div>
                </div>
                <div class="batch-meta">${item.created_at ? `<span title="Feltöltve">🕐 ${_fmtTimestamp(item.created_at)}</span> · ` : ''}Állapot: ${(typeof formatStatusHu === 'function') ? formatStatusHu(item.status) : item.status} · Próbálkozás: ${item.attempts}</div>
                ${item.error_message ? `<div class="batch-note tone-danger is-sm">${esc(item.error_message)}</div>` : ''}
                ${detailedStatus}${progressBar}
            </div>
            <div class="batch-actions">
                ${item.status === 'done' ? '✅' : ''}${item.status === 'running' ? '<span class="spin">⏳</span>' : ''}${item.status === 'error' ? '❌' : ''}${item.status === 'queued' ? '🕒' : ''}${(item.status === 'canceled' || item.status === 'cancelled') ? '🚫' : ''}
            </div>
        </div>`,
        };
    });
    // Smooth-render: a meglévő DOM-wrapper-ek a helyükön maradnak, csak a
    // tartalmuk frissül (ha változott). Új sorok fade-in-nel jönnek, az
    // eltűnők fade-out-tal mennek. Lásd shared.js renderListSmoothInto.
    if (typeof renderListSmoothInto === 'function') {
        renderListSmoothInto(container, [...uploadKeyed, ...htmlItems]);
    } else {
        // Defenzív fallback: ha a shared.js egy elavult verzió.
        container.innerHTML = uploadKeyed.map(u => u.html).join('') + htmlItems.map(h => h.html).join('');
    }
    try { _updateDownloadAllButtons(); } catch (e) { /* noop */ }
}

// Egy folyamatban lévő feltöltés kártyája. Azonos stílusú, mint a normál
// .batch-item (kártyás, státusz-színes bal sáv), így a lista homogén.
// state:
//   'uploading' → kék progress bar (feltöltés hányadáig ért)
//   'queued'    → zöld "Sorban áll" (100%-ra ért, backend dolgozik)
//   'error'     → piros hibasor, dedukált detail-lel
function _renderUploadingRow(token, u) {
    const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]));
    const pct = Math.max(0, Math.min(100, u.percent || 0));

    let statusClass = 'queued';
    let statusLabel = 'Sorban áll';
    let detailHtml = '';

    if (u.state === 'uploading') {
        statusClass = 'running';
        statusLabel = 'Feltöltés';
        const mb = (u.sentBytes / (1024 * 1024)).toFixed(1);
        const totalMb = (u.totalBytes / (1024 * 1024)).toFixed(1);
        detailHtml = `<div class="batch-note tone-progress">Feltöltés: ${mb} / ${totalMb} MB (${pct}%)</div>
                      <div class="batch-progress">
                          <div class="batch-progress-fill" style="width:${pct}%"></div>
                      </div>`;
    } else if (u.state === 'hashing') {
        statusClass = 'queued';
        statusLabel = 'Hash számítása';
        detailHtml = `<div class="batch-note tone-muted">⌛ Aláírás számítása (duplikátum-ellenőrzés)…</div>`;
    } else if (u.state === 'finalizing') {
        statusClass = 'running';
        statusLabel = 'Befejezés';
        detailHtml = `<div class="batch-note tone-muted">⏳ Szerver-oldali összerakás folyik…</div>`;
    } else if (u.state === 'skipped') {
        statusClass = 'done';
        statusLabel = 'Már létezett';
        detailHtml = `<div class="batch-note tone-success">✓ Ezt a fájlt már feltöltötted — kihagytuk.</div>`;
    } else if (u.state === 'queued') {
        statusClass = 'queued';
        statusLabel = 'Sorban áll';
        detailHtml = `<div class="batch-note tone-muted">… várakozik az indításra (csúszka korlát)</div>`;
    } else if (u.state === 'error') {
        statusClass = 'error';
        statusLabel = 'Feltöltési hiba';
        detailHtml = `<div class="batch-note tone-danger">❌ ${esc(u.error || 'Ismeretlen hiba')}</div>`;
    }

    // Render-signature: az upload-state összes releváns mezője. A pct 1%-onkénti
    // pontossága OK: minden chunk-feltöltés után frissül, smooth-vizualizációhoz
    // bőven elég. Ha a sig egyezik, a renderListSmoothInto NEM piszkálja a DOM-ot.
    const sig = 'u:' + u.state + ':' + pct + (u.error ? ':E' : '');
    return `
    <div class="batch-item status-${statusClass}" data-upload-token="${token}" data-list-key="upload-${token}" data-render-sig="${sig}">
        <div class="batch-info">
            <div class="batch-row-head">
                <h4 class="batch-title">
                    ${esc(u.name)}
                    <span class="badge badge-warning badge-soft">⬆ Feltöltés alatt</span>
                </h4>
            </div>
            <div class="batch-meta">Állapot: ${statusLabel}</div>
            ${detailHtml}
        </div>
        <div class="batch-actions">
            ${(u.state === 'uploading' || u.state === 'finalizing' || u.state === 'hashing') ? '<span class="spin">⏳</span>' : ''}${u.state === 'queued' ? '🕒' : ''}${u.state === 'skipped' ? '✅' : ''}${u.state === 'error' ? '❌' : ''}
        </div>
    </div>`;
}

// markAsDownloaded + downloadAllVisible + _updateDownloadAllButtons most
// a közös bulk_download.js modulban élnek — globálban felülírják az itteni
// implementációt. Ez a "stub" csak akkor fut, ha a bulk_download.js NEM
// került betöltésre (defenzív fallback).
function markAsDownloaded(jobId, type) {
    if (window.markAsDownloaded && window.markAsDownloaded !== markAsDownloaded) {
        return window.markAsDownloaded(jobId, type);
    }
    if (!jobId || !type) return;
    let d = JSON.parse(localStorage.getItem('downloadedJobsByType') || '{}');
    if (!d[jobId]) d[jobId] = {};
    d[jobId][type] = true;
    localStorage.setItem('downloadedJobsByType', JSON.stringify(d));
    try { renderBatchListFromCache(); } catch (e) { /* noop */ }
}

async function cancelItem(id) { if (!confirm("Biztosan leállítod?")) return; await fetch(`${API_BATCH_URL}/cancel/${id}`, { method: 'POST' }); await loadBatchStatus(); }
async function deleteItem(id) { if (!confirm("Biztosan törölni akarod?")) return; await fetch(`${API_BATCH_URL}/item/${id}`, { method: 'DELETE' }); loadBatchStatus(); }
async function retryItem(id) { await fetch(`${API_BATCH_URL}/retry/${id}`, { method: 'POST' }); loadBatchStatus(); }
async function resetStuck() { await fetch(`${API_BATCH_URL}/reset-stuck`, { method: 'POST' }); loadBatchStatus(); }

function showCleanupModal() {
    const modal = document.getElementById('cleanupModal');
    if (modal) modal.classList.add('show');
    // A fókusz a modalba kerül, különben a Tab a háttérben lévő lapon lépked.
    const input = document.getElementById('cleanupConfirmInput');
    if (input) input.focus();
}
function hideCleanupModal() {
    const modal = document.getElementById('cleanupModal');
    if (modal) modal.classList.remove('show');
    const input = document.getElementById('cleanupConfirmInput');
    if (input) input.value = '';
    checkCleanupConfirmation();
}

function checkCleanupConfirmation() {
    const input = document.getElementById('cleanupConfirmInput');
    const val = (input && input.value || '').trim();
    const btn = document.getElementById('cleanupConfirmBtn');
    if (!btn) return;
    btn.disabled = (val !== 'Letöltöttem mindent');
}

async function doCleanup() {
    hideCleanupModal();
    const res = await fetch(`${API_BATCH_URL}/cleanup-storage`, { method: 'POST' });
    if (res.ok) { 
        const d = await res.json(); 
        alert(`Felszabadítva: ${d.freed_mb} MB\nTörölt job: ${d.deleted_jobs}`); 
        loadBatchStatus(); 
    }
}

async function downloadAllVisible(type) {
    const container = document.getElementById('batchList');
    if (!container) return;
    const links = Array.from(container.querySelectorAll(`a[download$=".${type}"]:not(.downloaded)`));
    if (links.length === 0) {
        // A korábbi alert helyett toast-ot adunk: ha a "Mind letöltve" badge
        // látszik a gombon, ez már jelzés a usernek hogy mi a helyzet.
        if (typeof showToast === 'function') {
            showToast(`Nincs új letölthető .${type.toUpperCase()} — minden már le van töltve.`, 'info');
        } else {
            alert(`Nincs új, letölthető ${type.toUpperCase()} fájl — minden már le van töltve.`);
        }
        return;
    }
    if (!confirm(`Biztosan le akarsz tölteni ${links.length} db ÚJ ${type.toUpperCase()} fájlt?`)) return;

    const target = (typeof event !== 'undefined' && event && event.target) ? event.target : null;
    const originalText = target ? target.innerText : '';
    if (target) {
        target.innerText = 'Töltés…';
        target.disabled = true;
        // data-busy: _updateDownloadAllButtons skipeli ezt a gombot, amíg
        // a tömeges letöltés zajlik — különben minden iteráció után
        // felülírná a "Töltés…" feliratot.
        target.setAttribute('data-busy', '1');
    }

    try {
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            const iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.src = link.href;
            document.body.appendChild(iframe);
            setTimeout(() => { if (document.body.contains(iframe)) document.body.removeChild(iframe); }, 3000);

            // Persistálás: a markAsDownloaded localStorage-ba ír ÉS azonnal
            // újrarenderel — onnan a class és a "Mentve …✅" sor + a gomb-
            // felirat egyszerre frissül. Az onclick-string eval-ozása helyett
            // a data-job-id + data-dltype attribútumokból olvassuk ki a
            // paramétereket (CSP-friendly, nem kell unsafe-eval).
            const jobId = link.getAttribute('data-job-id');
            const dlType = link.getAttribute('data-dltype');
            if (jobId && dlType) {
                try { markAsDownloaded(jobId, dlType); } catch (e) { /* noop */ }
            }
            await new Promise(r => setTimeout(r, 600));
        }
    } finally {
        if (target) {
            target.removeAttribute('data-busy');
            target.disabled = false;
        }
        _updateDownloadAllButtons();
    }
}

// A "Összes <ext>" gombok felirata + disabled-állapota dinamikusan változik
// a látható lista alapján: "📝 Összes SRT (3/12)" — 3 új letölthető a 12-ből.
// Ha minden már letöltött → "📝 Összes SRT ✓ (12/12)" + disabled.
function _updateDownloadAllButtons() {
    const container = document.getElementById('batchList');
    const bar = document.getElementById('downloadBar');
    if (!container || !bar) return;
    const buttons = bar.querySelectorAll('button[data-dlbtn]');
    buttons.forEach(btn => {
        if (btn.hasAttribute('data-busy')) return;  // bulk-letöltés zajlik
        const type = btn.getAttribute('data-dlbtn');
        const baseLabel = btn.getAttribute('data-dl-label') || btn.textContent;
        const total = container.querySelectorAll(`a[download$=".${type}"]`).length;
        const remaining = container.querySelectorAll(`a[download$=".${type}"]:not(.downloaded)`).length;

        // Az első futáskor mentsük el a "tiszta" label-t, hogy a remaining-
        // suffix-et később le tudjuk venni róla.
        if (!btn.hasAttribute('data-dl-label')) {
            btn.setAttribute('data-dl-label', baseLabel);
        }

        if (total === 0) {
            // Ilyen tipusú fájl egyáltalán nincs a látható listán (más mode).
            btn.style.display = 'none';
            return;
        }
        btn.style.display = '';
        btn.disabled = (remaining === 0);
        if (remaining === 0) {
            btn.textContent = `${baseLabel} ✓ (${total}/${total})`;
            btn.title = 'Minden ilyen fájl már le van töltve';
        } else {
            btn.textContent = `${baseLabel} (${remaining}/${total})`;
            btn.title = `${remaining} új, ${total - remaining} már letöltve`;
        }
    });
}

// Global exports
window.initBatchPage = initBatchPage;
window.toggleMyJobs = toggleMyJobs;
window.applyOwnerFilter = applyOwnerFilter;
window.applyDateFilter = applyDateFilter;
window.manualRefresh = manualRefresh;
window.deleteItem = deleteItem;
window.retryItem = retryItem;
window.cancelItem = cancelItem;
window.resetStuck = resetStuck;
window.showCleanupModal = showCleanupModal;
window.hideCleanupModal = hideCleanupModal;
window.doCleanup = doCleanup;
window.checkCleanupConfirmation = checkCleanupConfirmation;
window.downloadAllVisible = downloadAllVisible;
window.markAsDownloaded = markAsDownloaded;
