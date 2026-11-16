/* ============================================================
 * convert.js — Fájlkonvertáló (CONV-1).
 *
 * A fájl kiválasztásakor a lap lekéri, mire konvertálható
 * (api/convert/formats), a Konvertálás gombra darabolva feltölti
 * (UploadQueue, purpose 'convert' — a Cloudflare ~100 MB fölött egyben
 * eldobná), elindítja (/start), követi (/status), és letölthetővé teszi.
 * Ugyanaz a feltöltött fájl más formátumba is mehet újra feltöltés nélkül.
 *
 * A HTML (vagy ZIP-projekt) MP4-be a html2video-konténerben készül, két
 * motorral: HyperFrames-kompozícióként (H2V-1) vagy OLDALFELVÉTELLEL
 * (H2V-CAPTURE-1 — bármilyen lap, kockánként fotózva, némán). A cél
 * kiterjesztése mindkettőnél „mp4", ezért a lap a motort is megküldi; a
 * választott motortól függ, milyen beállításokat kér, a haladás valódi
 * százalék, és a végén kiírja, mi futott GPU-n.
 *
 * Felhasználói szöveg (fájlnév) csak textContent-tel kerül a lapra.
 * ============================================================ */
(function () {
    'use strict';

    var API = 'api/convert';
    var POLL_MS = 1500;
    var STAGE_LABEL = {
        uploaded: 'Feltöltve', queued: 'Sorban', converting: 'Konvertálás',
        done: 'Kész', error: 'Hiba', interrupted: 'Megszakadt'
    };

    var HYPERFRAMES = 'hyperframes';
    var CAPTURE = 'capture';
    // Mérve a munkaállomáson (sűrű, 3D-s lap, 1080p30): ~1,7 kocka/mp. Csak
    // nagyságrendi becslésre — a lap összetettsége dönt.
    var FRAMES_PER_SEC = 1.7;

    var pickedFile = null;   // a kiválasztott fájl
    var jobId = null;        // a feltöltött fájl jobja (újrakonvertáláshoz)
    var pollTimer = null;

    function $(id) { return document.getElementById(id); }
    function show(id, on) { $(id).classList.toggle('hidden', !on); }

    function extOf(name) {
        var i = name.lastIndexOf('.');
        return i < 0 ? '' : name.slice(i + 1).toLowerCase();
    }

    function fmtSize(bytes) {
        if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
        if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
        return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    }

    function accepted() {
        return ($('fileInput').getAttribute('accept') || '').split(',')
            .map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    }

    async function api(path, opts) {
        var res = await fetch(API + path, opts);
        var body = null;
        try { body = await res.json(); } catch (_) { /* nem JSON */ }
        if (!res.ok) throw new Error((body && body.detail) || ('HTTP ' + res.status));
        return body;
    }

    function setPickStatus(text, kind) {
        var el = $('pickStatus');
        el.textContent = text || '';
        el.classList.toggle('text-danger', kind === 'err');
    }

    function fillTargets(list) {
        var sel = $('targetSelect');
        sel.textContent = '';
        var groups = {};
        var order = [];
        list.forEach(function (t) {
            if (!groups[t.group]) { groups[t.group] = []; order.push(t.group); }
            groups[t.group].push(t);
        });
        order.forEach(function (name) {
            var og = document.createElement('optgroup');
            og.label = name;
            groups[name].forEach(function (t) {
                var o = document.createElement('option');
                o.value = t.ext;
                o.textContent = t.label;
                o.dataset.engine = t.engine || 'filee';
                og.appendChild(o);
            });
            sel.appendChild(og);
        });
        syncRenderOptions();
    }

    function selectedEngine() {
        var o = $('targetSelect').selectedOptions[0];
        return (o && o.dataset.engine) || 'filee';
    }

    // A beállítások a VÁLASZTOTT MOTORHOZ tartoznak: a kompozíció-renderelés
    // és az oldalfelvétel mást kér (a felvételnél a hossz és a lejátszósáv).
    function syncRenderOptions() {
        var visible = !$('targetRow').classList.contains('hidden');
        var engine = selectedEngine();
        var render = visible && engine === HYPERFRAMES;
        var capture = visible && engine === CAPTURE;
        show('renderOptions', render || capture);
        show('renderHint', render);
        show('captureOptions', capture);
        show('captureHint', capture);
        $('fpsDefaultOption').textContent = capture ? '30 (alap)' : 'A kompozícióé';
        syncEstimate();
    }

    // Őszinte becslés a felvétel idejére: percekről van szó, nem másodpercekről.
    function syncEstimate() {
        var on = selectedEngine() === CAPTURE && !$('captureOptions').classList.contains('hidden');
        show('captureEstimate', on);
        if (!on) return;
        var secs = Number($('secondsInput').value) || 0;
        var fps = Number($('fpsSelect').value) || 30;
        var slow = $('qualitySelect').value === 'high' ? 10 : 1;   // a 2× túlminta ~10× lassabb
        if (!secs) {
            $('captureEstimate').textContent = 'A hossz a lapról jön. A felvétel a videó hosszának '
                + 'sokszorosáig tart (kb. ' + Math.round(fps / FRAMES_PER_SEC * slow) + '× annyi).';
            return;
        }
        var max = Number($('secondsInput').max) || 600;
        if (secs > max) {
            $('captureEstimate').textContent = 'Ennyi nem megy egyben: a felvétel legfeljebb '
                + max + ' mp lehet.';
            return;
        }
        var min = secs * fps / FRAMES_PER_SEC * slow / 60;
        $('captureEstimate').textContent = secs + ' mp videó = ' + Math.round(secs * fps) + ' kocka, '
            + 'ez kb. ' + (min < 1 ? '1 perc alatt' : Math.round(min) + ' perc')
            + (slow > 1 ? ' (a „Kiváló" 2× túlmintával lassú)' : '') + '.';
    }

    function gpuText(gpu) {
        if (!gpu) return '';
        var enc = gpu.encode === 'nvenc' ? 'NVENC (GPU)' : 'CPU';
        var draw = gpu.browser === 'hardware' ? 'GPU' : (gpu.browser === 'software' ? 'szoftveres' : '?');
        return 'Kódolás: ' + enc + ', rajzolás: ' + draw + '.';
    }

    async function loadTargets(ext) {
        $('convertBtn').disabled = true;
        show('targetRow', false);
        syncRenderOptions();
        setPickStatus('Célformátumok lekérése…');
        try {
            var data = await api('/formats?ext=' + encodeURIComponent(ext));
            var list = (data && data.targets) || [];
            show('targetRow', list.length > 0);
            fillTargets(list);
            $('convertBtn').disabled = list.length === 0;
            setPickStatus(list.length ? '' : 'Ehhez a fájlhoz nincs felkínálható célformátum.', list.length ? '' : 'err');
        } catch (e) {
            setPickStatus(e.message, 'err');
        }
    }

    function onPick(file) {
        if (!file) return;
        var ext = extOf(file.name);
        if (accepted().indexOf('.' + ext) < 0) {
            setPickStatus('Ez a fájltípus nem konvertálható.', 'err');
            return;
        }
        pickedFile = file;
        jobId = null;
        $('pickedName').textContent = file.name;
        $('pickedSize').textContent = fmtSize(file.size);
        show('pickedRow', true);
        loadTargets(ext);
    }

    function upload(file) {
        return new Promise(function (resolve, reject) {
            var q = new UploadQueue({
                maxConcurrent: 1,
                onProgress: function (p) {
                    if (p.state && p.state !== 'done' && p.state !== 'error' && p.state !== 'cancelled') {
                        setProgress(Math.round(p.percent * 0.5), 'Feltöltés', 'Feltöltés… ' + p.percent + '%');
                    }
                },
                onComplete: function (r) {
                    if (r.job_id) resolve(r.job_id);
                    else reject(new Error('a feltöltés nem adott vissza azonosítót'));
                },
                onError: function (r) { reject(new Error(r.error)); }
            });
            q.enqueue(file, { purpose: 'convert' });
        });
    }

    function setProgress(pct, badge, detail, indeterminate) {
        $('progressBox').classList.toggle('indeterminate', !!indeterminate);
        $('progressBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
        $('statusBadge').textContent = badge;
        $('statusDetail').textContent = detail || '';
    }

    async function startConversion() {
        var target = $('targetSelect').value;
        if (!target || (!pickedFile && !jobId)) return;
        $('convertBtn').disabled = true;
        show('pickSection', false);
        show('resultSection', false);
        show('statusSection', true);
        $('statusTitle').textContent = 'Konvertálás…';
        setProgress(0, 'Feltöltés', 'Feltöltés…');
        try {
            var body = { target: target, engine: selectedEngine() };
            if (body.engine === HYPERFRAMES || body.engine === CAPTURE) {
                body.quality = $('qualitySelect').value;
                if ($('fpsSelect').value) body.fps = Number($('fpsSelect').value);
            }
            if (body.engine === CAPTURE) {
                if ($('secondsInput').value) body.seconds = Number($('secondsInput').value);
                body.hide_controls = $('hideControls').checked;
            }
            if (!jobId) jobId = await upload(pickedFile);
            await api('/start/' + encodeURIComponent(jobId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            renderHistory();
            poll();
        } catch (e) {
            failed(e.message);
        }
    }

    async function poll() {
        clearTimeout(pollTimer);
        if (!jobId) return;
        var st;
        try {
            st = await api('/status/' + encodeURIComponent(jobId));
        } catch (e) {
            pollTimer = setTimeout(poll, POLL_MS * 2);    // átmeneti hiba: később újra
            return;
        }
        if (st.stage === 'done') return finished(st);
        if (st.stage === 'error' || st.stage === 'interrupted') return failed(st.detail || 'A konverzió nem sikerült.');
        // a renderelés valódi százalékot ad; a Filee-konverzió nem, ott pörög a sáv
        setProgress(st.progress || 50, STAGE_LABEL[st.stage] || st.stage, st.detail || '',
                    st.stage === 'converting' && st.engine !== HYPERFRAMES && st.engine !== CAPTURE);
        pollTimer = setTimeout(poll, POLL_MS);
    }

    function expiryText(st) {
        if (!st.expires_at) return '';
        var hours = Math.max(0, Math.round((st.expires_at * 1000 - Date.now()) / 3600000));
        return hours >= 1 ? 'Még kb. ' + hours + ' óráig tölthető le.' : 'Hamarosan törlődik.';
    }

    function finished(st) {
        show('statusSection', false);
        show('resultSection', true);
        var h2v = st.engine === HYPERFRAMES || st.engine === CAPTURE;
        var render = h2v && st.render_seconds != null
            ? (st.engine === CAPTURE ? ' Felvétel ' : ' Renderelés ')
              + Math.round(st.render_seconds) + ' mp alatt. ' + gpuText(st.render_gpu) : '';
        $('resultDetail').textContent = (st.original_filename || 'A fájl') + ' → ' +
            (st.target_label || st.target || '') + '.' + render + ' ' + expiryText(st);
        $('downloadLink').href = API + '/download/' + encodeURIComponent(st.id);
        renderHistory();
    }

    function failed(message) {
        show('statusSection', false);
        show('pickSection', true);
        setPickStatus('Hiba: ' + message, 'err');
        $('convertBtn').disabled = !$('targetSelect').value;
        renderHistory();
    }

    // A már feltöltött fájl más formátumba: a választó marad, új feltöltés nincs.
    function convertAgain() {
        show('resultSection', false);
        show('pickSection', true);
        setPickStatus('');
        $('convertBtn').disabled = !$('targetSelect').value;
    }

    function resetPage() {
        clearTimeout(pollTimer);
        pickedFile = null;
        jobId = null;
        $('fileInput').value = '';
        show('pickedRow', false);
        show('targetRow', false);
        syncRenderOptions();
        setPickStatus('');
        $('convertBtn').disabled = true;
        show('statusSection', false);
        show('resultSection', false);
        show('pickSection', true);
    }

    // Egy korábbi konverzió megnyitása a listából (letöltés / újra más formátumba).
    async function openJob(item) {
        clearTimeout(pollTimer);
        pickedFile = null;
        jobId = item.id;
        $('pickedName').textContent = item.original_filename || '';
        $('pickedSize').textContent = '';
        show('pickedRow', true);
        if (item.stage === 'done') finished(item);
        else if (item.stage === 'queued' || item.stage === 'converting') {
            show('pickSection', false); show('resultSection', false); show('statusSection', true);
            poll();
        } else {
            show('statusSection', false); show('resultSection', false); show('pickSection', true);
            setPickStatus(item.stage === 'error' ? 'Hiba: ' + (item.detail || '') : '', item.stage === 'error' ? 'err' : '');
        }
        await loadTargets(extOf(item.original_filename || ''));
    }

    async function deleteJob(item) {
        var ok = await showConfirm({
            title: 'Konverzió törlése',
            message: 'A feltöltött fájl és az eredmény is véglegesen törlődik a szerverről.',
            confirmText: 'Törlés',
            danger: true
        });
        if (!ok) return;
        try {
            await api('/job/' + encodeURIComponent(item.id), { method: 'DELETE' });
        } catch (e) {
            showToast('Törlési hiba: ' + e.message, 'error');
            return;
        }
        if (jobId === item.id) resetPage();
        renderHistory();
    }

    function historyRow(item) {
        var row = document.createElement('div');
        row.className = 'job-item';
        if (item.id === jobId) row.classList.add('active');
        if (item.stage === 'done') row.classList.add('stage-done');
        else if (item.stage === 'error') row.classList.add('stage-error');

        var info = document.createElement('div');
        info.className = 'job-info grow';
        var name = document.createElement('div');
        name.className = 'truncate';
        name.textContent = item.original_filename || '(névtelen fájl)';
        var meta = document.createElement('div');
        meta.className = 'job-date';
        meta.textContent = (item.target_label ? '→ ' + item.target_label + ' · ' : '') +
            (STAGE_LABEL[item.stage] || item.stage || '');
        info.appendChild(name);
        info.appendChild(meta);
        info.addEventListener('click', function () { openJob(item); });

        var actions = document.createElement('div');
        actions.className = 'row-actions';
        if (item.stage === 'done') {
            var dl = document.createElement('a');
            dl.className = 'delete-btn';
            dl.href = API + '/download/' + encodeURIComponent(item.id);
            dl.title = 'Letöltés';
            dl.setAttribute('aria-label', 'Letöltés');
            dl.textContent = '⬇';
            actions.appendChild(dl);
        }
        if (item.can_modify) {
            var del = document.createElement('button');
            del.type = 'button';
            del.className = 'delete-btn';
            del.title = 'Törlés';
            del.setAttribute('aria-label', 'Törlés');
            del.textContent = '🗑️';
            del.addEventListener('click', function (e) { e.stopPropagation(); deleteJob(item); });
            actions.appendChild(del);
        }
        row.appendChild(info);
        row.appendChild(actions);
        return row;
    }

    async function renderHistory() {
        var box = $('convertHistory');
        var items;
        try {
            items = await api('/jobs?limit=30');
        } catch (e) {
            return;            // a lista nem akut: a következő frissítés pótolja
        }
        box.textContent = '';
        if (!items || !items.length) {
            var empty = document.createElement('div');
            empty.className = 'empty-history';
            empty.textContent = 'Még nincs konverzió.';
            box.appendChild(empty);
            return;
        }
        items.forEach(function (item) { box.appendChild(historyRow(item)); });
    }

    function bindDropZone() {
        var zone = $('dropZone');
        $('pickBtn').addEventListener('click', function () { $('fileInput').click(); });
        $('fileInput').addEventListener('change', function (e) { onPick(e.target.files[0]); });
        zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('dragover'); });
        zone.addEventListener('dragleave', function () { zone.classList.remove('dragover'); });
        zone.addEventListener('drop', function (e) {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer && e.dataTransfer.files.length) onPick(e.dataTransfer.files[0]);
        });
    }

    document.addEventListener('DOMContentLoaded', async function () {
        if (typeof initSharedSession === 'function') await initSharedSession();
        var role = (typeof ensureUserInfo === 'function' && (await ensureUserInfo()) || {}).role;
        if (role === 'viewer') {
            show('viewerNotice', true);
            show('pickSection', false);
            return;
        }
        bindDropZone();
        $('targetSelect').addEventListener('change', syncRenderOptions);
        // a becslés a hossztól, az fps-től és a minőségtől is függ
        $('secondsInput').addEventListener('input', syncEstimate);
        $('fpsSelect').addEventListener('change', syncEstimate);
        $('qualitySelect').addEventListener('change', syncEstimate);
        $('convertBtn').addEventListener('click', startConversion);
        $('againBtn').addEventListener('click', convertAgain);
        $('newBtn').addEventListener('click', resetPage);
        renderHistory();
    });
})();
