// admin.js — felhasználói + audit-log admin UI.
// A backend /api/admin/* endpoint-jaira épít. Csak admin role-ű user-eknek
// érhető el (a backend 403 nem-admin esetén; a frontend a /api/whoami
// alapján rögtön elrejti a tartalmat).

const ADMIN_API = 'api/admin';

let _currentUser = null;   // a most belépett felhasználó username-je
let _pwTargetUser = null;  // a jelszó-modal célja
let _roleTargetUser = null;

async function logoutUser() {
    try { await fetch('api/logout', { method: 'POST' }); } catch (_) {}
    document.cookie = 'dub_session=; path=/; max-age=0';
    document.cookie = 'currentUser=; path=/; max-age=0';
    window.location.href = 'login.html';
}
window.logoutUser = logoutUser;

// ─── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (typeof applyOwnerDisplay === 'function') applyOwnerDisplay();
    // /api/whoami → ellenőrizzük a role-t. ensureUserInfo() visszaadja az
    // értéket — NE a window._userInfo-t olvasd, az a shared.js-ben egy
    // zárt scope-ú változó, sosem kerül window-ra.
    const info = (await ensureUserInfo()) || null;
    const role = (info && info.role) || 'editor';
    _currentUser = info && info.username;
    document.getElementById('myRoleSpan').textContent = role;
    if (role !== 'admin') {
        // Nem admin → elrejtjük az admin-tartalmat, jelezzük hogy nincs joga
        document.getElementById('notAdminMsg').style.display = 'block';
        document.getElementById('adminContent').style.display = 'none';
        return;
    }
    document.getElementById('adminContent').style.display = 'block';
    document.getElementById('notAdminMsg').style.display = 'none';
    await loadUsers();
    await loadTrash();
    await loadStorageStats();
    await loadAudit();
});

// ─── User-lista ───────────────────────────────────────────────
async function loadUsers() {
    const status = document.getElementById('usersStatus');
    status.textContent = 'Betöltés…';
    status.className = '';
    try {
        const r = await fetch(`${ADMIN_API}/users`);
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        const data = await r.json();
        // A backend közvetlenül listát ad vissza (NEM {users: [...]} objektumot).
        // Fail-open: ha valaha objektumot kezdene adni, a data.users fallback megfog.
        const users = Array.isArray(data) ? data : ((data && data.users) || []);
        renderUsers(users);
        status.textContent = `${users.length} felhasználó.`;
    } catch (e) {
        status.textContent = '❌ Hiba a betöltéskor: ' + (e.message || e);
        status.className = 'err';
    }
}
window.loadUsers = loadUsers;

function renderUsers(users) {
    const tbody = document.getElementById('usersTbody');
    if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#6b7280;">Nincs felhasználó.</td></tr>';
        return;
    }
    tbody.innerHTML = users.map(u => {
        const role = u.role || 'editor';
        const wsList = (u.workspaces || []).join(', ') || '—';
        const created = u.created_at || u.created || '—';
        const pwChanged = u.password_changed_at || '—';
        const isMe = u.username && _currentUser && u.username.toLowerCase() === _currentUser.toLowerCase();
        const meBadge = isMe ? ' <span style="color:#10b981; font-size:0.7rem;">(te)</span>' : '';
        return `
            <tr>
                <td><strong>${escapeHtml(u.username)}</strong>${meBadge}</td>
                <td><span class="role-pill role-${role}">${role.toUpperCase()}</span></td>
                <td style="color:#9ca3af; font-size:0.8rem;">${escapeHtml(wsList)}</td>
                <td style="color:#9ca3af; font-size:0.8rem;">${escapeHtml(created)}</td>
                <td style="color:#9ca3af; font-size:0.8rem;">${escapeHtml(pwChanged)}</td>
                <td>
                    <div class="user-actions">
                        <button class="btn btn-secondary" onclick="openPwModal('${escapeJs(u.username)}')">🔑 Jelszó</button>
                        <button class="btn btn-secondary" onclick="openRoleModal('${escapeJs(u.username)}','${role}')">🎭 Szerepkör</button>
                        ${isMe ? '' : `<button class="btn btn-secondary" style="color:#ef4444;border-color:#ef4444;" onclick="deleteUser('${escapeJs(u.username)}')">🗑️ Törlés</button>`}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function escapeJs(s) {
    return String(s || '').replace(/['"\\<>]/g, c => '\\' + c);
}

// ─── Új felhasználó modal ─────────────────────────────────────
function openCreateUserModal() {
    document.getElementById('cm_username').value = '';
    document.getElementById('cm_password').value = '';
    document.getElementById('cm_role').value = 'editor';
    document.getElementById('cm_status').textContent = '';
    document.getElementById('cm_status').className = 'modal-status';
    document.getElementById('createModal').classList.add('show');
    setTimeout(() => document.getElementById('cm_username').focus(), 50);
}
window.openCreateUserModal = openCreateUserModal;

function closeCreateUserModal() {
    document.getElementById('createModal').classList.remove('show');
}
window.closeCreateUserModal = closeCreateUserModal;

async function submitCreateUser() {
    const username = (document.getElementById('cm_username').value || '').trim();
    const password = document.getElementById('cm_password').value || '';
    const role = document.getElementById('cm_role').value || 'editor';
    const status = document.getElementById('cm_status');
    const btn = document.getElementById('cm_submit');
    if (!username) { status.textContent = '⚠️ Felhasználónév kötelező.'; status.className = 'modal-status warn'; return; }
    if (!password || password.length < 4) { status.textContent = '⚠️ A jelszó legalább 4 karakter legyen.'; status.className = 'modal-status warn'; return; }
    btn.disabled = true;
    status.textContent = 'Létrehozás…';
    status.className = 'modal-status';
    try {
        const r = await fetch(`${ADMIN_API}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role }),
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        status.textContent = `✓ ${username} létrehozva (${role}).`;
        status.className = 'modal-status ok';
        setTimeout(() => { closeCreateUserModal(); loadUsers(); loadAudit(); }, 700);
    } catch (e) {
        status.textContent = '❌ ' + (e.message || e);
        status.className = 'modal-status err';
    } finally {
        btn.disabled = false;
    }
}
window.submitCreateUser = submitCreateUser;

// ─── Jelszó-modal ─────────────────────────────────────────────
function openPwModal(username) {
    _pwTargetUser = username;
    document.getElementById('pw_target').textContent = username;
    document.getElementById('pw_new').value = '';
    document.getElementById('pw_status').textContent = '';
    document.getElementById('pw_status').className = 'modal-status';
    document.getElementById('pwModal').classList.add('show');
    setTimeout(() => document.getElementById('pw_new').focus(), 50);
}
window.openPwModal = openPwModal;

function closePwModal() {
    document.getElementById('pwModal').classList.remove('show');
    _pwTargetUser = null;
}
window.closePwModal = closePwModal;

async function submitPw() {
    if (!_pwTargetUser) return;
    const password = document.getElementById('pw_new').value || '';
    const status = document.getElementById('pw_status');
    const btn = document.getElementById('pw_submit');
    if (!password || password.length < 4) { status.textContent = '⚠️ A jelszó legalább 4 karakter legyen.'; status.className = 'modal-status warn'; return; }
    btn.disabled = true;
    status.textContent = 'Csere folyamatban…';
    status.className = 'modal-status';
    try {
        const r = await fetch(`${ADMIN_API}/users/${encodeURIComponent(_pwTargetUser)}/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password }),
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        status.textContent = `✓ Jelszó frissítve: ${_pwTargetUser}`;
        status.className = 'modal-status ok';
        setTimeout(() => { closePwModal(); loadUsers(); loadAudit(); }, 700);
    } catch (e) {
        status.textContent = '❌ ' + (e.message || e);
        status.className = 'modal-status err';
    } finally {
        btn.disabled = false;
    }
}
window.submitPw = submitPw;

// ─── Role-csere modal ─────────────────────────────────────────
function openRoleModal(username, currentRole) {
    _roleTargetUser = username;
    document.getElementById('rm_target').textContent = username;
    document.getElementById('rm_role').value = currentRole || 'editor';
    document.getElementById('rm_status').textContent = '';
    document.getElementById('rm_status').className = 'modal-status';
    document.getElementById('roleModal').classList.add('show');
}
window.openRoleModal = openRoleModal;

function closeRoleModal() {
    document.getElementById('roleModal').classList.remove('show');
    _roleTargetUser = null;
}
window.closeRoleModal = closeRoleModal;

async function submitRole() {
    if (!_roleTargetUser) return;
    const role = document.getElementById('rm_role').value;
    const status = document.getElementById('rm_status');
    const btn = document.getElementById('rm_submit');
    btn.disabled = true;
    status.textContent = 'Mentés…';
    status.className = 'modal-status';
    try {
        const r = await fetch(`${ADMIN_API}/users/${encodeURIComponent(_roleTargetUser)}/role`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role }),
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        const data = await r.json().catch(() => ({}));
        status.textContent = `✓ Szerepkör: ${data.old_role || '?'} → ${role}`;
        status.className = 'modal-status ok';
        setTimeout(() => { closeRoleModal(); loadUsers(); loadAudit(); }, 700);
    } catch (e) {
        status.textContent = '❌ ' + (e.message || e);
        status.className = 'modal-status err';
    } finally {
        btn.disabled = false;
    }
}
window.submitRole = submitRole;

// ─── User törlés ─────────────────────────────────────────────
async function deleteUser(username) {
    if (!confirm(`Biztosan törlöd a következő felhasználót?\n\n${username}\n\nA hozzá tartozó job-ok NEM törlődnek automatikusan (azokat külön kell takarítani).`)) return;
    try {
        const r = await fetch(`${ADMIN_API}/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        await loadUsers();
        await loadAudit();
    } catch (e) {
        alert('Törlési hiba: ' + (e.message || e));
    }
}
window.deleteUser = deleteUser;

// ─── Audit log ────────────────────────────────────────────────
async function loadAudit() {
    const status = document.getElementById('auditStatus');
    status.textContent = 'Betöltés…';
    status.className = '';
    try {
        const r = await fetch(`${ADMIN_API}/audit?limit=50`);
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        const data = await r.json();
        const entries = (data && data.entries) || data || [];
        renderAudit(Array.isArray(entries) ? entries : []);
        status.textContent = `${Array.isArray(entries) ? entries.length : 0} bejegyzés.`;
    } catch (e) {
        status.textContent = '❌ Hiba: ' + (e.message || e);
        status.className = 'err';
    }
}
window.loadAudit = loadAudit;

function renderAudit(entries) {
    const tbody = document.getElementById('auditTbody');
    if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#6b7280;">Nincs audit bejegyzés.</td></tr>';
        return;
    }
    tbody.innerHTML = entries.map(e => {
        const target = e.target_id
            ? `<code style="font-size:0.75rem;">${escapeHtml(e.target_kind || '')}:${escapeHtml(e.target_id.slice(0, 12))}</code>`
            : '—';
        return `
            <tr>
                <td style="color:#9ca3af; font-size:0.75rem; white-space:nowrap;">${escapeHtml(e.ts || '')}</td>
                <td><strong>${escapeHtml(e.user || '')}</strong> <span style="color:#6b7280; font-size:0.7rem;">${escapeHtml(e.user_role || '')}</span></td>
                <td><code style="font-size:0.78rem; color:#a5b4fc;">${escapeHtml(e.action || '')}</code></td>
                <td>${target}</td>
                <td style="color:#6b7280; font-size:0.75rem;">${escapeHtml(e.ip || '')}</td>
            </tr>
        `;
    }).join('');
}

// ─── Kuka (soft-deleted batch_queue rekordok) ──────────────────────
async function loadTrash() {
    const status = document.getElementById('trashStatus');
    if (status) { status.textContent = 'Betöltés…'; status.className = ''; }
    try {
        const r = await fetch(`${ADMIN_API}/batch/trash?limit=500`, { credentials: 'same-origin' });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        const data = await r.json();
        const items = Array.isArray(data) ? data : (data.items || []);
        renderTrash(items);
        if (status) status.textContent = `${items.length} elem a kukában.`;
    } catch (e) {
        if (status) {
            status.textContent = '❌ Hiba a betöltéskor: ' + (e.message || e);
            status.className = 'err';
        }
    }
}
window.loadTrash = loadTrash;

function renderTrash(items) {
    const tbody = document.getElementById('trashTbody');
    if (!tbody) return;
    if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#6b7280;">A kuka üres — semmit nem törölt senki az utóbbi időben.</td></tr>';
        return;
    }
    tbody.innerHTML = items.map(it => {
        const mode = it.mode || '—';
        const owner = it.owner || 'default';
        const status = it.status || '—';
        const deleted = it.deleted_at || '—';
        const fname = it.original_filename || ('item ' + it.id);
        return `
            <tr data-trash-id="${it.id}">
                <td style="font-weight:500;">${escapeHtml(fname)}</td>
                <td><code style="font-size:0.78rem; color:#a5b4fc;">${escapeHtml(mode)}</code></td>
                <td style="color:#9ca3af;">${escapeHtml(owner)}</td>
                <td style="color:#9ca3af; font-size:0.8rem;">${escapeHtml(status)}</td>
                <td style="color:#6b7280; font-size:0.75rem; white-space:nowrap;">${escapeHtml(deleted)}</td>
                <td>
                    <div class="user-actions">
                        <button class="btn btn-secondary" style="color:#10b981;border-color:#10b981;" onclick="restoreTrash(${it.id})">♻️ Visszaállítás</button>
                        <button class="btn btn-secondary" style="color:#ef4444;border-color:#ef4444;" onclick="purgeTrash(${it.id}, '${escapeJs(fname)}')">🗑️ Végleges törlés</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function restoreTrash(itemId) {
    if (!confirm('Visszaállítod a Kuka-ból a feladatot?')) return;
    try {
        const r = await fetch(`${ADMIN_API}/batch/trash/${itemId}/restore`, {
            method: 'POST',
            credentials: 'same-origin',
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        await loadTrash();
        await loadAudit();
    } catch (e) {
        alert('Visszaállítás sikertelen: ' + (e.message || e));
    }
}
window.restoreTrash = restoreTrash;

async function purgeTrash(itemId, fname) {
    if (!confirm(`VÉGLEGES törlés — ez visszavonhatatlan.\n\nFájl: ${fname}\n\nBiztos vagy benne?`)) return;
    try {
        const r = await fetch(`${ADMIN_API}/batch/trash/${itemId}/purge`, {
            method: 'DELETE',
            credentials: 'same-origin',
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        await loadTrash();
        await loadAudit();
    } catch (e) {
        alert('Végleges törlés sikertelen: ' + (e.message || e));
    }
}
window.purgeTrash = purgeTrash;

// ─── Tárhely-ürítés ──────────────────────────────────────────────
// Module-label-ek a backend mode-kulcsra (admin_jobs._KNOWN_MODES).
const _MODE_LABELS = {
    'dub_full': '🎙️ Szinkron',
    'subtitles_only': '💬 Felirat',
    'transcript_only': '📄 Leirat',
    'intro_outro': '🎬 Intro/Outro',
    'ppt_narrate': '🗣️ PPT Narráció',
    'ppt_replace': '🖼️ PPT Háttércsere',
};

async function loadStorageStats() {
    const statsEl = document.getElementById('storageStats');
    const tbody = document.getElementById('storageTbody');
    if (!tbody) return;
    statsEl.textContent = 'Tárhely-infó betöltése…';
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:#6b7280;">Betöltés…</td></tr>';
    try {
        const r = await fetch(`${ADMIN_API}/storage/stats`, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        // Disk-szintű összefoglaló
        if (data.disk) {
            const usedPct = data.disk.total > 0 ? Math.round(100 * data.disk.used / data.disk.total) : 0;
            statsEl.innerHTML = `<strong>Lemez:</strong> ${data.disk.used_human} / ${data.disk.total_human} használt (${usedPct}%) · ${data.disk.free_human} szabad`;
        } else {
            statsEl.textContent = '(Lemez-infó nem elérhető)';
        }
        // Sorok: minden mode + a 2 scratch-mappa
        const rows = [];
        for (const m of data.per_mode || []) {
            const label = _MODE_LABELS[m.mode] || m.mode;
            const btnDisabled = m.finished === 0 ? ' disabled' : '';
            rows.push(`
                <tr>
                    <td>${escapeHtml(label)}</td>
                    <td>${m.total}</td>
                    <td>${m.finished}</td>
                    <td>${escapeHtml(m.reclaimable_human)}</td>
                    <td><button class="btn btn-secondary" style="color:#ef4444;border-color:#ef4444;font-size:0.8rem;padding:4px 10px;"${btnDisabled} onclick="cleanupMode('${escapeJs(m.mode)}', '${escapeJs(label)}', ${m.finished}, '${escapeJs(m.reclaimable_human)}')">🗑️ Ürítés</button></td>
                </tr>
            `);
        }
        for (const s of data.scratch || []) {
            const isInbox = s.name === 'batch_inbox';
            const label = isInbox ? '📥 batch_inbox (staging)' : '📤 exports (kimenetek)';
            const btnDisabled = s.bytes === 0 ? ' disabled' : '';
            const fnName = isInbox ? 'cleanupBatchInbox' : 'cleanupExports';
            rows.push(`
                <tr>
                    <td>${escapeHtml(label)}</td>
                    <td colspan="2" style="color:#6b7280;">${s.exists ? '(mappa)' : '(hiányzik)'}</td>
                    <td>${escapeHtml(s.human)}</td>
                    <td><button class="btn btn-secondary" style="color:#ef4444;border-color:#ef4444;font-size:0.8rem;padding:4px 10px;"${btnDisabled} onclick="${fnName}('${escapeJs(s.human)}')">🗑️ Ürítés</button></td>
                </tr>
            `);
        }
        tbody.innerHTML = rows.join('') || '<tr><td colspan="5" style="text-align:center; color:#6b7280;">Nincs adat</td></tr>';
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#ef4444;">Hiba: ${escapeHtml(e.message || String(e))}</td></tr>`;
    }
}
window.loadStorageStats = loadStorageStats;

function _getMinAgeHours() {
    const v = parseFloat(document.getElementById('storageMinAge').value);
    return isNaN(v) || v < 0 ? 0 : v;
}

async function cleanupMode(mode, label, finishedCount, sizeHuman) {
    const minAge = _getMinAgeHours();
    const ageStr = minAge > 0 ? ` (csak ${minAge} óránál régebbi)` : ' (mind)';
    if (!confirm(`Tényleg törlöd a(z) ${label} ${finishedCount} befejezett job-ját${ageStr}? Becsült felszabaduló tárhely: ${sizeHuman}. Ez VÉGLEGES.`)) return;
    try {
        const r = await fetch(`${ADMIN_API}/storage/cleanup-mode`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: mode, min_age_hours: minAge, dry_run: false }),
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        const data = await r.json();
        alert(`✓ Kész: ${data.rows_deleted} job törölve, ${data.bytes_freed_human} felszabadítva.${data.errors && data.errors.length ? '\n\nHibák:\n' + data.errors.slice(0, 5).join('\n') : ''}`);
        await loadStorageStats();
        await loadAudit();
    } catch (e) {
        alert('Ürítés sikertelen: ' + (e.message || e));
    }
}
window.cleanupMode = cleanupMode;

async function cleanupBatchInbox(sizeHuman) {
    const minAge = _getMinAgeHours();
    const ageStr = minAge > 0 ? ` (${minAge} óránál régebbi)` : ' (mind)';
    if (!confirm(`Törlöd a batch_inbox tartalmát${ageStr}? Becsült felszabaduló tárhely: ${sizeHuman}. Ez VÉGLEGES.`)) return;
    try {
        const r = await fetch(`${ADMIN_API}/storage/cleanup-batch-inbox`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ min_age_hours: minAge, dry_run: false }),
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        const data = await r.json();
        alert(`✓ Kész: ${data.rows_deleted} elem törölve a batch_inbox-ból, ${data.bytes_freed_human} felszabadítva.`);
        await loadStorageStats();
    } catch (e) {
        alert('Ürítés sikertelen: ' + (e.message || e));
    }
}
window.cleanupBatchInbox = cleanupBatchInbox;

async function cleanupExports(sizeHuman) {
    const minAge = _getMinAgeHours();
    const ageStr = minAge > 0 ? ` (${minAge} óránál régebbi)` : ' (mind)';
    if (!confirm(`Törlöd az exports tartalmát${ageStr}? Becsült felszabaduló tárhely: ${sizeHuman}. Ez VÉGLEGES.`)) return;
    try {
        const r = await fetch(`${ADMIN_API}/storage/cleanup-exports`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ min_age_hours: minAge, dry_run: false }),
        });
        if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error(b.detail || ('HTTP ' + r.status));
        }
        const data = await r.json();
        alert(`✓ Kész: ${data.rows_deleted} elem törölve az exports-ból, ${data.bytes_freed_human} felszabadítva.`);
        await loadStorageStats();
    } catch (e) {
        alert('Ürítés sikertelen: ' + (e.message || e));
    }
}
window.cleanupExports = cleanupExports;
