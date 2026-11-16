/*
 * quick_combo.js — gyors-folytatás (post-process) modul.
 *
 * Minden modul-oldal (ppt_narrate, intro_outro, dub, batch, …) ezt hívja
 * be a kész job-okon: a user egy gombbal indít egy mini-flow-t a már
 * lefutott job output-jára. A backend asset-hardlink-el a forrás-job
 * job_dir-jéből az új node job_dir-jébe — semmi újra-feltöltés.
 *
 * Public API:
 *   QuickCombo.show({jobId, sourceNodeType, comboType, defaults}) → Promise
 *     comboType: 'intro_outro' | 'subtitle' | 'dub'
 *     defaults: optional pre-filled config a modal-on
 *
 *   QuickCombo.startFlow(jobId, sourceNodeType, chainAfter) → Promise
 *     direkt API-call modal nélkül (programmatic use)
 *
 * Backend: POST /api/flow/quick-combo (body: source_job_id + source_node_type
 * + chain_after array).
 */
(function () {
  "use strict";

  const FLOW_API = "api/flow";

  // ─── Modal: intro_outro config-form ──────────────────────────────────
  function _renderIntroOutroModal(defaults) {
    const d = defaults || {};
    return `
      <h3 class="qc-title">🎬 Folytasd brand intro/outro-val</h3>
      <p class="qc-lead">
        A kész videó-output kap egy bevezető + záró keretet — a köztes fájl
        a szerveren marad, semmit nem kell le- és újra feltölteni.
      </p>
      <label>Téma</label>
      <select id="qc_theme">
        <option value="sajat"${(d.theme || 'sajat') === 'sajat' ? ' selected' : ''}>Saját (default)</option>
        <option value="kmooc"${d.theme === 'kmooc' ? ' selected' : ''}>KMOOC</option>
        <option value="egyetemi"${d.theme === 'egyetemi' ? ' selected' : ''}>Egyetemi</option>
      </select>
      <label>Preset</label>
      <select id="qc_preset">
        <option value="youtube"${(d.preset || 'youtube') === 'youtube' ? ' selected' : ''}>YouTube</option>
        <option value="fast"${d.preset === 'fast' ? ' selected' : ''}>Gyors</option>
        <option value="archive"${d.preset === 'archive' ? ' selected' : ''}>Archív</option>
        <option value="mobile"${d.preset === 'mobile' ? ' selected' : ''}>Mobil</option>
      </select>
      <label>Nyelv</label>
      <select id="qc_lang">
        <option value="hun"${(d.language || 'hun') === 'hun' ? ' selected' : ''}>Magyar</option>
        <option value="eng"${d.language === 'eng' ? ' selected' : ''}>Angol</option>
      </select>
      <label class="inline-check">
        <input type="checkbox" id="qc_loudness"${d.loudness ? ' checked' : ''}> Hangerő-normalizálás
      </label>
    `;
  }

  function _collectIntroOutroConfig() {
    return {
      theme: document.getElementById("qc_theme").value || "sajat",
      preset: document.getElementById("qc_preset").value || "youtube",
      language: document.getElementById("qc_lang").value || "hun",
      loudness: document.getElementById("qc_loudness").checked,
      has_opening: false,  // egyszerű — a teljes opening_text-form az F3-ban
    };
  }

  // ─── Modal: subtitle/transcribe egyszerű (no config) ─────────────────
  function _renderSubtitleModal() {
    return `
      <h3 class="qc-title">💬 Folytasd felirattal</h3>
      <p class="qc-lead">
        A meglévő videó-output kap egy felirat-generálást. Az SRT időkódjai
        automatikusan a videó-timeline-hoz illeszkednek (ha a forrás már
        brand-elt, a flow-engine offsetet alkalmaz).
      </p>
    `;
  }

  function _renderDubModal() {
    return `
      <h3 class="qc-title">🎙️ Folytasd szinkronnal</h3>
      <p class="qc-lead">
        A meglévő videó-output kap egy szinkronizálást: ASR → fordítás →
        XTTS → mix.
      </p>
    `;
  }

  // ─── Modal-keret ─────────────────────────────────────────────────────
  // A .qc-* stílusok a style.css-ben élnek. (UI-13)

  function show(opts) {
    return new Promise((resolve) => {
      const ov = document.createElement("div");
      ov.className = "qc-overlay";
      const innerHtml = opts.comboType === "intro_outro"
        ? _renderIntroOutroModal(opts.defaults)
        : opts.comboType === "subtitle"
          ? _renderSubtitleModal()
          : _renderDubModal();
      ov.innerHTML = `
        <div class="qc-box" role="dialog" aria-modal="true">
          ${innerHtml}
          <div class="qc-status" id="qc_status"></div>
          <div class="qc-actions">
            <button class="btn btn-secondary" id="qc_cancel">Mégse</button>
            <button class="btn btn-primary" id="qc_submit">Indítás</button>
          </div>
        </div>`;
      document.body.appendChild(ov);

      function close(result) {
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        resolve(result);
      }
      ov.querySelector("#qc_cancel").addEventListener("click", () => close(null));
      ov.addEventListener("click", (e) => { if (e.target === ov) close(null); });
      ov.querySelector("#qc_submit").addEventListener("click", async () => {
        const status = document.getElementById("qc_status");
        const btn = document.getElementById("qc_submit");
        const cancelBtn = document.getElementById("qc_cancel");
        btn.disabled = true;
        cancelBtn.disabled = true;
        status.textContent = "Indítás…";
        status.className = "qc-status";

        const config = opts.comboType === "intro_outro" ? _collectIntroOutroConfig() : {};
        const chainAfter = [{ type: opts.comboType, config }];
        try {
          const r = await startFlow(opts.jobId, opts.sourceNodeType, chainAfter);
          status.textContent = `✓ Flow elindult — flow_run_id: ${r.flow_run_id.slice(0, 8)}…`;
          status.className = "qc-status ok";
          if (typeof showToast === "function") {
            showToast(`✓ Folytatás elindítva — a flow oldalon követheted.`, "success");
          }
          setTimeout(() => close({ ok: true, flow_run_id: r.flow_run_id }), 1200);
        } catch (e) {
          status.textContent = `❌ ${e.message || e}`;
          status.className = "qc-status err";
          btn.disabled = false;
          cancelBtn.disabled = false;
        }
      });
    });
  }

  async function startFlow(jobId, sourceNodeType, chainAfter) {
    const r = await fetch(`${FLOW_API}/quick-combo`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_job_id: jobId,
        source_node_type: sourceNodeType,
        chain_after: chainAfter,
      }),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.detail || `HTTP ${r.status}`);
    }
    return await r.json();
  }

  // Egy kompakt gomb-HTML helper a render-template-ekhez. Bárhol használható.
  // Visszaad egy <button>-string-et ami az onclick-jén meghívja a QuickCombo.show-t.
  // A meghívás `window.QuickCombo`-on át történik (globál), így az inline
  // onclick is CSP-friendly (no eval).
  function buttonHtml({ jobId, sourceNodeType, comboType, label, className }) {
    const lbl = label || (comboType === "intro_outro" ? "🎬 Folytasd intro/outro-val"
      : comboType === "subtitle" ? "💬 Folytasd felirattal"
      : "🎙️ Folytasd szinkronnal");
    const cls = className || "btn-xs";
    return `<button class="btn btn-secondary ${cls}" onclick="QuickCombo.show({jobId: '${jobId}', sourceNodeType: '${sourceNodeType}', comboType: '${comboType}'})">${lbl}</button>`;
  }

  window.QuickCombo = {
    show: show,
    startFlow: startFlow,
    buttonHtml: buttonHtml,
  };
})();
