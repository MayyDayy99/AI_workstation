/*
 * profile.js — self-service profile page.
 *
 * Read-only info section (username, role, current_workspace, workspaces)
 * plus a password-change form that calls POST /api/me/password.
 * Available to ALL signed-in users (not admin-only); the backend
 * verifies the current password before applying the new one.
 */
(function () {
  "use strict";

  async function loadProfile() {
    try {
      const r = await fetch("api/whoami", { credentials: "same-origin" });
      if (!r.ok) {
        // 401 → redirect to login (the shared.js auth wrapper does this
        // automatically for fetch, but here we want the page to load).
        window.location.href = "login.html";
        return;
      }
      const me = await r.json();
      _renderProfile(me);
    } catch (e) {
      console.warn("loadProfile failed:", e);
      document.getElementById("pf_username").textContent = "(hiba)";
    }
  }

  function _renderProfile(me) {
    document.getElementById("pf_username").textContent = me.username || "—";
    const rolePill = document.getElementById("pf_role");
    const role = (me.role || "editor").toLowerCase();
    rolePill.textContent = role.toUpperCase();
    rolePill.className = "role-pill role-" + role;
    document.getElementById("pf_currentWs").textContent = me.current_workspace || "—";
    const wsEl = document.getElementById("pf_workspaces");
    const wsList = Array.isArray(me.workspaces) ? me.workspaces : [];
    if (wsList.length === 0) {
      wsEl.textContent = "—";
    } else {
      wsEl.innerHTML = wsList.map(function (w) {
        return '<span class="ws-chip">' + escapeHtml(w) + "</span>";
      }).join("");
    }
  }

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  async function submitChangePassword() {
    const curEl = document.getElementById("pf_currentPw");
    const newEl = document.getElementById("pf_newPw");
    const confirmEl = document.getElementById("pf_confirmPw");
    const status = document.getElementById("pf_status");
    const btn = document.getElementById("pf_submit");
    const cur = curEl.value || "";
    const nw = newEl.value || "";
    const cn = confirmEl.value || "";

    if (!cur) {
      status.textContent = "⚠️ A jelenlegi jelszót meg kell adnod.";
      status.className = "form-status warn";
      curEl.focus();
      return;
    }
    if (!nw || nw.length < 4) {
      status.textContent = "⚠️ Az új jelszó legalább 4 karakter legyen.";
      status.className = "form-status warn";
      newEl.focus();
      return;
    }
    if (nw !== cn) {
      status.textContent = "⚠️ A két új jelszó nem egyezik.";
      status.className = "form-status warn";
      confirmEl.focus();
      return;
    }
    if (nw === cur) {
      status.textContent = "⚠️ Az új jelszó nem lehet azonos a régivel.";
      status.className = "form-status warn";
      newEl.focus();
      return;
    }

    btn.disabled = true;
    status.textContent = "Mentés…";
    status.className = "form-status";

    try {
      const r = await fetch("api/me/password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_password: cur, new_password: nw }),
      });
      if (!r.ok) {
        const b = await r.json().catch(function () { return {}; });
        throw new Error(b.detail || ("HTTP " + r.status));
      }
      status.textContent = "✓ Jelszó sikeresen frissítve.";
      status.className = "form-status ok";
      curEl.value = "";
      newEl.value = "";
      confirmEl.value = "";
    } catch (e) {
      status.textContent = "❌ " + (e.message || e);
      status.className = "form-status err";
    } finally {
      btn.disabled = false;
    }
  }

  window.submitChangePassword = submitChangePassword;
  window.loadProfile = loadProfile;

  async function logoutUser() {
    try { await fetch("api/logout", { method: "POST" }); } catch (_) { /* noop */ }
    document.cookie = "dub_session=; path=/; max-age=0";
    document.cookie = "currentUser=; path=/; max-age=0";
    window.location.href = "login.html";
  }
  window.logoutUser = logoutUser;

  // ─── Csempe-sorrend szerkesztő ─────────────────────────────────
  // A főoldal (index.html) csempéinek sorrendjét perzisztáljuk a
  // localStorage-be ("edti_hub_tile_order"). Az index.html applyTileOrder()
  // ezt olvassa és átrendezi a hub-grid-et.
  //
  // Az itt megjelenített lista a FŐOLDALON LÉTEZŐ csempéket tükrözi —
  // hardkódolva a JS-ben, mert profil-oldalon nincs index.html DOM-hozzáférés.
  // Új csempe esetén ide is fel kell venni egy sort (új funkciónál a sablon
  // a végére kerül CSS-default-tal).
  const TILE_LS_KEY = "edti_hub_tile_order";
  const TILE_DEFINITIONS = [
    { id: "dub",          icon: "🎙️", label: "Szinkron" },
    { id: "subtitle",     icon: "💬", label: "Felirat" },
    { id: "transcribe",   icon: "📄", label: "Leirat" },
    { id: "intro_outro",  icon: "🎬", label: "Intro/Outro" },
    { id: "ppt_replace",  icon: "🖼️", label: "PPT Háttércsere" },
    { id: "ppt_narrate",  icon: "🗣️", label: "PPT Narráció" },
    { id: "course",       icon: "🗂️", label: "Intelligens Tallózás" },
    { id: "flow",         icon: "🕸️", label: "Flow Builder" },
    { id: "profile",      icon: "👤", label: "Saját profil" },
    { id: "admin",        icon: "🛡️", label: "Admin (csak admin role)" },
  ];

  function _readSavedOrder() {
    try {
      const arr = JSON.parse(localStorage.getItem(TILE_LS_KEY) || "[]");
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function _writeOrder(ids) {
    try { localStorage.setItem(TILE_LS_KEY, JSON.stringify(ids)); } catch (_) {}
  }

  function _effectiveOrder() {
    // Saved order + bármi új csempe (ami a saved-en kívüli) a default-sorrend
    // szerint a végére. Ez tükrözi az index.html applyTileOrder() logikáját.
    const saved = _readSavedOrder();
    const seen = new Set();
    const out = [];
    for (const id of saved) {
      const def = TILE_DEFINITIONS.find(t => t.id === id);
      if (def && !seen.has(id)) { out.push(def); seen.add(id); }
    }
    for (const def of TILE_DEFINITIONS) {
      if (!seen.has(def.id)) out.push(def);
    }
    return out;
  }

  function _renderTileOrderList() {
    const ul = document.getElementById("tileOrderList");
    if (!ul) return;
    const order = _effectiveOrder();
    ul.innerHTML = order.map(t => `
      <li draggable="true" data-tile-id="${t.id}">
        <span class="grip" title="Húzd a sorrend átrendezéséhez">⋮⋮</span>
        <span class="tile-icon">${t.icon}</span>
        <span class="tile-label">${t.label}</span>
        <span class="tile-id">${t.id}</span>
      </li>
    `).join("");
    _attachDragHandlers();
  }

  let _dragSrc = null;
  function _attachDragHandlers() {
    const items = document.querySelectorAll("#tileOrderList li[data-tile-id]");
    items.forEach(li => {
      li.addEventListener("dragstart", (e) => {
        _dragSrc = li;
        li.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        // A FF-on muszáj setData-t hívni, különben a drag elhal
        try { e.dataTransfer.setData("text/plain", li.dataset.tileId); } catch (_) {}
      });
      li.addEventListener("dragend", () => {
        li.classList.remove("dragging");
        document.querySelectorAll("#tileOrderList li.drag-over").forEach(x => x.classList.remove("drag-over"));
        _dragSrc = null;
      });
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (_dragSrc && li !== _dragSrc) li.classList.add("drag-over");
      });
      li.addEventListener("dragleave", () => {
        li.classList.remove("drag-over");
      });
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        li.classList.remove("drag-over");
        if (!_dragSrc || li === _dragSrc) return;
        // Beillesztés: ha a célre a dragSrc-hez képest LEFELÉ esik, a célhoz
        // utána, különben elé. Egyszerűen DOM-pozíció alapján döntjük el.
        const all = Array.from(li.parentNode.children);
        const srcIdx = all.indexOf(_dragSrc);
        const dstIdx = all.indexOf(li);
        if (srcIdx < dstIdx) {
          li.parentNode.insertBefore(_dragSrc, li.nextSibling);
        } else {
          li.parentNode.insertBefore(_dragSrc, li);
        }
        _commitOrderFromDom();
      });
    });
  }

  function _commitOrderFromDom() {
    const ids = Array.from(document.querySelectorAll("#tileOrderList li[data-tile-id]"))
      .map(li => li.dataset.tileId);
    _writeOrder(ids);
    const status = document.getElementById("tileOrderStatus");
    if (status) {
      status.textContent = "✓ Sorrend mentve (a főoldal frissítéskor alkalmazza)";
      status.className = "form-status ok";
      setTimeout(() => {
        if (status.textContent.startsWith("✓")) {
          status.textContent = "";
          status.className = "form-status";
        }
      }, 2500);
    }
  }

  function resetTileOrder() {
    if (!confirm("Visszaállítod az alapértelmezett sorrendet?")) return;
    try { localStorage.removeItem(TILE_LS_KEY); } catch (_) {}
    _renderTileOrderList();
    const status = document.getElementById("tileOrderStatus");
    if (status) {
      status.textContent = "✓ Visszaállítva az alapértelmezett sorrendre";
      status.className = "form-status ok";
    }
  }
  window.resetTileOrder = resetTileOrder;

  document.addEventListener("DOMContentLoaded", function () {
    if (typeof applyOwnerDisplay === "function") applyOwnerDisplay();
    loadProfile();
    _renderTileOrderList();
  });
})();
