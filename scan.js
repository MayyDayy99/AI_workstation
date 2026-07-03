/* scan.js — Intelligens Tallózás UI */

'use strict';

const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]));

let selectedMode = 'dub_full';
let selectedLang = 'hun';
let selectedPreset = 'youtube';
let currentScanId = null;
let pollTimer = null;
let previewFiles = [];

const MODE_META = {
    dub_full:        { label: '🎙️ Szinkron',   suffix: 'videó_DUB_EN.mp4 + .vtt',  btn: 'Szinkron indítása' },
    subtitles_only:  { label: '💬 Felirat',     suffix: 'videó_SUB.srt + .vtt',      btn: 'Felirat generálása' },
    transcript_only: { label: '📄 Leirat',      suffix: 'videó_TRANSCRIPT.txt',       btn: 'Leirat generálása' },
    intro_outro:     { label: '🎬 Intro-Outro', suffix: 'videó_intro_outro.mp4',      btn: 'Intro-Outro hozzáfűzése' },
};

const EXT_COLORS = {
    mp4: '#3b82f6', mov: '#6366f1', mkv: '#8b5cf6', avi: '#a78bfa', webm: '#22d3ee',
    mp3: '#f59e0b', wav: '#f97316', m4a: '#fb923c', aac: '#fbbf24',
};

// ── Init ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    initSharedSession();
    loadRoots();
    startMonitor();
});

// ── Step indicator ────────────────────────────
function setActiveStep(n) {
    for (let i = 1; i <= 4; i++) {
        const el = document.getElementById('si' + i);
        if (!el) continue;
        el.classList.remove('active', 'done');
        if (i < n) el.classList.add('done');
        else if (i === n) el.classList.add('active');
    }
}

// ── Mode / lang / preset selection ───────────
function selectMode(card) {
    document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('active'));
    card.classList.add('active');
    selectedMode = card.dataset.value;
    document.getElementById('introOtroOptions').style.display =
        selectedMode === 'intro_outro' ? 'block' : 'none';
}

function selectLang(btn) {
    btn.closest('.lang-toggle').querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedLang = btn.dataset.value;
}

function selectPreset(btn) {
    btn.closest('.preset-pills').querySelectorAll('.preset-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedPreset = btn.dataset.value;
}

// ── Load allowed roots ────────────────────────
async function loadRoots() {
    const sel = document.getElementById('rootSelect');
    try {
        const res = await fetch('api/scan/roots');
        if (!res.ok) {
            const msg = await res.text();
            sel.innerHTML = `<option value="">⚠ API hiba (${res.status}) — frissítsd az oldalt</option>`;
            console.error('loadRoots API error:', res.status, msg);
            return;
        }
        const data = await res.json();
        sel.innerHTML = '';
        if (!data.roots || data.roots.length === 0) {
            sel.innerHTML = '<option value="">Nincs konfigurált mappa — lásd config.yaml scan.allowed_roots</option>';
            return;
        }
        data.roots.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.path;
            opt.textContent = r.exists ? r.display : `${r.display}  ⚠ nem létezik`;
            sel.appendChild(opt);
        });
    } catch (e) {
        sel.innerHTML = '<option value="">⚠ Betöltési hiba — frissítsd az oldalt</option>';
        console.error('loadRoots:', e);
    }
}

// ── Path builder ──────────────────────────────
function buildPath() {
    const root = document.getElementById('rootSelect').value;
    const sub = document.getElementById('subPath').value.trim().replace(/^[/\\]+/, '');
    if (!root) return null;
    if (sub) return root.replace(/[/\\]+$/, '') + '/' + sub;
    return root;
}

function buildBody() {
    return {
        root_path: buildPath(),
        mode: selectedMode,
        language: selectedLang,
        preset: selectedPreset,
        loudness: document.getElementById('loudnessCheck').checked,
        owner: getOwner(),
    };
}

// ── Helpers ───────────────────────────────────
function _formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ── Preview ───────────────────────────────────
async function previewScan() {
    const path = buildPath();
    if (!path) { alert('Válassz gyökérmappát!'); return; }

    const btn = document.getElementById('btnPreview');
    btn.disabled = true;
    btn.textContent = 'Keresés…';

    try {
        const res = await fetch('api/scan/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildBody()),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || JSON.stringify(data));
        previewFiles = data.files || [];
        showPreview(previewFiles, path);
    } catch (e) {
        alert('Hiba: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Fájlok előnézete →';
    }
}

function showPreview(files, path) {
    document.getElementById('stepSetup').style.display = 'none';
    document.getElementById('stepPreview').style.display = 'block';
    setActiveStep(2);

    const meta = MODE_META[selectedMode] || { label: selectedMode, suffix: '–', btn: 'Indítás' };
    const count = files.length;
    const totalBytes = files.reduce((s, f) => s + (f.size_bytes || 0), 0);
    const warnings = files.filter(f => (f.size_bytes || 0) < 1024);
    const warnCount = warnings.length;

    // Stats strip
    const strip = document.getElementById('statsStrip');
    strip.innerHTML =
        `<span class="stat-chip accent">📁 ${count} fájl</span>` +
        `<span class="stat-chip">${_formatSize(totalBytes)}</span>` +
        (warnCount > 0 ? `<span class="stat-chip warn">⚠ ${warnCount} gyanús fájl</span>` : `<span class="stat-chip ok">✓ Minden fájl rendben</span>`);

    // Confirm box
    document.getElementById('confirmMode').textContent = meta.label;
    document.getElementById('confirmPath').textContent = path;
    document.getElementById('confirmSuffix').textContent = meta.suffix;

    // File list
    const list = document.getElementById('previewList');
    if (files.length === 0) {
        list.innerHTML = '<div style="color:var(--text-secondary); padding:16px; text-align:center;">Nem találhatók feldolgozható médiafájlok.</div>';
        document.getElementById('btnStart').disabled = true;
        return;
    }

    // Group by directory
    const byDir = {};
    for (const f of files) {
        const dir = f.dir || '.';
        if (!byDir[dir]) byDir[dir] = [];
        byDir[dir].push(f);
    }

    let html = '<div class="file-list">';
    for (const [dir, dirFiles] of Object.entries(byDir)) {
        const dirTotal = dirFiles.reduce((s, f) => s + (f.size_bytes || 0), 0);
        html += `<div class="dir-group">
            <div class="dir-header">
                <span>📁 ${dir === '.' ? '(gyökér)' : esc(dir)}</span>
                <span class="dir-count">${dirFiles.length} fájl · ${_formatSize(dirTotal)}</span>
            </div>`;

        for (const f of dirFiles) {
            const isEmpty = (f.size_bytes || 0) === 0;
            const isSmall = !isEmpty && (f.size_bytes || 0) < 1024;
            const warn = isEmpty || isSmall;
            const extColor = EXT_COLORS[f.ext] || '#6b7280';

            html += `<div class="file-row ${warn ? 'warn-row' : ''}">
                <div class="file-name-col">
                    <span class="file-name-text">${esc(f.name)}</span>
                    <span class="ext-badge" style="background:${extColor}22; color:${extColor}; border:1px solid ${extColor}44;">${f.ext || '?'}</span>
                </div>
                <div class="file-size ${isEmpty ? 'style="color:#ef4444;"' : isSmall ? '' : ''}">
                    ${isEmpty
                        ? '<span style="color:#ef4444; font-weight:700;">⚠ 0 B</span>'
                        : isSmall
                            ? `<span style="color:#f59e0b;">⚠ ${_formatSize(f.size_bytes)}</span>`
                            : `<span style="color:var(--text-secondary);">${_formatSize(f.size_bytes)}</span>`}
                </div>
            </div>`;

            if (isEmpty) {
                html += `<div class="file-warn-msg" style="color:#ef4444;">⚠ Üres fájl — valószínűleg hiányos letöltés</div>`;
            } else if (isSmall) {
                html += `<div class="file-warn-msg" style="color:#f59e0b;">⚠ Nagyon kis méret — ellenőrizd, hogy teljes-e</div>`;
            }
        }
        html += `</div>`;
    }
    html += '</div>';
    list.innerHTML = html;

    // Start button
    const btnStart = document.getElementById('btnStart');
    btnStart.disabled = false;
    btnStart.textContent = warnCount > 0
        ? `▶ ${meta.btn} (${count} fájl, ${warnCount} figyelmeztetéssel)`
        : `▶ ${meta.btn} (${count} fájl)`;
}

function backToSetup() {
    document.getElementById('stepPreview').style.display = 'none';
    document.getElementById('stepSetup').style.display = 'block';
    setActiveStep(1);
}

// ── Start scan ────────────────────────────────
async function startScan() {
    if (selectedMode === 'dub_full' && previewFiles.length >= 20) {
        const ok = confirm(
            `Biztosan elindítod a szinkronizálást ${previewFiles.length} fájlhoz?\n\n` +
            `Ez hosszú, GPU-intenzív folyamat. Az outputok a forrás mellé kerülnek.`
        );
        if (!ok) return;
    }

    document.getElementById('btnStart').disabled = true;

    try {
        const res = await fetch('api/scan/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildBody()),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || JSON.stringify(data));

        currentScanId = data.scan_id;
        showProgressStep(data.queued);
        startPolling();
    } catch (e) {
        alert('Hiba a scan indításakor: ' + e.message);
        document.getElementById('btnStart').disabled = false;
    }
}

function showProgressStep(total) {
    document.getElementById('stepPreview').style.display = 'none';
    document.getElementById('stepProgress').style.display = 'block';
    setActiveStep(3);

    document.getElementById('overallText').textContent = `0 / ${total}`;
    document.getElementById('overallFill').style.width = '0%';
    document.getElementById('itemList').innerHTML = '';
    document.getElementById('progressChips').innerHTML =
        `<span class="progress-chip">⟳ Inicializálás…</span>`;
}

// ── Polling ───────────────────────────────────
function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollStatus();
    pollTimer = setInterval(pollStatus, 4000);
}

function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollStatus() {
    if (!currentScanId) return;
    try {
        const res = await fetch(`api/scan/${currentScanId}`);
        if (!res.ok) return;
        const data = await res.json();
        renderProgress(data);

        const finished = data.done + data.error + data.canceled;
        if (finished >= data.total && data.total > 0 && data.queued === 0 && data.running === 0) {
            stopPolling();
            setTimeout(() => showDone(data), 800);
        }
    } catch (e) {
        console.error('pollStatus:', e);
    }
}

function renderProgress(data) {
    const finished = data.done + data.error;
    const pct = data.total > 0 ? Math.round((finished / data.total) * 100) : 0;

    document.getElementById('overallText').textContent = `${finished} / ${data.total}`;
    document.getElementById('overallFill').style.width = pct + '%';

    document.getElementById('progressChips').innerHTML =
        `<span class="progress-chip" style="border-color:rgba(34,197,94,0.3); color:#4ade80;">✓ ${data.done} kész</span>` +
        `<span class="progress-chip" style="border-color:rgba(99,102,241,0.3); color:#a5b4fc;">⟳ ${data.running} fut</span>` +
        `<span class="progress-chip">◷ ${data.queued} vár</span>` +
        (data.error > 0 ? `<span class="progress-chip" style="border-color:rgba(239,68,68,0.3); color:#f87171;">✗ ${data.error} hiba</span>` : '');

    const STATUS_COLOR = {
        done: '#22c55e', error: '#ef4444', running: '#6366f1', queued: '#374151', canceled: '#374151',
    };

    document.getElementById('itemList').innerHTML = (data.items || []).map(item => {
        const js = item.job_status;
        const stage = js ? js.stage : item.status;
        const progress = js ? (js.progress || 0) : (item.status === 'done' ? 100 : 0);
        const detail = js ? (js.detail || '') : (item.error_message || '');
        const color = STATUS_COLOR[item.status] || '#374151';

        const miniBar = (item.status === 'running')
            ? `<div class="item-mini-bar"><div class="item-mini-fill" style="width:${progress}%;"></div></div>`
            : '';

        return `<div class="item-row" style="border-left-color:${color};">
            <div class="item-row-head">
                <span class="item-row-name">${esc(item.original_filename)}</span>
                <span class="item-row-status" style="color:${color};">${statusLabel(item.status, stage)}</span>
            </div>
            ${detail ? `<div class="item-row-detail">${esc(detail)}</div>` : ''}
            ${miniBar}
        </div>`;
    }).join('');
}

function statusLabel(status, stage) {
    if (status === 'done') return '✓ Kész';
    if (status === 'error') return '✗ Hiba';
    if (status === 'canceled') return '⊘ Leállítva';
    if (status === 'running') return `⟳ ${stage || 'fut'}`;
    return '◷ Vár';
}

// ── Done ──────────────────────────────────────
function showDone(data) {
    document.getElementById('stepProgress').style.display = 'none';
    document.getElementById('stepDone').style.display = 'block';
    setActiveStep(4);

    const meta = MODE_META[selectedMode] || { suffix: '–' };
    const hasErrors = data.error > 0;

    document.getElementById('doneMessage').innerHTML =
        `<strong style="font-size:1.1rem; color:var(--text-primary);">${data.done} fájl</strong> sikeresen feldolgozva` +
        (hasErrors ? ` · <span style="color:#ef4444;">${data.error} hiba</span>` : '') +
        `.<br><br>` +
        `Az outputok (<code style="background:rgba(0,0,0,0.3); border:none; padding:2px 6px; border-radius:4px; color:#a5b4fc;">${meta.suffix}</code>) a forrás fájlok mellé kerültek a szerveren.<br>` +
        `Az eredetik biztonsági másolata a <code style="background:rgba(0,0,0,0.3); border:none; padding:2px 6px; border-radius:4px; color:#6ee7b7;">.scan_backup/</code> almappában vannak.`;
}

// ── Cancel ────────────────────────────────────
async function cancelScan() {
    if (!currentScanId) return;
    if (!confirm('Biztosan leállítod a scan-t? A már futó feladatok befejeződnek.')) return;
    try {
        await fetch(`api/scan/${currentScanId}`, { method: 'DELETE' });
        stopPolling();
        pollStatus();
    } catch (e) {
        console.error('cancelScan:', e);
    }
}

// ── Reset ─────────────────────────────────────
function resetToSetup() {
    currentScanId = null;
    previewFiles = [];
    stopPolling();
    ['stepDone', 'stepProgress', 'stepPreview'].forEach(id => {
        document.getElementById(id).style.display = 'none';
    });
    document.getElementById('stepSetup').style.display = 'block';
    setActiveStep(1);
}
