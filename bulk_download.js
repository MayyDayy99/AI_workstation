/*
 * bulk_download.js — shared download-tracking helpers for ALL batch pages.
 *
 * Centralises the download-state persistence (localStorage), the per-link
 * `<a class="downloaded">` flag, the inline ✅ next to "Mentve...", and the
 * `📝 Összes SRT (3/12)` remaining-counter UI for the bulk-download bar.
 *
 * Every batch page that has a `#downloadBar > button[data-dlbtn=...]`
 * markup and a `#batchList` container picks this up automatically — no
 * page-specific glue required beyond an `<script src="bulk_download.js">`
 * include.
 *
 * Public globals:
 *   - markAsDownloaded(jobId, type)
 *   - downloadAllVisible(type)
 *   - _updateDownloadAllButtons()
 *   - bulkDownload.observeBatchList(rootEl?)  — start MutationObserver
 *
 * Storage key: localStorage['downloadedJobsByType'] = { jobId: {srt:true, ...}, ... }
 *
 * The `<a>` download link must carry `data-job-id` AND `data-dltype` for
 * the bulk-downloader to trigger `markAsDownloaded` (CSP-safe — no
 * eval(onclick) needed). Pages that still use the legacy
 * `onclick="markAsDownloaded(...)"` form continue to work; the bulk
 * downloader only fires markAsDownloaded if both data attributes are
 * present.
 */
(function () {
  "use strict";

  var STORE_KEY = "downloadedJobsByType";

  function _readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); }
    catch (e) { return {}; }
  }

  function _writeStore(d) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(d)); }
    catch (e) { /* fail-open */ }
  }

  // ── markAsDownloaded — persists + updates DOM + bumps button counters ──
  function markAsDownloaded(jobId, type) {
    if (!jobId || !type) return;
    var d = _readStore();
    if (!d[jobId]) d[jobId] = {};
    d[jobId][type] = true;
    _writeStore(d);

    // 1) Stamp the link(s) with .downloaded so :not(.downloaded) bulk filter
    //    instantly excludes them. We search by data-attributes (set by every
    //    batch page's render code) AND by the legacy onclick form for back-
    //    compat with pages that haven't migrated to data-attributes yet.
    var links = document.querySelectorAll(
      'a[data-job-id="' + CSS.escape(String(jobId)) + '"][data-dltype="' + CSS.escape(String(type)) + '"]'
    );
    links.forEach(function (a) {
      if (!a.classList.contains("downloaded")) {
        a.classList.add("downloaded");
        if (a.innerHTML.indexOf("✅") === -1) a.innerHTML += " ✅";
      }
    });

    // 2) Stamp the parent .batch-item so the inline ✅ next to the "Mentve"
    //    label appears immediately — every batch page renders the same
    //    structure so we can do this generically.
    links.forEach(function (a) {
      var item = a.closest(".batch-item");
      if (item && !item.classList.contains("downloaded")) {
        item.classList.add("downloaded");
        var savedLabel = item.querySelector(".saved-label");
        if (savedLabel && savedLabel.querySelector(".saved-mark") === null) {
          var mark = document.createElement("span");
          mark.className = "saved-mark";
          mark.title = "Letöltve";
          mark.textContent = " ✅";
          savedLabel.appendChild(mark);
        }
      }
    });

    // 3) Refresh the "Összes XYZ (N/M)" button counters.
    _updateDownloadAllButtons();
  }

  // ── _updateDownloadAllButtons — refreshes counter + disabled state ────
  function _updateDownloadAllButtons() {
    var bar = document.getElementById("downloadBar");
    var container = document.getElementById("batchList");
    if (!bar || !container) return;
    var buttons = bar.querySelectorAll("button[data-dlbtn]");
    buttons.forEach(function (btn) {
      if (btn.hasAttribute("data-busy")) return;  // mid bulk-download
      var type = btn.getAttribute("data-dlbtn");
      var baseLabel = btn.getAttribute("data-dl-label");
      if (!baseLabel) {
        baseLabel = btn.textContent;
        btn.setAttribute("data-dl-label", baseLabel);
      }
      var total = container.querySelectorAll('a[download$=".' + type + '"]').length;
      var remaining = container.querySelectorAll('a[download$=".' + type + '"]:not(.downloaded)').length;
      if (total === 0) {
        btn.style.display = "none";
        return;
      }
      btn.style.display = "";
      btn.disabled = (remaining === 0);
      btn.style.opacity = (remaining === 0) ? "0.55" : "1";
      btn.style.cursor = (remaining === 0) ? "default" : "pointer";
      if (remaining === 0) {
        btn.textContent = baseLabel + " ✓ (" + total + "/" + total + ")";
        btn.title = "Minden ilyen fájl már le van töltve";
      } else {
        btn.textContent = baseLabel + " (" + remaining + "/" + total + ")";
        btn.title = remaining + " új, " + (total - remaining) + " már letöltve";
      }
    });
  }

  // ── downloadAllVisible — CSP-safe bulk downloader (uses data-attrs) ───
  async function downloadAllVisible(type) {
    var container = document.getElementById("batchList");
    if (!container) return;
    var links = Array.prototype.slice.call(
      container.querySelectorAll('a[download$=".' + type + '"]:not(.downloaded)')
    );
    if (links.length === 0) {
      alert("Nincs új, letölthető " + type.toUpperCase() + " fájl — minden már le van töltve.");
      return;
    }
    if (!confirm("Biztosan le akarsz tölteni " + links.length + " db ÚJ " + type.toUpperCase() + " fájlt?")) return;

    var target = (typeof event !== "undefined" && event && event.target) ? event.target : null;
    var originalText = target ? target.innerText : "";
    if (target) {
      target.innerText = "Töltés…";
      target.disabled = true;
      target.setAttribute("data-busy", "1");
    }

    try {
      for (var i = 0; i < links.length; i++) {
        var link = links[i];
        var iframe = document.createElement("iframe");
        iframe.style.display = "none";
        iframe.src = link.href;
        document.body.appendChild(iframe);
        // Remove the iframe later so it doesn't accumulate.
        (function (ifr) {
          setTimeout(function () {
            if (document.body.contains(ifr)) document.body.removeChild(ifr);
          }, 3000);
        })(iframe);
        // Persist via data-attributes (CSP-safe, no eval). The legacy
        // onclick="markAsDownloaded(...)" form is *not* triggered by an
        // iframe.src assignment (the anchor's click event never fires),
        // so we MUST call it manually here.
        var jobId = link.getAttribute("data-job-id");
        var dlType = link.getAttribute("data-dltype");
        if (jobId && dlType) {
          try { markAsDownloaded(jobId, dlType); } catch (e) { /* noop */ }
        }
        await new Promise(function (r) { setTimeout(r, 600); });
      }
    } finally {
      if (target) {
        target.removeAttribute("data-busy");
        target.disabled = false;
      }
      _updateDownloadAllButtons();
    }
  }

  // ── MutationObserver: refresh button counters whenever #batchList changes ──
  // This frees individual pages from having to call _updateDownloadAllButtons()
  // at the end of their render function — drop the script tag and it works.
  function observeBatchList(root) {
    var node = root || document.getElementById("batchList");
    if (!node) return null;
    var obs = new MutationObserver(function () {
      // Re-stamp existing .batch-item rows from localStorage (the page
      // render likely just nuked them), then refresh the counters.
      _restampFromStore();
      _updateDownloadAllButtons();
    });
    obs.observe(node, { childList: true, subtree: false });
    return obs;
  }

  // Re-stamp .batch-item rows + their <a> links with .downloaded class based
  // on the persistent store. Pages that re-render the list lose this state
  // every cycle, so we re-apply it here.
  function _restampFromStore() {
    var store = _readStore();
    var items = document.querySelectorAll(".batch-item");
    items.forEach(function (item) {
      var anyMarked = false;
      var links = item.querySelectorAll("a[data-job-id][data-dltype]");
      links.forEach(function (a) {
        var jobId = a.getAttribute("data-job-id");
        var type = a.getAttribute("data-dltype");
        if (store[jobId] && store[jobId][type]) {
          a.classList.add("downloaded");
          anyMarked = true;
        }
      });
      if (anyMarked && !item.classList.contains("downloaded")) {
        item.classList.add("downloaded");
      }
    });
  }

  // Boot: hook the observer once DOM is ready. Pages that render
  // asynchronously (most do — they fetch /api/batch/items first) will get
  // their first refresh on the first mutation; until then the counters
  // simply show the static "(N/M)" once the list arrives.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { observeBatchList(); });
  } else {
    observeBatchList();
  }

  // Public exports.
  window.markAsDownloaded = markAsDownloaded;
  window.downloadAllVisible = downloadAllVisible;
  window._updateDownloadAllButtons = _updateDownloadAllButtons;
  window.bulkDownload = {
    observeBatchList: observeBatchList,
    refresh: _updateDownloadAllButtons,
    restamp: _restampFromStore,
  };
})();
