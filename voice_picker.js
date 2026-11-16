// voice_picker.js — közös voice-library widget a ppt_narrate single + batch
// oldalakhoz. Backend API: /api/ppt_narrate/voices (GET/POST/DELETE).
//
// Használat:
//   <select id="voiceSelect"></select>
//   <button onclick="VoicePicker.openUploadModal()">+ Új hangminta</button>
//   <script src="voice_picker.js"></script>
//   await VoicePicker.refresh('voiceSelect');
//
// A komponens egyetlen globális objektumot exportál: window.VoicePicker.

(function () {
    const API = 'api/ppt_narrate/voices';
    let _modalRoot = null;
    let _lastList = [];

    async function fetchList() {
        const res = await fetch(API);
        if (!res.ok) throw new Error('Voices fetch failed: ' + res.status);
        _lastList = await res.json();
        return _lastList;
    }

    function _renderOptions(selectEl, list, currentValue) {
        const prev = currentValue || selectEl.value || '';
        selectEl.innerHTML = '';
        if (!list.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '— Nincs még hangminta — tölts fel egyet —';
            opt.disabled = true;
            opt.selected = true;
            selectEl.appendChild(opt);
            return;
        }
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '— Válassz hangmintát —';
        placeholder.disabled = true;
        if (!prev) placeholder.selected = true;
        selectEl.appendChild(placeholder);
        for (const v of list) {
            const opt = document.createElement('option');
            opt.value = v.voice_key;
            const lang = v.language_hint ? ` · ${v.language_hint}` : '';
            const up = v.uploader ? ` (${v.uploader})` : '';
            opt.textContent = `${v.display_name}${lang}${up}`;
            if (v.voice_key === prev) opt.selected = true;
            selectEl.appendChild(opt);
        }
    }

    async function refresh(selectId, currentValue) {
        const sel = document.getElementById(selectId);
        if (!sel) return [];
        try {
            const list = await fetchList();
            _renderOptions(sel, list, currentValue);
            return list;
        } catch (e) {
            console.error(e);
            sel.innerHTML = `<option value="" disabled selected>Hiba: ${e.message}</option>`;
            return [];
        }
    }

    function getList() {
        return _lastList.slice();
    }

    // ───── Upload modal ─────────────────────────────────────────────
    function _buildModal() {
        const root = document.createElement('div');
        root.id = '_voicePickerModal';
        root.className = 'vp-modal';
        root.innerHTML = `
            <div class="vp-box">
                <h3>🗣️ Új hangminta feltöltése</h3>
                <p class="vp-lead">Az XTTS klónozza a hangszínt. Tölthetsz fel <strong>audiót</strong> (5-30 mp ideális) vagy egy <strong>egész videót</strong> — a szerver csend-kiszedéssel ~30 mp tiszta beszéd-mintát csinál belőle.</p>
                <label class="vp-label">Megjelenítendő név</label>
                <input id="_vpDisplayName" type="text" placeholder="pl. Anna tanárnő" class="vp-field">
                <label class="vp-label">Nyelvi jelölés (opcionális)</label>
                <select id="_vpLanguageHint" class="vp-field">
                    <option value="">— Bármilyen —</option>
                    <option value="hu">🇭🇺 Magyar</option>
                    <option value="en">🇬🇧 English</option>
                </select>
                <label class="vp-label">Audió vagy videó fájl</label>
                <input id="_vpFile" type="file" accept=".wav,.mp3,.m4a,.ogg,.flac,.opus,.mp4,.mov,.mkv,.f4v,.avi,.webm" class="vp-field is-file">
                <div class="vp-hint">Engedélyezett: wav, mp3, m4a, ogg, flac, opus · mp4, mov, mkv, f4v, avi, webm</div>
                <label class="vp-check">
                    <input id="_vpTrimSilence" type="checkbox" checked>
                    <span>Csend-kiszedés (ajánlott) — kihagyja a kezdő csendet és a hosszú szüneteket</span>
                </label>
                <div id="_vpStatus" class="vp-status"></div>
                <div class="vp-actions">
                    <button type="button" id="_vpCancel" class="btn btn-secondary">Mégse</button>
                    <button type="button" id="_vpSubmit" class="btn btn-accent">Feltöltés</button>
                </div>
            </div>
        `;
        document.body.appendChild(root);
        root.addEventListener('click', (e) => { if (e.target === root) closeUploadModal(); });
        root.querySelector('#_vpCancel').addEventListener('click', closeUploadModal);
        root.querySelector('#_vpSubmit').addEventListener('click', _submitUpload);
        return root;
    }

    function _ensureModal() {
        if (!_modalRoot) _modalRoot = _buildModal();
        return _modalRoot;
    }

    function openUploadModal() {
        const m = _ensureModal();
        m.querySelector('#_vpDisplayName').value = '';
        m.querySelector('#_vpLanguageHint').value = '';
        m.querySelector('#_vpFile').value = '';
        m.querySelector('#_vpStatus').textContent = '';
        m.classList.add('is-open');
        setTimeout(() => m.querySelector('#_vpDisplayName').focus(), 50);
    }

    function closeUploadModal() {
        if (_modalRoot) _modalRoot.classList.remove('is-open');
    }

    async function _submitUpload() {
        const m = _modalRoot;
        const nameEl = m.querySelector('#_vpDisplayName');
        const langEl = m.querySelector('#_vpLanguageHint');
        const fileEl = m.querySelector('#_vpFile');
        const trimEl = m.querySelector('#_vpTrimSilence');
        const statusEl = m.querySelector('#_vpStatus');
        const submitBtn = m.querySelector('#_vpSubmit');
        const name = (nameEl.value || '').trim();
        const file = fileEl.files[0];
        if (!name) { statusEl.textContent = '⚠️ Adj meg egy nevet.'; statusEl.style.color = 'var(--warning-text)'; return; }
        if (!file) { statusEl.textContent = '⚠️ Válassz audió vagy videó fájlt.'; statusEl.style.color = 'var(--warning-text)'; return; }

        const fd = new FormData();
        fd.append('file', file);
        fd.append('display_name', name);
        fd.append('language_hint', langEl.value || '');
        fd.append('trim_silence', trimEl.checked ? 'true' : 'false');

        submitBtn.disabled = true;
        statusEl.style.color = 'var(--text-secondary)';
        const msg = trimEl.checked
            ? 'Feltöltés · csend-kiszedés · 24 kHz mono WAV…'
            : 'Feltöltés és normalizálás (24 kHz mono WAV)…';
        statusEl.textContent = msg;

        try {
            const res = await fetch(API, { method: 'POST', body: fd });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                throw new Error(body.detail || `HTTP ${res.status}`);
            }
            const data = await res.json();
            statusEl.style.color = 'var(--success-text)';
            statusEl.textContent = `✓ Kész: ${data.display_name}`;
            // Notify listeners (single + batch oldalak refresh-elhetik a dropdown-t).
            document.dispatchEvent(new CustomEvent('voiceLibraryChanged', { detail: data }));
            setTimeout(closeUploadModal, 700);
        } catch (e) {
            statusEl.style.color = 'var(--danger-text)';
            statusEl.textContent = '❌ ' + (e.message || e);
        } finally {
            submitBtn.disabled = false;
        }
    }

    async function deleteVoice(voiceKey) {
        const res = await fetch(`${API}/${encodeURIComponent(voiceKey)}`, { method: 'DELETE' });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.detail || `HTTP ${res.status}`);
        }
        document.dispatchEvent(new CustomEvent('voiceLibraryChanged', { detail: { deleted: voiceKey } }));
        return await res.json();
    }

    window.VoicePicker = {
        refresh,
        fetchList,
        getList,
        openUploadModal,
        closeUploadModal,
        deleteVoice,
    };
})();
