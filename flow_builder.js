/*
 * flow_builder.js — vanilla SVG flow-canvas, no-build.
 *
 * State-modell (canonical JSON):
 *   {
 *     nodes: [ {id, type, config, pos:{x,y}} ],
 *     edges: [ {from, from_asset, to, to_input} ],
 *     meta: { name, ... }
 *   }
 *
 * Az állapot egy plain Object — a renderert minden mutáció után újra-hívjuk.
 * Egyszerű, gyors, nem-React, de smooth.
 *
 * UX-flow:
 *   1. User drag-eli a node-paletta egy elemét a kanvasra → új node.
 *   2. Klikkel az `out` portra (jobb-oldali kis kör) → "connecting" mód.
 *   3. Egy másik node `in` portjára kattint → edge létrejön.
 *   4. Egy node-ra kattintva: jobb oldali props-panel megjelenik.
 *   5. "▶ Indítás" → upload-modal (ha kell input-fájl), majd POST /api/flow/runs.
 */
(function () {
  "use strict";

  const FLOW_API = "api/flow";

  // ─────────────────────────────────────────────────────────────────────
  // Global state
  // ─────────────────────────────────────────────────────────────────────
  const state = {
    nodes: [],       // [{id, type, config, pos:{x,y}, _runStatus?}]
    edges: [],       // [{from, from_asset, to, to_input}]
    selectedNodeId: null,
    connecting: null,  // {fromNodeId} amikor egy out-portból húzunk
    nodeTypeSpecs: {},  // a backend /api/flow/node-types válaszából
    videoLikeAssets: [],  // a backend asset_types.is_edge_compatible relaxation-setje
    templates: [],
    activeTplTab: "own",
    activeRunsPolling: null,
    currentFlowRunId: null,
    zoom: 1.0,  // 0.4 - 2.0, perzisztens localStorage-ben (lásd _loadZoom)
  };

  // ─────────────────────────────────────────────────────────────────────
  // Zoom — CSS-transform skálázás a .flow-canvas-en. A node-pozíciók és
  // edge-SVG-koordináták "logikai" koordinátarendszerben élnek (zoom-tól
  // függetlenül). A getBoundingClientRect() viszont SCREEN-pixel-koordot
  // ad — minden ilyen konverziónál osztani kell zoom-mal hogy visszakapjuk
  // a logikai értéket.
  // ─────────────────────────────────────────────────────────────────────
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 2.0;
  const ZOOM_STEP = 0.1;
  const ZOOM_LS_KEY = "edti_flow_zoom";

  function _loadZoom() {
    try {
      const v = parseFloat(localStorage.getItem(ZOOM_LS_KEY));
      if (!isNaN(v) && v >= ZOOM_MIN && v <= ZOOM_MAX) return v;
    } catch (_) { /* SecurityError in some sandbox modes */ }
    return 1.0;
  }

  function _saveZoom(v) {
    try { localStorage.setItem(ZOOM_LS_KEY, String(v)); } catch (_) {}
  }

  function _clampZoom(v) {
    if (isNaN(v)) return 1.0;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(v * 100) / 100));
  }

  function _applyZoom() {
    const canvas = document.getElementById("flowCanvas");
    if (canvas) canvas.style.transform = `scale(${state.zoom})`;
    const indicator = document.getElementById("zoomLabel");
    if (indicator) indicator.textContent = Math.round(state.zoom * 100) + "%";
  }

  function setZoom(v) {
    state.zoom = _clampZoom(v);
    _saveZoom(state.zoom);
    _applyZoom();
    _renderEdges();  // edge-koordok újraszámítása (a path-okat csak _renderEdges generálja)
  }

  function zoomIn()    { setZoom(state.zoom + ZOOM_STEP); }
  function zoomOut()   { setZoom(state.zoom - ZOOM_STEP); }
  function resetZoom() { setZoom(1.0); }

  // Fit-to-view: a state.nodes bbox-át kiszámolja és olyan zoom-ot állít be,
  // hogy minden node láthatóan beleférjen a wrap-be. (A panX/Y pan-implementáció
  // még nem kész, így clamp ZOOM_MIN .. ZOOM_MAX és csak skálát állít.)
  function fitToView() {
    if (state.nodes.length === 0) {
      setZoom(1.0);
      return;
    }
    const wrap = document.querySelector(".flow-canvas-wrap");
    if (!wrap) { setZoom(1.0); return; }
    const wr = wrap.getBoundingClientRect();
    // Bounding box a logikai node-koordok alapján (170px ≈ átlagos node szélesség).
    let maxX = 0, maxY = 0;
    for (const n of state.nodes) {
      maxX = Math.max(maxX, n.pos.x + 200);
      maxY = Math.max(maxY, n.pos.y + 100);
    }
    if (maxX === 0 || maxY === 0) { setZoom(1.0); return; }
    const fit = Math.min(wr.width / maxX, wr.height / maxY, 1.0);
    setZoom(_clampZoom(fit));
  }

  // Helper: screen-pixel (clientX/Y) → logikai canvas-koord. Minden olyan
  // helyen használjuk, ahol a felhasználói egér-eseményből canvas-belső
  // pozíciót számolunk (node-drop, node-mozgatás, edge-drag).
  function _clientToCanvas(clientX, clientY) {
    const canvas = document.getElementById("flowCanvas");
    if (!canvas) return { x: clientX, y: clientY };
    const r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) / state.zoom,
      y: (clientY - r.top) / state.zoom,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Auto-save / draft persistence — a felhasználói "ne tűnjön el" kérése.
  // Minden mutáció (node-add, edge-add, node-mozgatás befejezte, config-
  // módosítás, törlés, import) után perzisztáljuk a canonical-graph-ot
  // localStorage-be. Bootstrap-kor (a node-types betöltése után) visszahozzuk.
  // A "💾 Sablon"-mentéstől független — a draft a böngészőben él, a sablon
  // a szerveroldali DB-ben.
  // ─────────────────────────────────────────────────────────────────────
  const DRAFT_LS_KEY = "edti_flow_draft_v1";
  let _draftSaveTimer = null;

  function _saveDraft() {
    // Debounce: a 300ms-en belüli többszöri hívás (pl. drag mousemove) csak 1x ír.
    if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
    _draftSaveTimer = setTimeout(() => {
      _draftSaveTimer = null;
      try {
        if (state.nodes.length === 0) {
          // Üres flow: kitöröljük a draft-ot. (clearFlow direktben is megteszi.)
          localStorage.removeItem(DRAFT_LS_KEY);
          return;
        }
        const payload = _buildCanonical();
        payload._saved_at = Date.now(); // wall-clock, cross-session összehasonlítható
        localStorage.setItem(DRAFT_LS_KEY, JSON.stringify(payload));
      } catch (e) {
        // QuotaExceededError — explicit toast, nem maradhat csendben mint adatvesztés.
        if (e && (e.name === "QuotaExceededError" || (e.code && e.code === 22))) {
          _toast("Auto-mentés sikertelen: localStorage tele", "error");
        }
        // SecurityError / egyéb — best-effort.
      }
    }, 300);
  }

  function _loadDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_LS_KEY);
      if (!raw) return false;
      let data;
      try { data = JSON.parse(raw); } catch (_) {
        localStorage.removeItem(DRAFT_LS_KEY);  // korrupt JSON — töröljük
        return false;
      }
      if (!data || !Array.isArray(data.nodes) || data.nodes.length === 0) {
        localStorage.removeItem(DRAFT_LS_KEY);  // értelmetlen payload — töröljük
        return false;
      }
      try {
        _assertSafeNodeIds(data.nodes);  // discard a pre-fix malicious draft
      } catch (_) {
        localStorage.removeItem(DRAFT_LS_KEY);
        return false;
      }
      state.nodes = data.nodes.map(n => ({
        id: n.id,
        type: n.type,
        // Merge defaults-szal — ha backend új mandatory mezőt vezet be,
        // a régi draftok ne maradjanak hiányos config-gel.
        config: Object.assign({}, _defaultConfigFor(n.type), n.config || {}),
        pos: n.pos && typeof n.pos.x === "number" && typeof n.pos.y === "number"
          ? { x: Math.max(0, n.pos.x), y: Math.max(0, n.pos.y) }
          : { x: 100, y: 100 },
      }));
      state.edges = Array.isArray(data.edges) ? data.edges.slice() : [];
      // node-id-counter szinkronizálás
      const maxN = state.nodes.reduce((m, n) => {
        const v = parseInt(String(n.id).replace(/[^0-9]/g, ""), 10) || 0;
        return Math.max(m, v);
      }, 0);
      _nodeIdCounter = maxN;
      const nameInput = document.getElementById("flowNameInput");
      if (nameInput && data.meta && data.meta.name) nameInput.value = data.meta.name;
      return true;
    } catch (_) {
      return false;
    }
  }

  let _nodeIdCounter = 0;
  function _newNodeId() {
    _nodeIdCounter += 1;
    return "n" + _nodeIdCounter;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Undo / Redo — snapshot-stack on every mutation.
  // _snapshot() pushes the canonical JSON onto undoStack (capped at 50).
  // _undo() pops + restores; _redo() pulls from redoStack.
  // A drop-in pattern: minden mutáció-helyén explicit _snapshot() előtte,
  // mert a snapshot a PRE-state-et őrzi (Ctrl-Z visszahozza a régit).
  // ─────────────────────────────────────────────────────────────────────
  const UNDO_CAP = 50;
  let _undoStack = [];
  let _redoStack = [];
  let _snapshotMuted = false;  // _restoreSnapshot közben kapcsoljuk ki

  function _snapshot() {
    if (_snapshotMuted) return;
    try {
      const snap = JSON.stringify(_buildCanonical());
      _undoStack.push(snap);
      if (_undoStack.length > UNDO_CAP) _undoStack.shift();
      // Új user-action → a redo-stack invalidálódik (standard editor pattern).
      _redoStack.length = 0;
      _updateUndoRedoUI();
    } catch (_) { /* JSON.stringify defensive */ }
  }

  function _restoreSnapshot(json) {
    try {
      const data = JSON.parse(json);
      _assertSafeNodeIds(data.nodes);  // defense-in-depth; snapshots are already validated upstream
      _snapshotMuted = true;
      state.nodes = (data.nodes || []).map(n => ({
        id: n.id,
        type: n.type,
        config: Object.assign({}, _defaultConfigFor(n.type), n.config || {}),
        pos: n.pos && typeof n.pos.x === "number" ? { x: n.pos.x, y: n.pos.y } : { x: 100, y: 100 },
      }));
      state.edges = Array.isArray(data.edges) ? data.edges.slice() : [];
      state.selectedNodeId = null;
      const maxN = state.nodes.reduce((m, n) => {
        const v = parseInt(String(n.id).replace(/[^0-9]/g, ""), 10) || 0;
        return Math.max(m, v);
      }, 0);
      _nodeIdCounter = Math.max(_nodeIdCounter, maxN);
      const nameInput = document.getElementById("flowNameInput");
      if (nameInput && data.meta && data.meta.name) nameInput.value = data.meta.name;
      _renderAll();
      _saveDraft();
    } catch (e) {
      _toast("Visszaállítás hiba: " + (e && e.message ? e.message : e), "error");
    } finally {
      _snapshotMuted = false;
    }
  }

  function undo() {
    if (_undoStack.length === 0) return;
    // Mentsük a JELENLEGI állapotot a redo-stack-re, hogy Ctrl-Shift-Z visszahozza.
    try { _redoStack.push(JSON.stringify(_buildCanonical())); } catch (_) {}
    const prev = _undoStack.pop();
    _restoreSnapshot(prev);
    _updateUndoRedoUI();
  }

  function redo() {
    if (_redoStack.length === 0) return;
    // A jelenlegi állapot vissza-pusholása az undo-ra (szimmetria).
    try { _undoStack.push(JSON.stringify(_buildCanonical())); } catch (_) {}
    const next = _redoStack.pop();
    _restoreSnapshot(next);
    _updateUndoRedoUI();
  }

  function _updateUndoRedoUI() {
    const ub = document.getElementById("undoBtn");
    const rb = document.getElementById("redoBtn");
    if (ub) ub.disabled = _undoStack.length === 0;
    if (rb) rb.disabled = _redoStack.length === 0;
  }

  // ─────────────────────────────────────────────────────────────────────
  // confirmDialog — Promise-alapú custom-modal a native confirm() helyett.
  // Drop-in: minden korábbi confirm(...) helyén `await confirmDialog(...)`
  // hívható. Mégse → Promise resolves false; OK → true.
  // ─────────────────────────────────────────────────────────────────────
  function confirmDialog(title, message) {
    return new Promise((resolve) => {
      const overlay = document.getElementById("confirmModal");
      const titleEl = document.getElementById("confirmModalTitle");
      const msgEl = document.getElementById("confirmModalMsg");
      const okBtn = document.getElementById("confirmModalOk");
      const cancelBtn = document.getElementById("confirmModalCancel");
      if (!overlay || !okBtn || !cancelBtn) {
        // Fallback: a markup hiányzik (régi cache?) — vissza a natívra.
        resolve(window.confirm((title ? title + "\n" : "") + (message || "")));
        return;
      }
      if (titleEl) titleEl.textContent = title || "Megerősítés";
      if (msgEl) msgEl.textContent = message || "";
      let _resolved = false;
      const cleanup = (val) => {
        if (_resolved) return;
        _resolved = true;
        overlay.classList.remove("show");
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey);
        overlay.removeEventListener("click", onOverlayClick);
        resolve(val);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onKey = (e) => {
        if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
        else if (e.key === "Enter") { e.preventDefault(); cleanup(true); }
      };
      const onOverlayClick = (e) => {
        if (e.target === overlay) cleanup(false);
      };
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey);
      overlay.addEventListener("click", onOverlayClick);
      overlay.classList.add("show");
      // Auto-focus az OK-re — Enter azonnal megerősíti.
      setTimeout(() => okBtn.focus(), 30);
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Graph validator (kliens-oldali, save-template gomb-state-hez).
  // Backend végzi a kanonikus ellenőrzést, de a UI-ban early-feedback kell.
  // ─────────────────────────────────────────────────────────────────────
  function _validateGraph() {
    const errors = [];
    const warns = [];
    if (state.nodes.length === 0) {
      errors.push("Üres flow (nincs node).");
      return { ok: false, errors, warns };
    }
    const uploadCount = state.nodes.filter(n => n.type === "upload").length;
    const nonUploadCount = state.nodes.filter(n => n.type !== "upload").length;
    if (uploadCount === 0) errors.push("Legalább egy upload node szükséges.");
    if (nonUploadCount === 0) errors.push("Legalább egy nem-upload (funkcionális) node szükséges.");

    // Cycle detection (DFS — egy ős és utód-irány).
    const adj = {};
    for (const n of state.nodes) adj[n.id] = [];
    for (const e of state.edges) {
      if (adj[e.from]) adj[e.from].push(e.to);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = {};
    for (const n of state.nodes) color[n.id] = WHITE;
    let hasCycle = false;
    function dfs(u) {
      if (hasCycle) return;
      color[u] = GRAY;
      for (const v of (adj[u] || [])) {
        if (color[v] === GRAY) { hasCycle = true; return; }
        if (color[v] === WHITE) dfs(v);
      }
      color[u] = BLACK;
    }
    for (const n of state.nodes) {
      if (color[n.id] === WHITE) dfs(n.id);
    }
    if (hasCycle) errors.push("Cyklikus gráf detektálva (DFS).");

    // Orphan: olyan node ami sem be-, sem ki-élt nem hordoz (csak ha >1 node).
    if (state.nodes.length > 1) {
      const inDeg = {}, outDeg = {};
      for (const n of state.nodes) { inDeg[n.id] = 0; outDeg[n.id] = 0; }
      for (const e of state.edges) {
        if (outDeg[e.from] != null) outDeg[e.from] += 1;
        if (inDeg[e.to] != null) inDeg[e.to] += 1;
      }
      const orphans = state.nodes.filter(n => inDeg[n.id] === 0 && outDeg[n.id] === 0);
      if (orphans.length > 0) {
        warns.push(`Árva node-ok (élek nélkül): ${orphans.map(n => n.id).join(", ")}`);
      }
    }
    return { ok: errors.length === 0, errors, warns };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Bootstrap
  // ─────────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", async () => {
    if (typeof initSharedSession === "function") {
      try { await initSharedSession(); } catch (_) {}
    }
    // Ha a session lejárt → shared.js redirectel /login.html-re. A page-unload
    // alatti fetch-ek csak 401-toast-kaszkádot okoznak. Short-circuit.
    if (document.location.pathname.endsWith("login.html")) return;
    await _loadNodeTypes();
    await _loadTemplates();
    _renderPalette();
    _setupCanvasInteraction();
    _setupUploadModal();
    _setupSaveTemplateModalEvents();
    _refreshRunsPolling();
    // Zoom alkalmazása (localStorage-ból, default 1.0)
    state.zoom = _loadZoom();
    _applyZoom();
    // Draft visszahozása: a legutóbb épített flow MARADJON OTT (mentés nélkül is).
    // Ez nincs összekötve a "💾 Sablon" funkcióval — az szerveres DB-be megy.
    if (_loadDraft()) {
      _renderAll();
      _showRestoreBanner(state.nodes.length, state.edges.length);
    }
    _updateUndoRedoUI();
  });

  // ─────────────────────────────────────────────────────────────────────
  // API loaders
  // ─────────────────────────────────────────────────────────────────────
  async function _loadNodeTypes() {
    try {
      const r = await fetch(`${FLOW_API}/node-types`, { credentials: "same-origin" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      // New response shape: {node_types: [...], video_like_assets: [...]}
      // Old response shape (kept for hot-reload compatibility): [...]
      const list = Array.isArray(data) ? data : (data.node_types || []);
      const videoLike = Array.isArray(data) ? [] : (data.video_like_assets || []);
      const map = {};
      for (const t of list) map[t.name] = t;
      state.nodeTypeSpecs = map;
      state.videoLikeAssets = videoLike;
    } catch (e) {
      _toast("Node-típusok betöltése sikertelen: " + _humanizeError(e), "error");
    }
  }

  async function _loadTemplates() {
    try {
      const r = await fetch(`${FLOW_API}/templates`, { credentials: "same-origin" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      state.templates = await r.json();
      _renderTemplateList();
    } catch (e) {
      // Csendes — a saját-sablon-lista üres, OK az 1.0-ban
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Palette
  // ─────────────────────────────────────────────────────────────────────
  function _renderPalette() {
    const el = document.getElementById("nodePalette");
    if (!el) return;
    // Empty-specs (fetch fail) → persistent retry blokk, ne csak 3.5s toast.
    if (Object.keys(state.nodeTypeSpecs).length === 0) {
      el.innerHTML = `
        <div class="fb-error">
          ⚠️ Node-típusok betöltése sikertelen.
          <button id="paletteRetryBtn" class="btn btn-secondary mt-2 full-width text-xs">🔄 Újratöltés</button>
        </div>
      `;
      const retry = document.getElementById("paletteRetryBtn");
      if (retry) retry.addEventListener("click", async () => {
        retry.disabled = true;
        retry.textContent = "Töltés…";
        await _loadNodeTypes();
        _renderPalette();
      });
      return;
    }
    // Custom display order: upload (forrás) → funkcionális node-ok → download (cél).
    // A backend NODE_TYPES insertion-order-je adja az "értelmes" sorrendet a
    // funkcionálisokra, csak az upload és download paletta-pozícióját rögzítjük.
    const order = ["upload", "dub", "subtitle", "transcribe", "intro_outro", "ppt_narrate", "ppt_replace", "download"];
    const all = Object.values(state.nodeTypeSpecs);
    const items = order
      .map(n => all.find(t => t.name === n))
      .filter(Boolean)
      .concat(all.filter(t => !order.includes(t.name)));
    el.innerHTML = items.map(t => {
      const isSource = t.name === "upload";
      const isSink = t.name === "download";
      const extra = isSource ? ' fb-node-source' : (isSink ? ' fb-node-sink' : '');
      return `
        <div class="palette-node${extra}" draggable="true" data-node-type="${t.name}" title="${_esc(t.description || "")}">${_esc(t.label || t.name)}</div>
      `;
    }).join("");
    el.querySelectorAll(".palette-node").forEach(node => {
      node.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", node.dataset.nodeType);
        e.dataTransfer.effectAllowed = "copy";
      });
    });
  }

  function _renderTemplateList() {
    const el = document.getElementById("templateList");
    if (!el) return;
    const tab = state.activeTplTab;
    // (workspace info-t a backend nem küld a /api/whoami nélkül — egyszerűsítés:
    //  saját = visibility=private; workspace = visibility=workspace;
    //  shared = visibility=shared. Az 1.0-ban ez elég.)
    const filtered = state.templates.filter(t => {
      if (tab === "own") return t.visibility === "private";
      if (tab === "workspace") return t.visibility === "workspace";
      if (tab === "shared") return t.visibility === "shared";
      return true;
    });
    if (filtered.length === 0) {
      el.innerHTML = `<div class="text-xs text-muted">Nincs sablon ebben a kategóriában.</div>`;
    } else {
      el.innerHTML = filtered.map(t => `
        <div class="tpl-item" data-tpl-id="${t.id}">
          <div>
            <div class="tpl-name">${_esc(t.name)}</div>
            <div class="tpl-meta">${_esc(t.owner)} · ${_esc((t.updated_at || "").slice(0, 16))}</div>
          </div>
          <span class="text-xs text-accent">↗</span>
        </div>
      `).join("");
      el.querySelectorAll(".tpl-item").forEach(item => {
        item.addEventListener("click", () => _loadTemplateIntoCanvas(item.dataset.tplId));
      });
    }
    // Tab-kapcsolók
    document.querySelectorAll(".tpl-tab").forEach(tabEl => {
      tabEl.classList.toggle("active", tabEl.dataset.tplTab === tab);
      tabEl.onclick = () => {
        state.activeTplTab = tabEl.dataset.tplTab;
        _renderTemplateList();
      };
    });
  }

  async function _loadTemplateIntoCanvas(tplId) {
    const tpl = state.templates.find(t => t.id === tplId);
    if (!tpl) return;
    // Confirm-guard: a kanvas tartalma elveszne, ezért confirm-mel kérdezünk.
    // Egyezzen meg a clearFlow + applyImport viselkedésével.
    if (state.nodes.length > 0) {
      const ok = await confirmDialog("Sablon betöltése", `Biztosan felülírod a jelenlegi flow-t a(z) "${tpl.name}" sablonnal?`);
      if (!ok) return;
    }
    _snapshot();
    try {
      const graph = JSON.parse(tpl.graph_json);
      _assertSafeNodeIds(graph.nodes);
      state.nodes = (graph.nodes || []).map(n => ({
        id: n.id,
        type: n.type,
        config: n.config || {},
        pos: n.pos || { x: 100, y: 100 },
      }));
      state.edges = graph.edges || [];
      state.selectedNodeId = null;
      // Refresh node-id-counter, hogy ne ütközzön
      const maxN = state.nodes.reduce((m, n) => {
        const v = parseInt(String(n.id).replace(/[^0-9]/g, ""), 10) || 0;
        return Math.max(m, v);
      }, 0);
      _nodeIdCounter = maxN;
      document.getElementById("flowNameInput").value = tpl.name + " (példány)";
      _renderAll();
      _saveDraft();
      _toast(`✓ Sablon "${tpl.name}" betöltve`, "ok");
      _warnIfImportedGraphInvalid();
    } catch (e) {
      _toast("Sablon-betöltési hiba: " + e.message, "error");
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Canvas interaction
  // ─────────────────────────────────────────────────────────────────────
  function _setupCanvasInteraction() {
    const canvas = document.getElementById("flowCanvas");
    if (!canvas) return;
    const wrap = canvas.parentElement;  // .flow-canvas-wrap

    // Mousewheel zoom: a wrap-en kezeljük (a canvas mögötti grid-háttér is itt él).
    // Ctrl/Cmd modifier nélkül is hat — a wrap-ben nincs scrollozható tartalom,
    // a sima wheel itt szóhoz se jutna. preventDefault hogy a page ne scrollózzon.
    if (wrap) {
      wrap.addEventListener("wheel", (e) => {
        // Ne kezeljük a wheel-eseményt, ha a user a runs-panelre tekert
        if (e.target && e.target.closest && e.target.closest(".flow-runs-panel")) return;
        // Edge-drag közben ne zoomoljunk — _renderEdges()-t hívna ami a preview
        // path-ot detacheli + a startX/Y stale zoom-mal lenne mentve.
        if (_edgeDrag) return;
        e.preventDefault();
        const dir = e.deltaY < 0 ? 1 : -1;
        setZoom(state.zoom + dir * ZOOM_STEP);
      }, { passive: false });
    }

    canvas.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      const type = e.dataTransfer.getData("text/plain");
      if (!type) return;
      // _clientToCanvas() figyeli a zoom-ot — anélkül scale-elt canvas-on
      // a node "elcsúszik" a kursor alól.
      const p = _clientToCanvas(e.clientX, e.clientY);
      _addNode(type, p.x - 85, p.y - 25);
    });
    // Klikkelés az üres canvas-ra: deselect + kapcsolat megszakítás
    canvas.addEventListener("click", (e) => {
      if (e.target === canvas || e.target.tagName === "svg") {
        state.selectedNodeId = null;
        state.connecting = null;
        _renderAll();
      }
    });
  }

  function _addNode(type, x, y) {
    _snapshot();
    // Auto-add csak akkor: a user funkcionális node-dal kezd ÉS nincs még upload.
    // Ha user-húzta upload-tal kezd, semmi auto-add nem fut — ő kezdi a flow-t.
    // Az auto-added upload NEM kapcsolódik automatikusan: a user maga köti rá
    // (OCD-szempont — "ne kezdjen helyettem").
    const hasUpload = state.nodes.some(n => n.type === "upload");
    // Ha a user-node bal-szélre kerülne (x<240), shifteljük jobbra hogy az
    // auto-injected upload-node (170px min-width + 20px gap = 220px-os
    // baloldali lábnyom) ne fedjen át.
    let userX = Math.max(20, x);
    if (!hasUpload && type !== "upload" && type !== "download" && userX < 240) {
      userX = 240;
    }
    if (!hasUpload && type !== "upload" && type !== "download") {
      state.nodes.push({
        id: _newNodeId(),
        type: "upload",
        config: {},
        pos: { x: Math.max(20, userX - 220), y: Math.max(20, y) },
      });
    }
    const node = {
      id: _newNodeId(),
      type: type,
      config: _defaultConfigFor(type),
      pos: { x: userX, y: Math.max(20, y) },
    };
    state.nodes.push(node);
    state.selectedNodeId = node.id;
    _renderAll();
    _saveDraft();
  }

  function _defaultConfigFor(type) {
    switch (type) {
      case "dub": return { language: "hun", preset: "youtube", loudness: false };
      case "subtitle": return {};
      case "transcribe": return {};
      case "intro_outro": return { theme: "sajat", preset: "youtube", language: "hun", loudness: false };
      case "ppt_narrate": return { language: "hu", empty_slide_dur: 3.0 };
      case "ppt_replace": return {};
      case "download": return {};
      default: return {};
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Node rendering + dragging
  // ─────────────────────────────────────────────────────────────────────
  // Module-szintű drag-state — egyetlen document.mousemove/mouseup listenerre
  // szűkítve. Korábban a _attachNodeEvents minden _renderAll-onként minden
  // node-ra UJABB document listenert kötött, ami GC-leak + CPU degradál.
  let _activeDrag = null;  // {nodeId, startX, startY, nodeX, nodeY}

  function _renderAll() {
    _renderNodes();
    _renderEdges();
    _renderProps();
  }

  function _renderNodes() {
    const canvas = document.getElementById("flowCanvas");
    if (!canvas) return;
    // Megőrizzük a SVG-réteget, csak a node-DOM-okat cseréljük.
    Array.from(canvas.querySelectorAll(".flow-node, .flow-asset-chip")).forEach(n => n.remove());
    // Empty-canvas onboarding overlay — toggle a state.nodes.length alapján.
    let onboard = canvas.querySelector(".canvas-onboarding");
    if (state.nodes.length === 0) {
      if (!onboard) {
        onboard = document.createElement("div");
        onboard.className = "canvas-onboarding";
        onboard.innerHTML = "<div class='fb-empty-icon'>📐</div><div class='fb-empty-title'>Üres kanvas</div><div class='text-sm text-secondary'>Húzz ide egy csempét a bal oldali palettáról<br>vagy tölts be egy sablont.</div>";
        canvas.appendChild(onboard);
      }
    } else if (onboard) {
      onboard.remove();
    }

    for (const node of state.nodes) {
      const spec = state.nodeTypeSpecs[node.type] || {};
      const div = document.createElement("div");
      div.className = "flow-node" + (node.id === state.selectedNodeId ? " selected" : "");
      if (node._runStatus) div.classList.add("status-" + node._runStatus);
      div.style.left = node.pos.x + "px";
      div.style.top = node.pos.y + "px";
      div.dataset.nodeId = node.id;
      const hasIn = node.type !== "upload";
      const hasOut = node.type !== "download";
      // Upload node-on jelezzük a már feltöltött fájlt (config.uploaded_filename),
      // VAGY coachmark ha még nincs (segít az első használatnál).
      let uploadBadge = "";
      if (node.type === "upload") {
        if (node.config && node.config.uploaded_filename) {
          uploadBadge = `<div class="upload-file-badge" title="${_esc(node.config.uploaded_path || '')}">📎 ${_esc(node.config.uploaded_filename)}</div>`;
        } else {
          uploadBadge = `<div class="upload-file-badge is-selected">📁 Válassz fájlt jobbra →</div>`;
        }
      }
      div.innerHTML = `
        <div class="node-title">${_esc(spec.label || node.type)}</div>
        <div class="node-type">${_esc(node.type)}</div>
        ${uploadBadge}
        ${node._runStatus ? `<span class="node-status">${_esc(node._runStatus)}</span>` : ""}
        ${hasIn ? '<div class="node-port in" data-port="in" title="Bemenet — húzz ide egy másik node kimenetétől"></div>' : ""}
        ${hasOut ? '<div class="node-port out" data-port="out" title="Kimenet — húzd át egy másik node bemenetére"></div>' : ""}
        <div class="node-delete" title="Törlés">×</div>
      `;
      canvas.appendChild(div);

      _attachNodeEvents(div, node);
    }
  }

  function _attachNodeEvents(div, node) {
    // Drag (mozgatás) — csak a mousedown-t kötjük a node-ra. A document.mousemove
    // és mouseup listenert egyszer-globálisan kötjük (module init).
    div.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("node-port") || e.target.classList.contains("node-delete")) return;
      _activeDrag = {
        nodeId: node.id,
        startX: e.clientX,
        startY: e.clientY,
        nodeX: node.pos.x,
        nodeY: node.pos.y,
        _snapshotted: false,  // a tényleges mozdulásnál snapshot-elünk, nem minden mousedown-on
      };
      e.preventDefault();
    });

    div.addEventListener("click", (e) => {
      if (e.target.classList.contains("node-port") || e.target.classList.contains("node-delete")) return;
      state.selectedNodeId = node.id;
      _renderAll();
      e.stopPropagation();
    });

    // Drag-line-os edge-rajzolás (n8n-stílus).
    // Bárhonnan (out vagy in port) lehet kezdeni a húzást — mouseup-kor
    // a cél port típusa eldönti melyik az output, melyik az input.
    div.querySelectorAll(".node-port").forEach(port => {
      port.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const which = port.dataset.port;
        _startEdgeDrag(node.id, which, e.clientX, e.clientY);
      });
    });

    // Törlés-gomb
    const del = div.querySelector(".node-delete");
    if (del) {
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        _deleteNode(node.id);
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Asset-compatibility helpers — replikálja a backend
  // asset_types.is_edge_compatible logikáját client-side, hogy a felhasználó
  // drag közben lássa: melyik port piros (inkompatibilis), melyik zöld (OK).
  // ─────────────────────────────────────────────────────────────────────
  // Fallback video-like asset names — csak akkor használjuk, ha a backend
  // /api/flow/node-types válaszában HIÁNYZIK a video_like_assets mező.
  // A backend-side asset_types.py-ban deklarált lista AZ AUTORITATÍV — ezt csak
  // hiba/elavult válasz esetén alkalmazzuk, és warn-olunk a konzolon.
  const _FALLBACK_VIDEO_LIKE = ["raw_video", "branded_video", "subtitled_video", "dubbed_video"];
  let _fallbackWarned = false;

  function _resolveVideoLikeAssets() {
    if (Array.isArray(state.videoLikeAssets) && state.videoLikeAssets.length > 0) {
      return state.videoLikeAssets;
    }
    // A backend-válasz hiányzik vagy üres — fallbackra esünk, de egyszer figyelmeztetünk.
    if (!_fallbackWarned) {
      _fallbackWarned = true;
      console.warn(
        "[flow_builder] Backend /api/flow/node-types nem küldött video_like_assets-et; " +
        "kliens fallback listára esett (lehet desync). Ellenőrizd a backend válaszát."
      );
    }
    return _FALLBACK_VIDEO_LIKE;
  }

  function _isAssetPairCompatible(producerAssetType, consumerExpectedType) {
    if (!producerAssetType || !consumerExpectedType) return false;
    if (producerAssetType === consumerExpectedType) return true;
    // Video-like relaxation (mirror of backend asset_types.py).
    // A dinamikus backend-lista MINDIG ELŐNYBEN — csak hiánya esetén fallback.
    if (consumerExpectedType === "raw_video" &&
        _resolveVideoLikeAssets().includes(producerAssetType)) {
      return true;
    }
    return false;
  }

  /**
   * Smart-pick: bejár minden producer.output × consumer.input párt és
   * visszaadja az ELSŐ kompatibilist {fromOutput, toInput, fromAssetType}.
   * Ha egyik pár sem kompatibilis, null.
   *
   * A backend ezt valós futáskor szigorúan ellenőrzi — a FE-nek a "legjobb
   * kompatibilis" párt kell felajánlania.
   *
   * skipInputs: a fogyasztó MÁR bekötött input-slotjai — ezeket kihagyjuk,
   * hogy egy multi-input node (pl. ppt_replace: input_video + input_pptx,
   * ppt_narrate: input_pptx + voice_ref) második szülője a KÖVETKEZŐ szabad
   * kompatibilis slotot kapja, ne ütközzön az elsővel.
   */
  function _findCompatiblePortPair(producerType, consumerType, skipInputs) {
    const pSpec = state.nodeTypeSpecs[producerType];
    const cSpec = state.nodeTypeSpecs[consumerType];
    if (!pSpec || !cSpec) return null;
    const pOuts = pSpec.outputs_full || {};
    const cIns = cSpec.inputs_full || {};
    const skip = skipInputs instanceof Set ? skipInputs : new Set(skipInputs || []);
    // Iteráció a backend insertion-order szerint (modern JS-ben ez stabil).
    for (const outName of Object.keys(pOuts)) {
      const outAssetType = (pOuts[outName] || {}).asset_type;
      for (const inName of Object.keys(cIns)) {
        if (skip.has(inName)) continue;
        const inExpected = cIns[inName];
        if (_isAssetPairCompatible(outAssetType, inExpected)) {
          return {
            fromOutput: outName,
            toInput: inName,
            fromAssetType: outAssetType,
            toExpectedType: inExpected,
          };
        }
      }
    }
    return null;
  }

  function _arePortsCompatibleForEdge(sourceNodeId, sourcePortSide, targetNodeId, targetPortSide) {
    // A két port irányának (out vs in) ellenkezőnek kell lennie.
    if (sourcePortSide === targetPortSide) return false;
    const sourceNode = state.nodes.find(n => n.id === sourceNodeId);
    const targetNode = state.nodes.find(n => n.id === targetNodeId);
    if (!sourceNode || !targetNode) return false;
    // Producer / consumer eldöntése a port-iránya alapján
    const producerNode = sourcePortSide === "out" ? sourceNode : targetNode;
    const consumerNode = sourcePortSide === "out" ? targetNode : sourceNode;
    return _findCompatiblePortPair(producerNode.type, consumerNode.type) !== null;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Drag-based edge creation (n8n-stílus)
  // ─────────────────────────────────────────────────────────────────────
  let _edgeDrag = null;  // {nodeId, portSide ('out'|'in'), startX, startY}
  let _edgePreviewPath = null;

  function _startEdgeDrag(nodeId, portSide, startX, startY) {
    const canvas = document.getElementById("flowCanvas");
    if (!canvas) return;
    // Az svg-edge a transform-elt canvas-on belül van — a path-koordok
    // LOGIKAI canvas-szintűek, nem screen-pixel.
    const p = _clientToCanvas(startX, startY);
    _edgeDrag = { nodeId, portSide, startX: p.x, startY: p.y };

    // Preview SVG-path létrehozás
    const svg = document.getElementById("flowEdges");
    if (svg) {
      _edgePreviewPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      // Az SVG PREZENTÁCIÓS ATTRIBÚTUM nem vesz fel CSS-változót
      // (stroke="var(--x)" érvénytelen), ezért a szín osztályból jön —
      // a .flow-edge-preview a flow.html lap-szintű --flow-accent-jét olvassa.
      _edgePreviewPath.setAttribute("class", "flow-edge-preview");
      _edgePreviewPath.setAttribute("fill", "none");
      _edgePreviewPath.style.pointerEvents = "none";
      svg.appendChild(_edgePreviewPath);
    }
    // Target-portok highlightolása asset-kompatibilitás szerint.
    // ZÖLD pulse → kompatibilis (highlight-target), PIROS pulse → inkompatibilis
    // (highlight-incompat — új CSS state). Így a user húzás közben azonnal
    // lát, melyik portra érdemes és melyikre nincs értelme húzni.
    canvas.querySelectorAll(".flow-node").forEach(nd => {
      if (nd.dataset.nodeId === nodeId) return;
      const oppositePort = nd.querySelector(`.node-port.${portSide === "out" ? "in" : "out"}`);
      if (!oppositePort) return;
      const compatible = _arePortsCompatibleForEdge(
        nodeId, portSide,
        nd.dataset.nodeId, portSide === "out" ? "in" : "out"
      );
      oppositePort.classList.add(compatible ? "highlight-target" : "highlight-incompat");
    });
  }

  function _updateEdgeDragPreview(clientX, clientY) {
    if (!_edgeDrag || !_edgePreviewPath) return;
    const sx = _edgeDrag.startX;
    const sy = _edgeDrag.startY;
    // Az endpoint screen → logikai canvas-koord konverzió zoom-osztással.
    const p = _clientToCanvas(clientX, clientY);
    const ex = p.x;
    const ey = p.y;
    const mx = (sx + ex) / 2;
    _edgePreviewPath.setAttribute("d", `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ey}, ${ex} ${ey}`);
  }

  function _endEdgeDrag(clientX, clientY) {
    if (!_edgeDrag) return;
    // Preview SVG-path eltávolítása
    if (_edgePreviewPath && _edgePreviewPath.parentNode) {
      _edgePreviewPath.parentNode.removeChild(_edgePreviewPath);
    }
    _edgePreviewPath = null;
    // Highlight eltávolítása (mindkét állapot: kompatibilis + inkompatibilis)
    document.querySelectorAll(".node-port.highlight-target, .node-port.highlight-incompat")
      .forEach(p => p.classList.remove("highlight-target", "highlight-incompat"));

    // Megtaláljuk a célt: melyik node-port van a kursor alatt?
    const target = document.elementFromPoint(clientX, clientY);
    if (target && target.classList.contains("node-port")) {
      const targetNodeDiv = target.closest(".flow-node");
      const targetNodeId = targetNodeDiv ? targetNodeDiv.dataset.nodeId : null;
      const targetPortSide = target.dataset.port;
      if (targetNodeId && targetNodeId !== _edgeDrag.nodeId &&
          targetPortSide !== _edgeDrag.portSide) {
        // Asset-kompatibilitás check MIELŐTT létrehozzuk az edge-et.
        // Ha nem kompatibilis, ne hozzunk létre edge-et a kanvason — a
        // backend úgyis elutasítaná mentésnél. Specifikus mismatch-üzenet.
        const compatible = _arePortsCompatibleForEdge(
          _edgeDrag.nodeId, _edgeDrag.portSide,
          targetNodeId, targetPortSide
        );
        if (!compatible) {
          const dragNode = state.nodes.find(n => n.id === _edgeDrag.nodeId);
          const targetNode = state.nodes.find(n => n.id === targetNodeId);
          const producerNode = _edgeDrag.portSide === "out" ? dragNode : targetNode;
          const consumerNode = _edgeDrag.portSide === "out" ? targetNode : dragNode;
          const pSpec = state.nodeTypeSpecs[producerNode.type] || {};
          const cSpec = state.nodeTypeSpecs[consumerNode.type] || {};
          const pOuts = Object.keys(pSpec.outputs_full || {}).join(", ") || "(nincs)";
          const cIns = Object.keys(cSpec.inputs_full || {}).join(", ") || "(nincs)";
          _toast(
            `❌ Asset-mismatch: ${pSpec.label || producerNode.type} (kimenetek: ${pOuts}) NEM köthető ide: ${cSpec.label || consumerNode.type} (bemenetek: ${cIns})`,
            "error"
          );
          _edgeDrag = null;
          return;
        }
        // Egyezik: az egyik out, a másik in. Az out → in irány.
        let fromId, toId;
        if (_edgeDrag.portSide === "out") {
          fromId = _edgeDrag.nodeId;
          toId = targetNodeId;
        } else {
          fromId = targetNodeId;
          toId = _edgeDrag.nodeId;
        }
        _createEdgeBetween(fromId, toId);
        _edgeDrag = null;
        _renderAll();
        return;
      }
    }
    // Nem talált célt — silent cancel (üres canvas-ra való release egy normál
    // cancel-gesture, nem error). Csak ha conkrét node-portra esett kombatibilitási
    // checken belül, akkor ad error toast-ot a fenti specifikus üzenet.
    _edgeDrag = null;
  }

  // Globális mousemove + mouseup — egyetlen handler az egész module-on át.
  // Konzultálja az _activeDrag (node-mozgatás) és _edgeDrag (port-húzás)
  // state-eket. Korábban PER-NODE bindelődött, ami leakelt minden _renderAll-on.
  document.addEventListener("mousemove", (e) => {
    if (_activeDrag) {
      const node = state.nodes.find(n => n.id === _activeDrag.nodeId);
      if (node) {
        const dx = (e.clientX - _activeDrag.startX) / state.zoom;
        const dy = (e.clientY - _activeDrag.startY) / state.zoom;
        // Csak az első tényleges mozdulásnál snapshot-elünk (click vs drag különbség).
        if (!_activeDrag._snapshotted && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
          _activeDrag._snapshotted = true;
          _snapshot();
        }
        node.pos.x = Math.max(0, _activeDrag.nodeX + dx);
        node.pos.y = Math.max(0, _activeDrag.nodeY + dy);
        const div = document.querySelector(`.flow-node[data-node-id="${node.id}"]`);
        if (div) {
          div.style.left = node.pos.x + "px";
          div.style.top = node.pos.y + "px";
        }
        _renderEdges();
      }
    }
    if (_edgeDrag) _updateEdgeDragPreview(e.clientX, e.clientY);
  });
  document.addEventListener("mouseup", (e) => {
    if (_activeDrag) {
      _activeDrag = null;
      _saveDraft();
    }
    if (_edgeDrag) _endEdgeDrag(e.clientX, e.clientY);
  });

  // Escape + window-blur → edge-drag abort. Mouseup window-on kívül + Esc
  // gomb mid-drag korábban "bent ragadt" preview path-ot hagyott.
  function _abortEdgeDrag() {
    if (!_edgeDrag) return;
    if (_edgePreviewPath && _edgePreviewPath.parentNode) {
      _edgePreviewPath.parentNode.removeChild(_edgePreviewPath);
    }
    _edgePreviewPath = null;
    document.querySelectorAll(".node-port.highlight-target, .node-port.highlight-incompat")
      .forEach(p => p.classList.remove("highlight-target", "highlight-incompat"));
    _edgeDrag = null;
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _edgeDrag) {
      _abortEdgeDrag();
      e.preventDefault();
      return;
    }
    // Delete/Backspace selected node, kivéve ha input/textarea/select-en fókusz van
    if ((e.key === "Delete" || e.key === "Backspace") && state.selectedNodeId) {
      const ae = document.activeElement;
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) return;
      _deleteNode(state.selectedNodeId);
      e.preventDefault();
      return;
    }
    // Ctrl+S → saveTemplate
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      saveTemplate();
      return;
    }
    // Ctrl+Enter → runFlow
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runFlow();
      return;
    }
    // Ctrl+Z → undo; Ctrl+Shift+Z / Ctrl+Y → redo
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = (e.key || "").toLowerCase();
      // Beviteli mezőben hagyjuk natívot (text undo)
      const ae = document.activeElement;
      const isEditing = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable);
      if (k === "z" && !e.shiftKey && !isEditing) {
        e.preventDefault();
        undo();
        return;
      }
      if ((k === "z" && e.shiftKey && !isEditing) || (k === "y" && !isEditing)) {
        e.preventDefault();
        redo();
        return;
      }
    }
  });
  window.addEventListener("blur", _abortEdgeDrag);

  function _createEdgeBetween(fromId, toId) {
    const fromNode = state.nodes.find(n => n.id === fromId);
    const toNode = state.nodes.find(n => n.id === toId);
    if (!fromNode || !toNode) return;
    const fromSpec = state.nodeTypeSpecs[fromNode.type];
    const toSpec = state.nodeTypeSpecs[toNode.type];
    if (!fromSpec || !toSpec) return;
    _snapshot();
    // Smart-pick: az első kompatibilis output × input párt választjuk
    // (asset-típus alapján, video_like relaxációval). A régi default
    // "első output × első input" stratégia hibás volt, ha a producer
    // több outputot deklarál (pl. upload: raw_video + pptx_input) és csak
    // egy bizonyos input asset-típust fogad a fogyasztó.
    //
    // A toNode MÁR bekötött input-slotjait kihagyjuk: így egy multi-input
    // node (ppt_replace: input_video + input_pptx; ppt_narrate: input_pptx +
    // voice_ref) második szülője a következő SZABAD kompatibilis slotra köt,
    // nem ütközik az elsővel (ez okozta a "nem tudok pptx-et a ppt_replace-re
    // kötni" + a ppt_narrate voice_ref-beköthetetlenség hibát).
    const wiredSlots = new Set(
      state.edges.filter(e => e.to === toId).map(e => e.to_input)
    );
    const pair = _findCompatiblePortPair(fromNode.type, toNode.type, wiredSlots);
    if (!pair) {
      _toast(
        `❌ Nincs szabad kompatibilis port-pár: ${fromSpec.label} kimenetei (${Object.keys(fromSpec.outputs_full || {}).join(", ")}) ↛ ${toSpec.label} szabad bemenetei`,
        "error"
      );
      return;
    }
    // Duplikátum-edge check (azonos from/to + azonos input slot).
    if (state.edges.some(e => e.from === fromId && e.to === toId && e.to_input === pair.toInput)) {
      _toast("Már van edge a két node között ezen a bemeneten", "error");
      return;
    }
    state.edges.push({
      from: fromId,
      from_asset: pair.fromOutput,
      to: toId,
      to_input: pair.toInput,
    });
    _toast(`Edge: ${fromSpec.label} → ${toSpec.label} (${pair.fromOutput} → ${pair.toInput})`, "ok");
    _saveDraft();
  }

  function _deleteNode(nodeId) {
    _snapshot();
    const node = state.nodes.find(n => n.id === nodeId);
    // Ha futó upload van rajta, abortoljuk — különben a Promise-ek tovább
    // futnak és egy detached node.config-ot mutálnak.
    if (node && node._uploadQueue) {
      // FLOW-1: a metódus neve cancelAll (upload_queue.js), nem abortAll — a
      // korábbi guard mindig hamis volt, így az in-flight upload nem szakadt meg.
      try { if (node._uploadQueue.cancelAll) node._uploadQueue.cancelAll(); } catch (_) {}
      delete node._uploadQueue;
    }
    state.nodes = state.nodes.filter(n => n.id !== nodeId);
    state.edges = state.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
    if (state.selectedNodeId === nodeId) state.selectedNodeId = null;
    _renderAll();
    _saveDraft();
  }

  // ─────────────────────────────────────────────────────────────────────
  // Edge rendering (SVG)
  // ─────────────────────────────────────────────────────────────────────
  function _renderEdges() {
    const svg = document.getElementById("flowEdges");
    const canvas = document.getElementById("flowCanvas");
    if (!svg || !canvas) return;
    // Preserve preview-path (mid-edge-drag) — különben re-render alatt
    // detachelődik és a setAttribute-ok némán nopolnak.
    const preservedPreview = (_edgePreviewPath && _edgePreviewPath.parentNode === svg) ? _edgePreviewPath : null;
    svg.innerHTML = "";
    if (preservedPreview) svg.appendChild(preservedPreview);
    Array.from(canvas.querySelectorAll(".flow-asset-chip")).forEach(c => c.remove());

    // Cache canvas-rect egyszer (volt: minden edge-re hívva → layout thrash).
    const canvasRect = canvas.getBoundingClientRect();
    const z = state.zoom || 1;

    for (const edge of state.edges) {
      const fromNode = state.nodes.find(n => n.id === edge.from);
      const toNode = state.nodes.find(n => n.id === edge.to);
      if (!fromNode || !toNode) continue;

      const fromDiv = canvas.querySelector(`.flow-node[data-node-id="${edge.from}"]`);
      const toDiv = canvas.querySelector(`.flow-node[data-node-id="${edge.to}"]`);
      if (!fromDiv || !toDiv) continue;

      const fromRect = fromDiv.getBoundingClientRect();
      const toRect = toDiv.getBoundingClientRect();

      // A getBoundingClientRect SCREEN-pixel-szintű — a SVG-path viszont
      // a transform-elt .flow-canvas-en belül van, így LOGIKAI koord kell.
      // Osztás zoom-mal teszi vissza screen → logikai konverziót.
      const x1 = (fromRect.right - canvasRect.left) / z;
      const y1 = (fromRect.top + fromRect.height / 2 - canvasRect.top) / z;
      const x2 = (toRect.left - canvasRect.left) / z;
      const y2 = (toRect.top + toRect.height / 2 - canvasRect.top) / z;
      const mx = (x1 + x2) / 2;
      // Bezier-görbe a két port között
      const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("data-edge-from", edge.from);
      path.setAttribute("data-edge-to", edge.to);
      svg.appendChild(path);

      // Asset-chip az edge közepén
      const chip = document.createElement("div");
      chip.className = "flow-asset-chip";
      const fromSpec = state.nodeTypeSpecs[fromNode.type];
      const assetLabel = edge.from_asset;
      chip.textContent = `🔗 ${assetLabel}`;
      chip.style.left = (mx - 30) + "px";
      chip.style.top = ((y1 + y2) / 2 - 10) + "px";
      chip.title = `Asset: ${assetLabel} (${fromSpec ? fromSpec.label : fromNode.type} → ${edge.to_input})`;
      chip.addEventListener("click", () => _toast(`Asset: ${assetLabel} (preview/edit V2)`, "ok"));
      canvas.appendChild(chip);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Props panel
  // ─────────────────────────────────────────────────────────────────────
  function _renderProps() {
    const el = document.getElementById("propsPanel");
    if (!el) return;
    if (!state.selectedNodeId) {
      el.innerHTML = `<div class="props-empty">Válassz ki egy node-ot a beállításokhoz.<br><br><small>Vagy húzz egy csempét a bal oldali palettáról a kanvasra.</small></div>`;
      return;
    }
    const node = state.nodes.find(n => n.id === state.selectedNodeId);
    if (!node) {
      el.innerHTML = `<div class="props-empty">Node nem található.</div>`;
      return;
    }
    const spec = state.nodeTypeSpecs[node.type] || {};
    el.innerHTML = `
      <h3>${_esc(spec.label || node.type)}</h3>
      <p class="text-xs text-secondary mb-4">${_esc(spec.description || "")}</p>
      <div id="propsForm">${_renderPropsForm(node)}</div>
    `;
    _attachPropsEvents(node);
  }

  function _renderPropsForm(node) {
    switch (node.type) {
      case "dub":
        return `
          <label>Mode</label>
          <select data-cfg="mode">
            <option value="dub_full"${(node.config.mode || 'dub_full') === 'dub_full' ? ' selected' : ''}>Teljes szinkron</option>
          </select>
          <label>Nyelv</label>
          <select data-cfg="language">
            <option value="hun"${(node.config.language || 'hun') === 'hun' ? ' selected' : ''}>Magyar</option>
            <option value="eng"${node.config.language === 'eng' ? ' selected' : ''}>Angol</option>
          </select>
          <label>Preset</label>
          <select data-cfg="preset">
            <option value="youtube"${(node.config.preset || 'youtube') === 'youtube' ? ' selected' : ''}>YouTube</option>
            <option value="fast"${node.config.preset === 'fast' ? ' selected' : ''}>Gyors</option>
            <option value="archive"${node.config.preset === 'archive' ? ' selected' : ''}>Archív</option>
            <option value="mobile"${node.config.preset === 'mobile' ? ' selected' : ''}>Mobil</option>
          </select>
          <label class="props-check">
            <input type="checkbox" data-cfg="loudness"${node.config.loudness ? ' checked' : ''}> Hangerő-normalizálás
          </label>
        `;
      case "intro_outro":
        return `
          <label>Téma</label>
          <select data-cfg="theme">
            <option value="sajat"${(node.config.theme || 'sajat') === 'sajat' ? ' selected' : ''}>Saját</option>
            <option value="kmooc"${node.config.theme === 'kmooc' ? ' selected' : ''}>KMOOC</option>
            <option value="egyetemi"${node.config.theme === 'egyetemi' ? ' selected' : ''}>Egyetemi</option>
          </select>
          <label>Preset</label>
          <select data-cfg="preset">
            <option value="youtube"${(node.config.preset || 'youtube') === 'youtube' ? ' selected' : ''}>YouTube</option>
            <option value="fast"${node.config.preset === 'fast' ? ' selected' : ''}>Gyors</option>
            <option value="archive"${node.config.preset === 'archive' ? ' selected' : ''}>Archív</option>
          </select>
          <label class="props-check">
            <input type="checkbox" data-cfg="loudness"${node.config.loudness ? ' checked' : ''}> Hangerő-normalizálás
          </label>
        `;
      case "subtitle":
      case "transcribe":
        return `
          <p class="text-sm text-secondary">Nincs külön beállítás — automatikus magyar ASR + felirat/leirat-export.</p>
        `;
      case "ppt_narrate":
        return `
          <label>Nyelv</label>
          <select data-cfg="language">
            <option value="hu"${(node.config.language || 'hu') === 'hu' ? ' selected' : ''}>Magyar</option>
            <option value="en"${node.config.language === 'en' ? ' selected' : ''}>Angol</option>
          </select>
          <label>Üres dia hossza (sec)</label>
          <input type="number" data-cfg="empty_slide_dur" min="0.5" step="0.5" value="${node.config.empty_slide_dur || 3.0}">
        `;
      case "ppt_replace":
        return `<p class="text-sm text-secondary">PPT-csere — alap beállítás. V2 finomítás külön.</p>`;
      case "upload": {
        const fname = node.config.uploaded_filename;
        const path = node.config.uploaded_path;
        const sizeKb = node.config.uploaded_size_kb;
        const hasFile = !!path;
        return `
          <p class="text-sm text-secondary">Bemeneti fájl. Tölts fel itt előre, vagy hagyd üresen — az Indítás gomb felugró ablakából is megy.</p>
          <div id="uploadNodeStatus" class="upload-node-status${hasFile ? ' is-filled' : ''}">
            ${hasFile
              ? `<div class="text-xs text-success font-semibold">✓ Feltöltve</div>
                 <div class="text-xs">${_esc(fname || '(ismeretlen)')}</div>
                 <div class="text-2xs text-secondary">${sizeKb ? (sizeKb / 1024).toFixed(1) + ' MB' : ''}</div>`
              : `<div class="text-xs text-secondary">Nincs fájl feltöltve.</div>`}
          </div>
          <div id="uploadNodeProgress_${node.id}" class="hidden mt-2">
            <div class="fb-progress">
              <div id="uploadNodeProgressFill_${node.id}" class="fb-progress-fill"></div>
            </div>
            <div id="uploadNodeProgressLabel_${node.id}" class="text-2xs text-secondary mt-1">Feltöltés…</div>
          </div>
          <div class="row mt-2">
            <button class="btn btn-secondary text-xs" onclick="FlowBuilder._uploadFileForNode('${node.id}')">📁 ${hasFile ? 'Csere' : 'Fájl feltöltése'}</button>
            ${hasFile ? `<button class="btn btn-secondary text-xs btn-danger-quiet" onclick="FlowBuilder._clearNodeFile('${node.id}')">✕ Eltávolítás</button>` : ''}
          </div>
        `;
      }
      case "download": {
        // Ha a jelenlegi flow_run kész VAGY ez a node "done", asset-lista
        // megjelenik a props panelben.
        const showAssets = state.currentFlowRunId && node._runStatus === "done";
        const placeholderId = `downloadAssetsPanel_${node.id}`;
        const assetsBlock = showAssets
          ? `<div id="${placeholderId}" class="download-asset-list"><h4>📦 Eredmények betöltése…</h4></div>`
          : "";
        if (showAssets) {
          // Async-fetch a render után — különben a propsForm üresen marad.
          setTimeout(() => _hydrateDownloadAssets(node.id, state.currentFlowRunId, placeholderId), 0);
        }
        return `<p class="text-sm text-secondary">Terminál node: a flow eredményeit gyűjti össze. Futás után a job-listából tölthető le. Több bemenete is lehet (videó / felirat / leirat).</p>${assetsBlock}`;
      }
      default:
        return `<p>Nincs config-form ehhez a típushoz.</p>`;
    }
  }

  function _attachPropsEvents(node) {
    document.querySelectorAll("#propsForm [data-cfg]").forEach(el => {
      el.addEventListener("change", () => {
        const key = el.dataset.cfg;
        let val;
        if (el.type === "checkbox") val = el.checked;
        else if (el.type === "number") val = parseFloat(el.value);
        else val = el.value;
        node.config[key] = val;
        _saveDraft();
      });
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Public actions
  // ─────────────────────────────────────────────────────────────────────
  async function clearFlow() {
    if (state.nodes.length > 0) {
      const ok = await confirmDialog("Új flow", "Tényleg új flow? A jelenlegi vázlat elveszik.");
      if (!ok) return;
    }
    _snapshot();
    state.nodes = [];
    state.edges = [];
    state.selectedNodeId = null;
    state.currentFlowRunId = null;
    document.getElementById("flowNameInput").value = "Új flow";
    _hideRestoreBanner();
    _renderAll();
    // Töröljük a perzisztált draft-ot — explicit "Új" → tényleg üres.
    try { localStorage.removeItem(DRAFT_LS_KEY); } catch (_) {}
  }

  function _buildCanonical() {
    return {
      schema_version: 1,
      nodes: state.nodes.map(n => ({
        id: n.id, type: n.type, config: n.config, pos: n.pos,
      })),
      edges: state.edges.slice(),
      meta: {
        name: document.getElementById("flowNameInput").value || "Flow",
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Export / Import JSON — lokális fájl, validitás-ellenőrzés nélkül.
  // Akkor is működik, ha a flow még invalid (pl. piszkozat) — a save-time
  // validáció csak server-side mentésnél / futtatásnál csap le.
  // ─────────────────────────────────────────────────────────────────────
  function exportFlow() {
    if (state.nodes.length === 0) {
      _toast("Üres flow — nincs mit exportálni", "error");
      return;
    }
    const data = _buildCanonical();
    // A feltöltött fájl a szerveren, a feltöltő saját jobjában él: a szerver-
    // útvonala és a neve nem tartozik a flow LEÍRÁSÁHOZ (a megosztott sablon
    // is levágja, UI-26), egy importált flow-val úgysem indítható — az
    // upload-node-ba új fájl kell. Eddig a JSON mindkettőt hordozta. (UI-34)
    const UPLOADED = ["uploaded_path", "uploaded_filename", "uploaded_size_kb"];   // = backend _UPLOADED_FILE_KEYS
    data.nodes = data.nodes.map(n => {
      if (!n.config || !UPLOADED.some(k => k in n.config)) return n;
      const config = Object.assign({}, n.config);
      UPLOADED.forEach(k => { delete config[k]; });
      return Object.assign({}, n, { config });
    });
    // Stamp-elés: kliens-side time-bélyeg, hogy az import-when ismerje a kort.
    data._exported_at = new Date().toISOString();
    data._exporter = "flow_builder.js v3";
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    // Fájlnév: a flow neve + timestamp (slug-osítva).
    const rawName = (data.meta && data.meta.name) || "flow";
    const slug = rawName.replace(/[^a-zA-Z0-9-_]+/g, "_").slice(0, 40) || "flow";
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug}_${ts}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    _toast(`✓ Exportálva: ${a.download}`, "ok");
  }

  function importFlow() {
    // Rejtett file-input létrehozás + click-trigger. Egyszer-használatos —
    // minden import új file-input-ot kreál, hogy a 'change' event újra szóljon
    // ha ugyanazt a fájlt választod ki.
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) {
        document.body.removeChild(input);
        return;
      }
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        await _applyImportedGraph(data, file.name);
      } catch (err) {
        _toast(`Import hiba: ${err.message}`, "error");
      } finally {
        if (input.parentNode) document.body.removeChild(input);
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  // Node ids are interpolated into element id attributes AND inline onclick
  // JS-string args in the props panel (upload node). A crafted id from
  // imported/cloned/template JSON would be a DOM-XSS vector that _esc cannot
  // fix (nested HTML+JS context). Reject anything outside the builder's own
  // id charset on every untrusted ingest path. (AUD: flow_builder node.id XSS)
  const _SAFE_NODE_ID_RE = /^[A-Za-z0-9_-]+$/;
  function _assertSafeNodeIds(nodes) {
    for (const n of (nodes || [])) {
      if (!n || typeof n.id !== "string" || !_SAFE_NODE_ID_RE.test(n.id)) {
        throw new Error("Érvénytelen node-azonosító a gráfban (csak betű, szám, _ és - engedett).");
      }
    }
  }

  // rank-13: after an untrusted ingest (import/template/clone) surface graph
  // problems immediately instead of only at Run. Non-destructive — we warn but
  // keep the user's graph (so a deliberate work-in-progress isn't dropped).
  function _warnIfImportedGraphInvalid() {
    const issues = [];
    if (Object.keys(state.nodeTypeSpecs).length > 0) {
      const unknown = [...new Set(state.nodes.filter(n => !state.nodeTypeSpecs[n.type]).map(n => n.type))];
      if (unknown.length) issues.push(`ismeretlen node-típus: ${unknown.join(", ")}`);
    }
    const ids = new Set(state.nodes.map(n => n.id));
    const dangling = state.edges.filter(e => !ids.has(e.from) || !ids.has(e.to)).length;
    if (dangling) issues.push(`${dangling} él nem létező node-ra mutat`);
    try {
      const v = _validateGraph();
      if (v && !v.ok) issues.push(...(v.errors || []));
    } catch (_) { /* validator best-effort */ }
    if (issues.length) {
      _toast(`⚠️ A betöltött flow hibákat tartalmaz: ${issues.join("; ")}. Futtatás előtt javítsd.`, "error");
    }
  }

  async function _applyImportedGraph(data, filename) {
    // Minimum-szerkezet ellenőrzés. NEM ellenőrzünk asset-kompatibilitást —
    // a user szándékosan exportálhat invalid flow-t és visszahozhatja.
    if (!data || typeof data !== "object") {
      throw new Error("Üres vagy érvénytelen JSON");
    }
    if (!Array.isArray(data.nodes)) {
      throw new Error("Hiányzó 'nodes' tömb");
    }
    if (!Array.isArray(data.edges)) {
      throw new Error("Hiányzó 'edges' tömb");
    }
    _assertSafeNodeIds(data.nodes);
    if (state.nodes.length > 0) {
      const ok = await confirmDialog("Import", "Biztosan felülírod a jelenlegi flow-t az importtal?");
      if (!ok) return;
    }
    _snapshot();
    // Schema-version sanity (export-kor stamp-eljük 1-re).
    if (data.schema_version && data.schema_version !== 1) {
      _toast(`⚠️ Eltérő schema_version (${data.schema_version}) — kompatibilitási problémák lehetnek.`, "error");
    }
    // Apply — pos.x és pos.y is validálva, clamp negatív értékeket hogy a node
    // ne landoljon offscreen.
    state.nodes = data.nodes.map(n => {
      const px = (n.pos && typeof n.pos.x === "number") ? Math.max(0, n.pos.x) : 100;
      const py = (n.pos && typeof n.pos.y === "number") ? Math.max(0, n.pos.y) : 100;
      return {
        id: n.id,
        type: n.type,
        config: Object.assign({}, _defaultConfigFor(n.type), n.config || {}),
        pos: { x: px, y: py },
      };
    });
    state.edges = data.edges.slice();
    state.selectedNodeId = null;
    state.currentFlowRunId = null;
    // Preserve full meta (description, tags, stb.) — korábban csak name maradt.
    if (data.meta && typeof data.meta === "object") {
      state._importedMeta = Object.assign({}, data.meta);
    }
    // node-id-counter sync, hogy a következő _addNode ne ütközzön
    const maxN = state.nodes.reduce((m, n) => {
      const v = parseInt(String(n.id).replace(/[^0-9]/g, ""), 10) || 0;
      return Math.max(m, v);
    }, 0);
    _nodeIdCounter = maxN;
    const name = (data.meta && data.meta.name) || filename.replace(/\.json$/i, "");
    document.getElementById("flowNameInput").value = name;
    _renderAll();
    _saveDraft();
    _toast(`✓ Importálva: ${filename} (${state.nodes.length} node, ${state.edges.length} edge)`, "ok");
    _warnIfImportedGraphInvalid();
  }

  // Save-template modal: a régi prompt()-os flow helyett custom modal.
  // Mezők: név (text), visibility (radio), description (textarea). Inline
  // validáció a _validateGraph() segédfüggvénnyel — invalid állapotban a
  // submit-button disabled.
  function saveTemplate() {
    if (state.nodes.length === 0) {
      _toast("Üres flow — előbb rakj rá node-okat.", "error");
      return;
    }
    const overlay = document.getElementById("saveTemplateModal");
    if (!overlay) {
      _toast("Sablon-modal nincs betöltve — frissítsd az oldalt (Ctrl+F5)", "error");
      return;
    }
    // Pre-fill mezők
    const nameEl = document.getElementById("tplName");
    const descEl = document.getElementById("tplDesc");
    const visRadios = document.querySelectorAll('input[name="tplVis"]');
    if (nameEl) nameEl.value = document.getElementById("flowNameInput").value || "Új sablon";
    if (descEl) descEl.value = "";
    visRadios.forEach(r => { r.checked = r.value === "private"; });
    _renderTemplateValidation();
    overlay.classList.add("show");
    setTimeout(() => { if (nameEl) nameEl.focus(); }, 30);
    // Escape handler — egyszer-használatos.
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        _closeSaveTemplateModal();
        document.removeEventListener("keydown", onKey);
      }
    };
    document.addEventListener("keydown", onKey);
    overlay._escHandler = onKey;
  }

  function _renderTemplateValidation() {
    const v = _validateGraph();
    const div = document.getElementById("tplValidation");
    const btn = document.getElementById("tplSubmitBtn");
    if (!div) return;
    if (v.ok && v.warns.length === 0) {
      div.className = "validation-status ok";
      div.textContent = "✓ A flow érvényes — mentésre kész.";
    } else if (v.ok && v.warns.length > 0) {
      div.className = "validation-status";
      div.innerHTML = "⚠️ Figyelmeztetések:<ul>" + v.warns.map(w => `<li>${_esc(w)}</li>`).join("") + "</ul>";
    } else {
      div.className = "validation-status error";
      div.innerHTML = "✗ Érvénytelen flow:<ul>" + v.errors.map(er => `<li>${_esc(er)}</li>`).join("") + "</ul>";
    }
    if (btn) btn.disabled = !v.ok;
  }

  function _closeSaveTemplateModal() {
    const overlay = document.getElementById("saveTemplateModal");
    if (!overlay) return;
    overlay.classList.remove("show");
    if (overlay._escHandler) {
      document.removeEventListener("keydown", overlay._escHandler);
      overlay._escHandler = null;
    }
  }

  // A modal bootstrap-time hookolása — input-on/radio-on revalidate.
  function _setupSaveTemplateModalEvents() {
    const overlay = document.getElementById("saveTemplateModal");
    if (!overlay) return;
    const nameEl = document.getElementById("tplName");
    if (nameEl) nameEl.addEventListener("input", _renderTemplateValidation);
    document.querySelectorAll('input[name="tplVis"]').forEach(r => {
      r.addEventListener("change", _renderTemplateValidation);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) _closeSaveTemplateModal();
    });
  }

  async function _submitSaveTemplate() {
    const v = _validateGraph();
    if (!v.ok) {
      _toast("Nem menthető: " + v.errors.join("; "), "error");
      return;
    }
    const nameEl = document.getElementById("tplName");
    const descEl = document.getElementById("tplDesc");
    const name = (nameEl && nameEl.value || "").trim() || "Új sablon";
    const desc = (descEl && descEl.value || "").trim();
    const visRadio = document.querySelector('input[name="tplVis"]:checked');
    const visibility = (visRadio && visRadio.value) || "private";
    const submitBtn = document.getElementById("tplSubmitBtn");
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Mentés…"; }
    try {
      const graph = _buildCanonical();
      if (desc) {
        graph.meta = graph.meta || {};
        graph.meta.description = desc;
      }
      const r = await fetch(`${FLOW_API}/templates`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name,
          visibility: visibility,
          description: desc || undefined,
          graph: graph,
        }),
      });
      if (r.status === 401) {
        _toast("Lejárt munkamenet — átirányítás a bejelentkezéshez…", "error");
        window.location.href = "login.html";
        return;
      }
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(_stringifyDetail(b.detail) || "HTTP " + r.status);
      }
      _toast(`✓ Sablon "${name}" elmentve`, "ok");
      _closeSaveTemplateModal();
      await _loadTemplates();
    } catch (e) {
      _toast("Mentés sikertelen: " + _humanizeError(e), "error");
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Mentés"; }
    }
  }

  async function runFlow() {
    const runBtn = document.getElementById("runBtn");
    // Double-click guard — disabled állapotban no-op.
    if (runBtn && runBtn.disabled) return;
    if (state.nodes.length === 0) {
      _toast("Üres flow — előbb rakj rá node-okat.", "error");
      return;
    }
    // Gyors típelés esetén a 'change' event-re kötött config-frissítések nem
    // futnak le blur nélkül — kényszerítjük a flush-t.
    const ae = document.activeElement;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT") && ae.blur) {
      ae.blur();
    }
    // Ellenőrzés: van-e upload-node? Ha igen, fájl kell.
    const uploadNodes = state.nodes.filter(n => n.type === "upload");
    if (uploadNodes.length > 0) {
      // Per-node előre-feltöltés: ha MINDEN upload-node-nak van uploaded_path-ja,
      // kihagyhatjuk az indítás-modal-t és közvetlenül indíthatjuk a flow-runt.
      const allReady = uploadNodes.every(n => n.config && n.config.uploaded_path);
      if (allReady) {
        const paths = uploadNodes.map(n => n.config.uploaded_path);
        _toast(`▶ Indítás ${paths.length} előfeltöltött fájllal`, "ok");
        await _submitFlowRun(paths);
        return;
      }
      // Egy vagy több node-nak nincs még path-ja → modal a hiányzókhoz.
      _openUploadModal();
      return;
    }
    // Nincs upload — közvetlen indítás (jelenleg ez nem életszerű, de
    // a graph-validáció el fog dönteni mit jelent).
    await _submitFlowRun([]);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Per-Upload-node előzetes fájlfeltöltés.
  // A user a kanvason kiválasztja az Upload node-ot → a props-panelen
  // "Fájl feltöltése" gomb. A chunked-upload finalize visszaadja a server-side
  // path-ot, amit a node.config.uploaded_path-be teszünk. Indításkor a runFlow
  // ezt összegyűjti és modal nélkül elindítja a flow-runt.
  // ─────────────────────────────────────────────────────────────────────
  function _uploadFileForNode(nodeId) {
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node || node.type !== "upload") return;
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    input.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) { document.body.removeChild(input); return; }
      // Per-node DOM ids — különben másik node selectelése közben a progress
      // bar a rossz node-ra íródik (#TD-XXX).
      const prog = document.getElementById(`uploadNodeProgress_${node.id}`);
      const fill = document.getElementById(`uploadNodeProgressFill_${node.id}`);
      const label = document.getElementById(`uploadNodeProgressLabel_${node.id}`);
      if (prog) prog.classList.remove("hidden");
      try {
        if (!window.UploadQueue) throw new Error("UploadQueue nincs betöltve");
        const q = new window.UploadQueue({
          maxConcurrent: 1,
          onProgress: (p) => {
            if (fill && p.percent != null) fill.style.width = p.percent + "%";
            if (label) label.textContent = `${p.state} ${Math.round(p.percent || 0)}%`;
          },
          onComplete: (r) => {
            // Guard: a node-ot időközben törölhették.
            if (!state.nodes.find(n => n.id === node.id)) return;
            if (r && r.path) {
              node.config.uploaded_path = r.path;
              node.config.uploaded_filename = r.name || file.name;
              node.config.uploaded_size_kb = Math.round((file.size || 0) / 1024);
              if (node._uploadQueue === q) delete node._uploadQueue;
              _saveDraft();
              _renderProps();      // refresh az új state-tel
              _renderNodes();      // a node-on is jelenjen meg a fájlnév-jelzés
              _toast(`✓ Feltöltve: ${file.name}`, "ok");
            } else if (r && r.skipped) {
              _toast(`Fájl már létezik (kihagyva): ${file.name}`, "ok");
              if (prog) prog.classList.add("hidden");
            } else {
              _toast("Feltöltés befejeződött, de path nem érkezett vissza.", "error");
            }
          },
          onError: (er) => {
            if (!state.nodes.find(n => n.id === node.id)) return;
            const msg = er && (er.error || er.detail || er.message) || (typeof er === "string" ? er : JSON.stringify(er));
            _toast("Feltöltési hiba: " + msg, "error");
            if (prog) prog.classList.add("hidden");
            if (node._uploadQueue === q) delete node._uploadQueue;
          },
        });
        node._uploadQueue = q;
        q.enqueue(file, { mode: "dub_full", purpose: "flow_input" });
      } catch (err) {
        _toast("Upload-init hiba: " + (err.message || err), "error");
        if (prog) prog.classList.add("hidden");
      } finally {
        if (input.parentNode) document.body.removeChild(input);
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  async function _clearNodeFile(nodeId) {
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node || node.type !== "upload") return;
    const ok = await confirmDialog("Fájl eltávolítása", "Eltávolítod az előre-feltöltött fájlt erről a node-ról?");
    if (!ok) return;
    _snapshot();
    delete node.config.uploaded_path;
    delete node.config.uploaded_filename;
    delete node.config.uploaded_size_kb;
    _saveDraft();
    _renderProps();
    _renderNodes();
    _toast("Fájl-hivatkozás eltávolítva", "ok");
  }

  async function _submitFlowRun(inputFilePaths) {
    const runBtn = document.getElementById("runBtn");
    if (runBtn) { runBtn.disabled = true; runBtn.textContent = "▶ Indítás…"; }
    try {
      const r = await fetch(`${FLOW_API}/runs`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          graph: _buildCanonical(),
          name: document.getElementById("flowNameInput").value || "Flow",
          input_file_paths: inputFilePaths,
        }),
      });
      if (r.status === 401) {
        _toast("Lejárt munkamenet — átirányítás a bejelentkezéshez…", "error");
        window.location.href = "login.html";
        return;
      }
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(_stringifyDetail(b.detail) || "HTTP " + r.status);
      }
      const data = await r.json();
      state.currentFlowRunId = data.flow_run_id;
      _toast(`▶ Flow elindítva (id: ${data.flow_run_id.slice(0, 8)})`, "ok");
      toggleRunsPanel(true);
    } catch (e) {
      _toast("Indítás sikertelen: " + _humanizeError(e), "error");
    } finally {
      if (runBtn) { runBtn.disabled = false; runBtn.textContent = "▶ Indítás"; }
    }
  }

  // Pydantic ValidationError detail-ja list/dict — implicit toString '[object Object]'.
  // Type-aware stringifier ami olvasható üzenetet hoz ki belőle.
  function _stringifyDetail(d) {
    if (d == null) return null;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) {
      return d.map(item => {
        if (typeof item === "string") return item;
        if (item && item.msg) return (item.loc ? item.loc.join(".") + ": " : "") + item.msg;
        return JSON.stringify(item);
      }).join("; ");
    }
    if (typeof d === "object") return JSON.stringify(d);
    return String(d);
  }

  // Human-readable error mapping — common patternöket HU-localized hint-tel.
  function _humanizeError(e) {
    const msg = e && (e.message || (typeof e === "string" ? e : JSON.stringify(e))) || "Ismeretlen hiba";
    if (/Failed to fetch|NetworkError/i.test(msg)) {
      return "Hálózati hiba — ellenőrizd a kapcsolatot és próbáld újra.";
    }
    if (/HTTP 401/.test(msg)) return "Lejárt munkamenet. Jelentkezz be újra.";
    if (/HTTP 403/.test(msg)) return "Nincs jogosultság (HTTP 403).";
    if (/HTTP 5\d\d/.test(msg)) return "Szerver-hiba (" + msg.match(/HTTP \d+/)[0] + ") — próbáld újra rövidesen.";
    return msg;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Upload modal — chunked upload, asset-belül-marad elv
  //
  // Két mód:
  //  - SINGLE: 0 vagy 1 upload-node, vagy single-slot mode → a legacy
  //    drop-list + flat path-tömb.
  //  - MULTI: 2+ upload-node és legalább egynek nincs még path-ja → 1 slot
  //    per upload-node, deterministic node→file mapping. A backend
  //    `input_file_paths` aliasként továbbra is flat tömböt vár; a Flow Engine
  //    a sorrendet az upload-nodes iterációs sorrend szerint párosítja
  //    (Object insertion order — _slotOrder is így van rendezve).
  // ─────────────────────────────────────────────────────────────────────
  let _pendingFiles = [];           // SINGLE mode flat list
  let _uploadQueueInst = null;
  let _uploadedPaths = [];          // SINGLE: flat path list
  // MULTI-mode state — kulcs: upload-node id
  let _isMultiMode = false;
  let _slotOrder = [];              // node-id-k a deterministic order-ben
  let _slotFiles = {};              // { nodeId: File }
  let _slotPaths = {};              // { nodeId: serverPath (akár pre-uploaded) }

  function _setupUploadModal() {
    const dz = document.getElementById("flowUploadDz");
    const fi = document.getElementById("flowUploadInput");
    if (!dz || !fi) return;
    dz.addEventListener("click", () => {
      // Single-mode dropzone-ban a click natívan file-pickert nyit.
      if (!_isMultiMode) fi.click();
    });
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
      if (!_isMultiMode) _addPendingFiles(e.dataTransfer.files);
    });
    fi.addEventListener("change", (e) => {
      if (!_isMultiMode) _addPendingFiles(e.target.files);
    });
  }

  function _addPendingFiles(files) {
    // Append + dedupe (name+size kulcs) — korábban a második drop felülírta az
    // elsőt és az egyetlen file látszott a UL-ben.
    const incoming = Array.from(files);
    const seen = new Set(_pendingFiles.map(f => f.name + "|" + f.size));
    for (const f of incoming) {
      const key = f.name + "|" + f.size;
      if (!seen.has(key)) {
        _pendingFiles.push(f);
        seen.add(key);
      }
    }
    const ul = document.getElementById("flowUploadList");
    ul.innerHTML = _pendingFiles.map(f => `<li>${_esc(f.name)} (${(f.size / 1024 / 1024).toFixed(1)} MB)</li>`).join("");
  }

  function _openUploadModal() {
    _pendingFiles = [];
    _uploadedPaths = [];
    _slotOrder = [];
    _slotFiles = {};
    _slotPaths = {};
    const uploadNodes = state.nodes.filter(n => n.type === "upload");
    // Multi-mode aktiválás: 2+ upload-node, és legalább 1-nek nincs még path-ja.
    const anyEmpty = uploadNodes.some(n => !(n.config && n.config.uploaded_path));
    _isMultiMode = uploadNodes.length > 1 && anyEmpty;
    const dz = document.getElementById("flowUploadDz");
    const slotContainer = document.getElementById("flowUploadSlots");
    const desc = document.getElementById("uploadModalDesc");
    if (_isMultiMode) {
      if (dz) dz.style.display = "none";
      if (slotContainer) slotContainer.style.display = "";
      if (desc) desc.textContent = "Több upload-node van — minden node-hoz külön slot. Húzd a megfelelő fájlt a megfelelő slotba.";
      _renderUploadSlots(uploadNodes);
    } else {
      if (dz) dz.style.display = "";
      if (slotContainer) slotContainer.style.display = "none";
      if (desc) desc.textContent = "A flow indításához egy vagy több bemeneti fájl kell. Húzd ide vagy tallózd.";
      const list = document.getElementById("flowUploadList");
      if (list) list.innerHTML = "";
    }
    document.getElementById("uploadModal").classList.add("show");
  }

  function _renderUploadSlots(uploadNodes) {
    const cont = document.getElementById("flowUploadSlots");
    if (!cont) return;
    _slotOrder = uploadNodes.map(n => n.id);
    // Pre-fill: ha egy upload-node-nak van uploaded_path-ja, slot már "filled".
    for (const n of uploadNodes) {
      if (n.config && n.config.uploaded_path) {
        _slotPaths[n.id] = n.config.uploaded_path;
      }
    }
    cont.innerHTML = uploadNodes.map(n => {
      const filled = !!_slotPaths[n.id];
      const fileLabel = filled
        ? _esc(n.config.uploaded_filename || _slotPaths[n.id])
        : "Húzd ide a fájlt vagy tallózd";
      const spec = state.nodeTypeSpecs[n.type] || {};
      return `
        <div class="flow-upload-slot${filled ? ' filled' : ''}" data-slot-node-id="${_esc(n.id)}">
          <div class="slot-header">
            <span class="slot-label">${_esc(n.id)} · ${_esc(spec.label || n.type)}</span>
            <button type="button" class="slot-browse" data-slot-browse="${_esc(n.id)}">📁 Tallóz</button>
          </div>
          <div class="slot-drophint">${filled ? '✓ ' + fileLabel : fileLabel}</div>
          <input type="file" data-slot-input="${_esc(n.id)}" class="hidden">
        </div>
      `;
    }).join("");
    // Hook drag-drop + browse handlers per-slot.
    cont.querySelectorAll(".flow-upload-slot").forEach(slot => {
      const nodeId = slot.dataset.slotNodeId;
      slot.addEventListener("dragover", (e) => { e.preventDefault(); slot.classList.add("dragover"); });
      slot.addEventListener("dragleave", () => slot.classList.remove("dragover"));
      slot.addEventListener("drop", (e) => {
        e.preventDefault();
        slot.classList.remove("dragover");
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) _attachFileToSlot(nodeId, f);
      });
    });
    cont.querySelectorAll('button[data-slot-browse]').forEach(btn => {
      btn.addEventListener("click", () => {
        const nodeId = btn.dataset.slotBrowse;
        const fi = cont.querySelector(`input[data-slot-input="${CSS.escape(nodeId)}"]`);
        if (fi) fi.click();
      });
    });
    cont.querySelectorAll('input[data-slot-input]').forEach(fi => {
      fi.addEventListener("change", (e) => {
        const nodeId = fi.dataset.slotInput;
        const f = e.target.files && e.target.files[0];
        if (f) _attachFileToSlot(nodeId, f);
      });
    });
  }

  function _attachFileToSlot(nodeId, file) {
    _slotFiles[nodeId] = file;
    // UI frissítés
    const slot = document.querySelector(`.flow-upload-slot[data-slot-node-id="${CSS.escape(nodeId)}"]`);
    if (slot) {
      slot.classList.add("filled");
      const hint = slot.querySelector(".slot-drophint");
      if (hint) hint.innerHTML = `📎 ${_esc(file.name)} <span class="text-secondary">(${(file.size / 1024 / 1024).toFixed(1)} MB)</span>`;
    }
  }

  function closeUploadModal() {
    document.getElementById("uploadModal").classList.remove("show");
    // Cleanup mid-upload modal-close esetén.
    // FLOW-1: cancelAll a helyes metódusnév (upload_queue.js), nem abortAll.
    try { if (_uploadQueueInst && _uploadQueueInst.cancelAll) _uploadQueueInst.cancelAll(); } catch (_) {}
    _uploadQueueInst = null;
    _uploadedPaths = [];
    _pendingFiles = [];
    _slotFiles = {};
    _slotPaths = {};
    _slotOrder = [];
    _isMultiMode = false;
    const btn = document.getElementById("uploadModalSubmit");
    if (btn) { btn.disabled = false; btn.textContent = "Feltöltés + Indítás"; }
  }

  async function confirmUploadAndRun() {
    if (_isMultiMode) {
      return _confirmUploadAndRunMulti();
    }
    return _confirmUploadAndRunSingle();
  }

  async function _confirmUploadAndRunSingle() {
    if (_pendingFiles.length === 0) {
      _toast("Tölts fel legalább egy fájlt", "error");
      return;
    }
    const btn = document.getElementById("uploadModalSubmit");
    btn.disabled = true;
    btn.textContent = "Feltöltés…";
    if (!window.UploadQueue) {
      _toast("Upload modul nincs betöltve", "error");
      btn.disabled = false; btn.textContent = "Feltöltés + Indítás";
      return;
    }
    _uploadedPaths = [];
    const _expectedCount = _pendingFiles.length;
    let _submitting = false;
    let _localExpected = _expectedCount;
    let _skippedCount = 0;
    _uploadQueueInst = new window.UploadQueue({
      maxConcurrent: window.UploadQueue.loadConcurrency(),
      onComplete: (r) => {
        if (r && r.path) {
          _uploadedPaths.push(r.path);
        } else if (r && r.skipped) {
          _localExpected -= 1;
          _skippedCount += 1;
        }
        if (!_submitting && _uploadedPaths.length >= _localExpected) {
          _submitting = true;
          if (_skippedCount > 0) {
            _toast(`${_skippedCount} fájl már létezik, kihagyva`, "ok");
          }
          if (_uploadedPaths.length === 0) {
            _toast("Minden fájl duplikátum volt — nincs új path az indításhoz.", "error");
            btn.disabled = false;
            btn.textContent = "Feltöltés + Indítás";
            return;
          }
          btn.textContent = "Indítás…";
          _submitFlowRun(_uploadedPaths).then(() => {
            closeUploadModal();
            btn.disabled = false;
            btn.textContent = "Feltöltés + Indítás";
          }).catch((e) => {
            _toast("Indítási hiba: " + (e && e.message ? e.message : e), "error");
            btn.disabled = false;
            btn.textContent = "Feltöltés + Indítás";
          });
        }
      },
      onError: (e) => {
        const msg = e && (e.error || e.detail || e.message) || (typeof e === "string" ? e : JSON.stringify(e));
        _toast("Upload hiba: " + msg, "error");
        // FLOW-1: cancelAll a helyes metódusnév (upload_queue.js), nem abortAll.
        try { if (_uploadQueueInst && _uploadQueueInst.cancelAll) _uploadQueueInst.cancelAll(); } catch (_) {}
        _uploadQueueInst = null;
        _uploadedPaths = [];
        btn.disabled = false;
        btn.textContent = "Feltöltés + Indítás";
      },
    });
    for (const f of _pendingFiles) {
      _uploadQueueInst.enqueue(f, { mode: "dub_full", purpose: "flow_input" });
    }
  }

  // Multi-mode: minden upload-node-nak kell legyen file VAGY pre-uploaded path.
  // Feltöltés sequentially-per-slot (deterministic node→path mapping).
  async function _confirmUploadAndRunMulti() {
    const missing = _slotOrder.filter(nid => !_slotPaths[nid] && !_slotFiles[nid]);
    if (missing.length > 0) {
      _toast(`Hiányzó fájl(ok) ezekhez a node-okhoz: ${missing.join(", ")}`, "error");
      return;
    }
    const btn = document.getElementById("uploadModalSubmit");
    btn.disabled = true;
    btn.textContent = "Feltöltés…";
    if (!window.UploadQueue) {
      _toast("Upload modul nincs betöltve", "error");
      btn.disabled = false; btn.textContent = "Feltöltés + Indítás";
      return;
    }
    try {
      // Per-slot feltöltés — minden slothoz külön Promise.
      for (const nodeId of _slotOrder) {
        if (_slotPaths[nodeId]) continue;  // pre-uploaded
        const file = _slotFiles[nodeId];
        if (!file) continue;
        const path = await _uploadSingleFile(file);
        _slotPaths[nodeId] = path;
        // Update node config is — ha a user később mégis külön indít.
        const node = state.nodes.find(n => n.id === nodeId);
        if (node) {
          node.config.uploaded_path = path;
          node.config.uploaded_filename = file.name;
          node.config.uploaded_size_kb = Math.round((file.size || 0) / 1024);
        }
      }
      _saveDraft();
      btn.textContent = "Indítás…";
      // Path-tömb a _slotOrder-szerint (deterministic, megfelel a backend
      // upload-node iteration-orderének).
      const paths = _slotOrder.map(nid => _slotPaths[nid]).filter(Boolean);
      await _submitFlowRun(paths);
      closeUploadModal();
    } catch (e) {
      _toast("Feltöltés sikertelen: " + _humanizeError(e), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Feltöltés + Indítás";
    }
  }

  // Egyszerű promise-wrap az UploadQueue-ra egy fájlra. A multi-mode-ban
  // ezt sequentially hívjuk hogy a path-ok deterministic-be jöjjenek vissza.
  function _uploadSingleFile(file) {
    return new Promise((resolve, reject) => {
      if (!window.UploadQueue) return reject(new Error("UploadQueue nincs betöltve"));
      const q = new window.UploadQueue({
        maxConcurrent: 1,
        onComplete: (r) => {
          if (r && r.path) resolve(r.path);
          else if (r && r.skipped) resolve(r.existing_path || r.path || null);
          else resolve(null);
        },
        onError: (e) => {
          const msg = e && (e.error || e.detail || e.message) || (typeof e === "string" ? e : JSON.stringify(e));
          reject(new Error(msg));
        },
      });
      q.enqueue(file, { mode: "dub_full", purpose: "flow_input" });
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Runs panel — flow_run progress
  // ─────────────────────────────────────────────────────────────────────
  function toggleRunsPanel(forceOpen) {
    const panel = document.getElementById("runsPanel");
    if (!panel) return;
    if (forceOpen) {
      panel.classList.add("open");
    } else {
      panel.classList.toggle("open");
    }
    if (panel.classList.contains("open")) {
      _refreshRunsPolling();
    }
  }

  async function _refreshRunsPolling() {
    if (state.activeRunsPolling) clearInterval(state.activeRunsPolling);
    const tick = async () => {
      // Hidden tabban ne polljon — sávszélességpazarlás.
      if (document.hidden) return;
      try {
        const r = await fetch(`${FLOW_API}/runs?limit=20`, { credentials: "same-origin" });
        if (r.status === 401) {
          // Session lejárt — stop polling + redirect.
          if (state.activeRunsPolling) {
            clearInterval(state.activeRunsPolling);
            state.activeRunsPolling = null;
          }
          window.location.href = "login.html";
          return;
        }
        if (!r.ok) return;
        const runs = await r.json();
        _renderRunsList(runs);
        // Ha a current flow_run a futó node-ok között van, frissítsük a
        // node-státuszokat a canvas-on is.
        if (state.currentFlowRunId) {
          const cur = runs.find(rr => rr.id === state.currentFlowRunId);
          if (cur) _updateCanvasFromRun(cur);
        }
      } catch (_) {}
    };
    tick();
    state.activeRunsPolling = setInterval(tick, 3000);
  }

  // Tab visibility — pause polling hidden tabban, resume visible-re.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.activeRunsPolling) {
      _refreshRunsPolling();
    }
  });

  // Terminal statuses — nincs Cancel gomb ezeken.
  const _TERMINAL_RUN_STATUSES = new Set(["done", "error", "cancelled", "failed", "skipped"]);

  function _renderRunsList(runs) {
    const el = document.getElementById("flowRunsList");
    const mobileEl = document.getElementById("mobileRunsList");
    if (!el && !mobileEl) return;
    if (!runs.length) {
      const emptyHtml = `<div class="text-xs text-muted">Még nincs futás.</div>`;
      if (el) el.innerHTML = emptyHtml;
      if (mobileEl) mobileEl.innerHTML = emptyHtml;
      return;
    }
    const html = runs.map(r => {
      const isCurrent = r.id === state.currentFlowRunId;
      const currentChip = isCurrent ? ` <span class="fb-now-chip">most futó</span>` : "";
      // Per-run action buttons
      const isTerminal = _TERMINAL_RUN_STATUSES.has(r.status);
      const isDone = r.status === "done";
      const actions = [];
      if (!isTerminal) {
        actions.push(`<button class="act-cancel" data-run-action="cancel" data-run-id="${_esc(r.id)}" title="Megszakít">⛔ Cancel</button>`);
      }
      if (isDone) {
        actions.push(`<button data-run-action="download" data-run-id="${_esc(r.id)}" title="Eredmények letöltése">📥 Letöltés</button>`);
      }
      actions.push(`<button data-run-action="clone" data-run-id="${_esc(r.id)}" title="Gráf betöltése a kanvasra új névvel">⟲ Klónoz</button>`);
      return `
      <div class="run-row${isCurrent ? " current" : ""}" data-run-id="${_esc(r.id)}">
        <span class="run-name">${_esc(r.name || r.id.slice(0, 8))}${currentChip}</span>
        <div class="run-progress"><div class="run-progress-fill" style="width:${r.progress_pct || 0}%;"></div></div>
        <span class="text-2xs text-secondary">${r.progress_pct || 0}%</span>
        <span class="run-status ${_esc(r.status)}">${_esc(r.status)}</span>
        <div class="run-actions">${actions.join("")}</div>
      </div>
    `;
    }).join("");
    if (el) {
      el.innerHTML = html;
      _attachRunRowActions(el);
    }
    if (mobileEl) {
      mobileEl.innerHTML = html;
      _attachRunRowActions(mobileEl);
    }
  }

  function _attachRunRowActions(container) {
    container.querySelectorAll("button[data-run-action]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const act = btn.dataset.runAction;
        const runId = btn.dataset.runId;
        if (!runId) return;
        if (act === "cancel") return _runRowCancel(runId);
        if (act === "download") return _runRowDownload(runId);
        if (act === "clone") return _runRowClone(runId);
      });
    });
  }

  async function _runRowCancel(runId) {
    const ok = await confirmDialog("Megszakít", "Biztosan megszakítod ezt a flow-futást?");
    if (!ok) return;
    try {
      const r = await fetch(`${FLOW_API}/runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!r.ok && r.status !== 404) {
        const b = await r.json().catch(() => ({}));
        throw new Error(_stringifyDetail(b.detail) || "HTTP " + r.status);
      }
      _toast("Megszakítás kérve.", "ok");
      _refreshRunsPolling();
    } catch (e) {
      _toast("Megszakítás sikertelen: " + _humanizeError(e), "error");
    }
  }

  async function _runRowDownload(runId) {
    // Lekérdezzük a flow-run asset-listáját. Ha 404 → fallback /index.html-re.
    try {
      const r = await fetch(`${FLOW_API}/runs/${encodeURIComponent(runId)}/assets`, {
        credentials: "same-origin",
      });
      if (r.status === 404) {
        window.location.href = "index.html";
        return;
      }
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(_stringifyDetail(b.detail) || "HTTP " + r.status);
      }
      const data = await r.json();
      _openDownloadAssetsModal(runId, data);
    } catch (e) {
      _toast("Asset-lista hiba: " + _humanizeError(e), "error");
      // Fallback — az általános job-listáig kísérjük el a usert.
      setTimeout(() => { window.location.href = "index.html"; }, 1200);
    }
  }

  function _openDownloadAssetsModal(runId, data) {
    // Egyszerű inline modal — listázza az asset-URL-eket. Felhasznáha a confirm
    // modal-konténert átmenetileg, hogy ne kelljen újabb DOM-blokk.
    const assets = (data && (data.assets || data.items || data.files)) || [];
    if (!Array.isArray(assets) || assets.length === 0) {
      _toast("Nem érkezett letölthető asset.", "error");
      return;
    }
    const overlay = document.getElementById("confirmModal");
    const titleEl = document.getElementById("confirmModalTitle");
    const msgEl = document.getElementById("confirmModalMsg");
    const okBtn = document.getElementById("confirmModalOk");
    const cancelBtn = document.getElementById("confirmModalCancel");
    if (!overlay) return;
    if (titleEl) titleEl.textContent = `📥 Letöltés — ${runId.slice(0, 8)}`;
    if (msgEl) {
      msgEl.innerHTML = "Elérhető fájlok:" + assets.map(a => {
        // Backend mezőnevek: download_url + output_name + asset_type + size_bytes
        const url = a.download_url || a.url || a.path || "#";
        const baseName = a.output_name || a.asset_type;
        const name = baseName || (url !== "#" ? url.split("/").pop() : "letöltés");
        const sizeKb = a.size_bytes ? ` (${(a.size_bytes / 1024).toFixed(0)} KB)` : "";
        return `<div class="mt-2"><a href="${_esc(url)}" target="_blank" rel="noopener" class="text-accent break-all">📎 ${_esc(name)}${_esc(sizeKb)}</a></div>`;
      }).join("");
    }
    if (okBtn) { okBtn.textContent = "Bezár"; okBtn.style.display = ""; }
    if (cancelBtn) cancelBtn.style.display = "none";
    overlay.classList.add("show");
    const onClose = () => {
      overlay.classList.remove("show");
      if (okBtn) {
        okBtn.removeEventListener("click", onClose);
        okBtn.textContent = "OK";
      }
      if (cancelBtn) cancelBtn.style.display = "";
    };
    if (okBtn) okBtn.addEventListener("click", onClose);
  }

  async function _runRowClone(runId) {
    // GET a run-graph-jaért, majd cloneNameModal-on bekérni az új nevet,
    // végül _restoreSnapshot-szerűen betölteni a kanvasra.
    try {
      const r = await fetch(`${FLOW_API}/runs/${encodeURIComponent(runId)}`, {
        credentials: "same-origin",
      });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(_stringifyDetail(b.detail) || "HTTP " + r.status);
      }
      const data = await r.json();
      // A backend most már pre-parsed `graph` dict-et is küld a raw `graph_json`
      // string mellett — előbbit preferáljuk, gyorsabb és nincs parse-kockázat.
      let graph = data.graph || data.graph_json || null;
      if (typeof graph === "string") {
        try { graph = JSON.parse(graph); } catch (_) { graph = null; }
      }
      if (!graph || !Array.isArray(graph.nodes)) {
        throw new Error("A futás nem tartalmaz visszahozható gráfot.");
      }
      const origName = (data.name || (graph.meta && graph.meta.name) || "Flow");
      _openCloneModal(graph, origName);
    } catch (e) {
      _toast("Klónozás sikertelen: " + _humanizeError(e), "error");
    }
  }

  // Clone-modal state
  let _pendingCloneGraph = null;

  function _openCloneModal(graph, origName) {
    _pendingCloneGraph = graph;
    const overlay = document.getElementById("cloneNameModal");
    const nameEl = document.getElementById("cloneName");
    if (!overlay || !nameEl) {
      _toast("Klónozó modal nincs betöltve — frissítsd az oldalt.", "error");
      return;
    }
    nameEl.value = origName + " (másolat)";
    overlay.classList.add("show");
    setTimeout(() => { nameEl.focus(); nameEl.select(); }, 30);
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); _closeCloneModal(); document.removeEventListener("keydown", onKey); }
      else if (e.key === "Enter") { e.preventDefault(); _confirmClone(); document.removeEventListener("keydown", onKey); }
    };
    document.addEventListener("keydown", onKey);
    overlay._escHandler = onKey;
  }

  function _closeCloneModal() {
    const overlay = document.getElementById("cloneNameModal");
    if (!overlay) return;
    overlay.classList.remove("show");
    if (overlay._escHandler) {
      document.removeEventListener("keydown", overlay._escHandler);
      overlay._escHandler = null;
    }
    _pendingCloneGraph = null;
  }

  async function _confirmClone() {
    const graph = _pendingCloneGraph;
    if (!graph) { _closeCloneModal(); return; }
    try {
      _assertSafeNodeIds(graph.nodes);
    } catch (e) {
      _toast(`⚠️ ${e.message}`, "error");
      _closeCloneModal();
      return;
    }
    if (state.nodes.length > 0) {
      const ok = await confirmDialog("Klónozás", "A jelenlegi kanvas felülíródik. Folytatod?");
      if (!ok) return;
    }
    _snapshot();
    const newName = (document.getElementById("cloneName").value || "Flow (másolat)").trim();
    state.nodes = (graph.nodes || []).map(n => ({
      id: n.id,
      type: n.type,
      config: Object.assign({}, _defaultConfigFor(n.type), n.config || {}),
      pos: n.pos && typeof n.pos.x === "number" ? { x: n.pos.x, y: n.pos.y } : { x: 100, y: 100 },
    }));
    state.edges = Array.isArray(graph.edges) ? graph.edges.slice() : [];
    state.selectedNodeId = null;
    state.currentFlowRunId = null;
    const maxN = state.nodes.reduce((m, n) => {
      const v = parseInt(String(n.id).replace(/[^0-9]/g, ""), 10) || 0;
      return Math.max(m, v);
    }, 0);
    _nodeIdCounter = maxN;
    const nameInput = document.getElementById("flowNameInput");
    if (nameInput) nameInput.value = newName;
    _renderAll();
    _saveDraft();
    _closeCloneModal();
    _toast(`✓ Klónozva: "${newName}"`, "ok");
    _warnIfImportedGraphInvalid();
  }

  // Download-node asset hydration: a GET /api/flow/runs/<id>/assets-t lekéri,
  // és a propsForm-on belüli placeholder-be rendereli az asset-listát. 404 →
  // fallback link az index-oldalra (job-lista).
  async function _hydrateDownloadAssets(nodeId, flowRunId, placeholderId) {
    const target = document.getElementById(placeholderId);
    if (!target || !flowRunId) return;
    try {
      const r = await fetch(`${FLOW_API}/runs/${encodeURIComponent(flowRunId)}/assets`, {
        credentials: "same-origin",
      });
      if (r.status === 404) {
        target.innerHTML = `<h4>📦 Letöltés</h4><p class="text-xs text-secondary">Az asset-lista API még nem elérhető. <a href="index.html" class="text-accent">Nyisd meg a feladatok listáját →</a></p>`;
        return;
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      // Az endpoint különböző shape-eket adhat — defenzív parse.
      let assets = (data && (data.assets || data.items || data.files)) || [];
      // Csak az adott node-hoz tartozó asset-eket szűrjük, ha van node_id-jük.
      const nodeFiltered = assets.filter(a => !a.node_id || a.node_id === nodeId);
      const effective = nodeFiltered.length > 0 ? nodeFiltered : assets;
      if (!Array.isArray(effective) || effective.length === 0) {
        target.innerHTML = `<h4>📦 Letöltés</h4><p class="text-xs text-secondary">Nincs publikált asset. <a href="index.html" class="text-accent">Job-lista →</a></p>`;
        return;
      }
      const items = effective.map(a => {
        // Backend mezőnevek: download_url + output_name + asset_type + size_bytes
        const url = a.download_url || a.url || a.path || "#";
        const baseName = a.output_name || a.asset_type;
        const name = baseName || (url !== "#" ? url.split("/").pop() : "letöltés");
        const sizeKb = a.size_bytes ? ` (${(a.size_bytes / 1024).toFixed(0)} KB)` : "";
        return `<a href="${_esc(url)}" target="_blank" rel="noopener">📎 ${_esc(name)}${_esc(sizeKb)}</a>`;
      }).join("");
      target.innerHTML = `<h4>📦 Eredmények (${effective.length})</h4>${items}`;
      // Kis badge a node-on (DOM-szintű, _runStatus-tól független).
      const nodeDiv = document.querySelector(`.flow-node[data-node-id="${nodeId}"]`);
      if (nodeDiv && !nodeDiv.querySelector(".download-asset-badge")) {
        const badge = document.createElement("div");
        badge.className = "download-asset-badge";
        badge.textContent = `${effective.length} fájl kész`;
        nodeDiv.appendChild(badge);
      }
    } catch (e) {
      target.innerHTML = `<h4>📦 Letöltés</h4><p class="text-xs text-danger">Asset-lista hiba: ${_esc(e.message || String(e))}.</p><p class="text-xs"><a href="index.html" class="text-accent">Job-lista →</a></p>`;
    }
  }

  function _updateCanvasFromRun(run) {
    if (!run.node_runs) return;
    // Surgical update: csak a status-CSS-class-t és a status-pill text-jét
    // toggle-eljuk a meglévő DOM-on. Korábban _renderNodes() teljes destroy/
    // recreate-et csinált (3s polltickenként), ami a node-drag-et megszakíthatja
    // és felesleges layout thrash.
    for (const nr of run.node_runs) {
      const node = state.nodes.find(n => n.id === nr.node_id);
      if (!node || node._runStatus === nr.status) continue;
      const prevStatus = node._runStatus;
      node._runStatus = nr.status;
      const div = document.querySelector(`.flow-node[data-node-id="${nr.node_id}"]`);
      if (!div) continue;
      if (prevStatus) div.classList.remove("status-" + prevStatus);
      div.classList.add("status-" + nr.status);
      let pill = div.querySelector(".node-status");
      if (!pill) {
        pill = document.createElement("span");
        pill.className = "node-status";
        div.appendChild(pill);
      }
      pill.textContent = nr.status;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────
  function _esc(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // Draft auto-restore banner — a régi 3.5s-os toast helyett tartós banner
  // két akcióval: "Eltartani" (banner elrejtése) és "Új flow" (clearFlow).
  function _showRestoreBanner(nodeCount, edgeCount) {
    const wrap = document.querySelector(".flow-canvas-wrap");
    const old = document.getElementById("flowRestoreBanner");
    if (!wrap) return;
    let banner;
    if (old) {
      banner = old;
      banner.innerHTML = "";
    } else {
      banner = document.createElement("div");
      banner.id = "flowRestoreBanner";
    }
    banner.className = "flow-restore-banner";
    banner.style.display = "";
    banner.innerHTML = `
      <span class="restore-text">📂 Visszahozva ${nodeCount} node és ${edgeCount} él.</span>
      <button class="primary" id="flowRestoreKeep">Eltartani</button>
      <button id="flowRestoreNew">Új flow</button>
    `;
    // Ne legyen duplikált — ha még nincs DOM-ban, fűzzük a wrap-be.
    if (!banner.parentNode) wrap.appendChild(banner);
    const keepBtn = banner.querySelector("#flowRestoreKeep");
    const newBtn = banner.querySelector("#flowRestoreNew");
    if (keepBtn) keepBtn.addEventListener("click", _hideRestoreBanner);
    if (newBtn) newBtn.addEventListener("click", () => {
      _hideRestoreBanner();
      clearFlow();
    });
    // Auto-hide 12s után — ha a user nem reagál, ne lógjon a vásznon.
    if (banner._autoHideTimer) clearTimeout(banner._autoHideTimer);
    banner._autoHideTimer = setTimeout(_hideRestoreBanner, 12000);
  }

  function _hideRestoreBanner() {
    const banner = document.getElementById("flowRestoreBanner");
    if (!banner) return;
    if (banner._autoHideTimer) { clearTimeout(banner._autoHideTimer); banner._autoHideTimer = null; }
    banner.style.display = "none";
    banner.innerHTML = "";
  }

  function _toast(msg, kind) {
    const ex = document.querySelectorAll(".flow-toast");
    ex.forEach(e => e.remove());
    const t = document.createElement("div");
    t.className = "flow-toast" + (kind === "error" ? " error" : kind === "ok" ? " ok" : "");
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  // ─────────────────────────────────────────────────────────────────────
  // Logout helper (sidebar a flow.html-en nincs, de a shared.js logoutUser
  // várja a window-on)
  // ─────────────────────────────────────────────────────────────────────
  async function logoutUser() {
    try { await fetch("api/logout", { method: "POST" }); } catch (_) {}
    document.cookie = "dub_session=; path=/; max-age=0";
    window.location.href = "login.html";
  }
  window.logoutUser = logoutUser;

  // Public API
  window.FlowBuilder = {
    runFlow: runFlow,
    saveTemplate: saveTemplate,
    clearFlow: clearFlow,
    toggleRunsPanel: toggleRunsPanel,
    closeUploadModal: closeUploadModal,
    confirmUploadAndRun: confirmUploadAndRun,
    exportFlow: exportFlow,
    importFlow: importFlow,
    zoomIn: zoomIn,
    zoomOut: zoomOut,
    resetZoom: resetZoom,
    fitToView: fitToView,
    undo: undo,
    redo: redo,
    _uploadFileForNode: _uploadFileForNode,
    _clearNodeFile: _clearNodeFile,
    _closeSaveTemplateModal: _closeSaveTemplateModal,
    _submitSaveTemplate: _submitSaveTemplate,
    _closeCloneModal: _closeCloneModal,
    _confirmClone: _confirmClone,
    _state: state,  // debug
    _validateGraph: _validateGraph,  // smoke-test
  };
})();
