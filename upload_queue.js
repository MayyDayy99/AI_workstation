/*
 * upload_queue.js — chunked / resumable upload queue with user-controlled concurrency.
 *
 * Replaces the legacy Promise.all(files.map(upload)) fan-out in batch_core.js
 * that flooded the server with N parallel POSTs (and reliably failed on mobile
 * with ~50% completion rate). New flow:
 *
 *   user drops 40 files
 *     → enqueue each into UploadQueue
 *     → UploadQueue runs `maxConcurrent` uploads at a time (1-3, slider in UI)
 *     → each upload: SHA → POST /init → POST /chunk × N → POST /finalize
 *     → per-chunk exp-backoff retry 5×, AbortController-cancelable
 *
 * Server endpoints live in backend/batch/upload_chunked.py.
 *
 * Dependencies:
 *   - window.DedupUpload.computeSignature  (from dedup.js, sampled hash)
 *
 * Public API (window.UploadQueue):
 *   const q = new UploadQueue({maxConcurrent, onProgress, onComplete, onError, onQueue})
 *   q.enqueue(file, extras)        → returns a token (string)
 *   q.setConcurrency(n)            → 1-3, persisted in localStorage
 *   q.getConcurrency()             → current value
 *   q.cancel(token)                → aborts the upload for that token
 *   q.cancelAll()                  → aborts everything in-flight
 *   q.getActiveCount()             → currently-uploading count
 *   q.getQueuedCount()             → waiting-in-queue count
 *
 * Callback contract:
 *   onProgress({token, name, totalBytes, sentBytes, percent, state})
 *     state: "hashing" | "init" | "uploading" | "finalizing" | "done" | "error" | "cancelled" | "skipped"
 *   onComplete({token, name, item_id, job_id, path, flow_run_id, response, skipped, signature})
 *     response: the raw /finalize JSON (purpose-specific fields, e.g. course_zip → course_id)
 *   onError({token, name, error, isFatal})
 *   onQueue({active, queued, max})  (called on every state change)
 */
(function () {
  "use strict";

  var API_BASE = "api/batch/upload";
  // Félbemaradt feltöltés azonosítója, a fájl szignatúrájához kötve (folytatás).
  var RESUME_PREFIX = "edti-upload-resume:";
  var CONCURRENCY_KEY = "dub_upload_concurrency";
  var DEFAULT_CONCURRENCY = 2;
  var MIN_CONCURRENCY = 1;
  var MAX_CONCURRENCY = 3;

  // Server tells us its preferred chunk size in /init response; this is the
  // hard upper bound for our slicing and matches the backend MAX_CHUNK_BYTES.
  var CHUNK_SIZE_DEFAULT = 5 * 1024 * 1024; // 5 MiB

  // Per-chunk retry policy. Exponential backoff seeded so a single transient
  // failure doesn't kill an upload, but a persistent error fails fast enough
  // to surface to the user.
  var MAX_CHUNK_RETRIES = 5;
  var RETRY_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

  function clampConcurrency(n) {
    n = Math.floor(Number(n));
    if (!isFinite(n) || isNaN(n)) return DEFAULT_CONCURRENCY;
    if (n < MIN_CONCURRENCY) return MIN_CONCURRENCY;
    if (n > MAX_CONCURRENCY) return MAX_CONCURRENCY;
    return n;
  }

  function loadConcurrency() {
    try {
      var raw = window.localStorage.getItem(CONCURRENCY_KEY);
      if (raw === null) return DEFAULT_CONCURRENCY;
      return clampConcurrency(raw);
    } catch (e) {
      return DEFAULT_CONCURRENCY;
    }
  }

  function saveConcurrency(n) {
    try {
      window.localStorage.setItem(CONCURRENCY_KEY, String(clampConcurrency(n)));
    } catch (e) {
      /* localStorage disabled — fail-open */
    }
  }

  function makeToken() {
    return "u_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ── XHR-based chunk uploader so we get xhr.upload.onprogress ────────────
  // The fetch() API has no upload progress event; we want a per-chunk byte-level
  // progress so the UI bar moves smoothly inside a 5 MiB chunk.
  function postChunk(opts) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", opts.url);
      xhr.withCredentials = true;
      xhr.timeout = opts.timeout || 120000; // 120s per chunk
      if (opts.onProgress) {
        xhr.upload.addEventListener("progress", function (evt) {
          if (evt.lengthComputable) opts.onProgress(evt.loaded, evt.total);
        });
      }
      xhr.addEventListener("load", function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve({ok: true, status: xhr.status, body: xhr.responseText});
        } else {
          resolve({ok: false, status: xhr.status, body: xhr.responseText});
        }
      });
      xhr.addEventListener("error", function () {
        reject(new Error("Network error"));
      });
      xhr.addEventListener("timeout", function () {
        reject(new Error("Timeout"));
      });
      xhr.addEventListener("abort", function () {
        reject(new Error("Aborted"));
      });
      if (opts.signal) {
        opts.signal.addEventListener("abort", function () {
          try { xhr.abort(); } catch (e) { /* noop */ }
        });
      }
      // Send raw blob for chunk POSTs, or text/JSON for control endpoints.
      if (opts.body instanceof Blob) {
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
      } else if (opts.contentType) {
        xhr.setRequestHeader("Content-Type", opts.contentType);
      }
      xhr.send(opts.body);
    });
  }

  function jsonFetch(url, body, signal) {
    return fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
      signal: signal,
    });
  }

  // ── UploadQueue class ──────────────────────────────────────────────────
  //
  // opts.customUpload (optional): plug-in for non-chunked endpoints. If
  // provided, the queue calls it INSTEAD of the chunked init/chunk/finalize
  // flow — useful for legacy single-shot uploads (intro_outro, ppt_narrate)
  // that still want concurrency-control + retry + AbortController.
  //
  //   customUpload(file, extras, emitProg, signal) -> Promise<{item_id, job_id?, skipped?}>
  //     emitProg(sentBytes, totalBytes, state)
  //     signal: AbortController.signal — should propagate cancel
  //
  function UploadQueue(opts) {
    opts = opts || {};
    this.maxConcurrent = opts.maxConcurrent || loadConcurrency();
    this.onProgress = opts.onProgress || function () {};
    this.onComplete = opts.onComplete || function () {};
    this.onError = opts.onError || function () {};
    this.onQueue = opts.onQueue || function () {};
    this.customUpload = opts.customUpload || null;  // optional override
    // queue: array of {token, file, extras, controller}
    this._queue = [];
    // active: Map<token, {file, controller, ...}>
    this._active = new Map();
    this._destroyed = false;
  }

  UploadQueue.prototype._emitQueue = function () {
    this.onQueue({
      active: this._active.size,
      queued: this._queue.length,
      max: this.maxConcurrent,
    });
  };

  UploadQueue.prototype.getConcurrency = function () {
    return this.maxConcurrent;
  };

  UploadQueue.prototype.setConcurrency = function (n) {
    this.maxConcurrent = clampConcurrency(n);
    saveConcurrency(this.maxConcurrent);
    this._pump();
    this._emitQueue();
  };

  UploadQueue.prototype.getActiveCount = function () {
    return this._active.size;
  };

  UploadQueue.prototype.getQueuedCount = function () {
    return this._queue.length;
  };

  UploadQueue.prototype.enqueue = function (file, extras) {
    if (!file) return null;
    var token = makeToken();
    var controller = new AbortController();
    this._queue.push({
      token: token,
      file: file,
      extras: extras || {},
      controller: controller,
    });
    // Initial progress emit so the UI gets a row immediately.
    this.onProgress({
      token: token,
      name: file.name,
      totalBytes: file.size,
      sentBytes: 0,
      percent: 0,
      state: "queued",
    });
    this._emitQueue();
    this._pump();
    return token;
  };

  UploadQueue.prototype.cancel = function (token) {
    // Remove from queued.
    for (var i = 0; i < this._queue.length; i++) {
      if (this._queue[i].token === token) {
        var entry = this._queue.splice(i, 1)[0];
        this.onProgress({
          token: token,
          name: entry.file.name,
          totalBytes: entry.file.size,
          sentBytes: 0,
          percent: 0,
          state: "cancelled",
        });
        this._emitQueue();
        return true;
      }
    }
    // Abort active.
    var active = this._active.get(token);
    if (active) {
      try { active.controller.abort(); } catch (e) { /* noop */ }
      return true;
    }
    return false;
  };

  UploadQueue.prototype.cancelAll = function () {
    var tokens = [];
    var self = this;
    this._queue.forEach(function (e) { tokens.push(e.token); });
    this._active.forEach(function (_v, t) { tokens.push(t); });
    tokens.forEach(function (t) { self.cancel(t); });
  };

  UploadQueue.prototype._pump = function () {
    while (this._active.size < this.maxConcurrent && this._queue.length > 0) {
      var item = this._queue.shift();
      this._active.set(item.token, item);
      this._emitQueue();
      this._runUpload(item);
    }
  };

  UploadQueue.prototype._runUpload = function (item) {
    var self = this;
    var token = item.token;
    var file = item.file;
    var signal = item.controller.signal;

    var emitProg = function (sent, total, state) {
      var percent = total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : 0;
      if (state === "done") percent = 100;
      self.onProgress({
        token: token,
        name: file.name,
        totalBytes: total,
        sentBytes: sent,
        percent: percent,
        state: state,
      });
    };

    (async function () {
      try {
        // ── Plug-in branch: custom single-shot uploader (legacy endpoints) ──
        // intro_outro / ppt_narrate batch pages give us a `customUpload`
        // closure and we just delegate to it — only the queue's concurrency
        // gate + abort propagation are inherited from this class.
        if (self.customUpload) {
          emitProg(0, file.size, "uploading");
          var res = await self.customUpload(file, item.extras, emitProg, signal);
          if (signal.aborted) throw new Error("Aborted");
          emitProg(file.size, file.size, "done");
          self._finishItem(token, {
            token: token,
            name: file.name,
            item_id: (res && res.item_id) || null,
            job_id: (res && res.job_id) || null,
            skipped: !!(res && res.skipped),
            signature: null,
          });
          return;
        }

        // 1) Compute the sampled signature for dedup + integrity verification.
        emitProg(0, file.size, "hashing");
        var signature;
        if (window.DedupUpload && window.DedupUpload.computeSignature) {
          signature = await window.DedupUpload.computeSignature(file);
        } else {
          throw new Error("Dedup module not loaded");
        }
        if (signal.aborted) throw new Error("Aborted");

        // 2) FOLYTATÁS, ha lehet. A szerver megtervezte (GET /status/{id} →
        //    received_chunks), a kliens eddig mégis MINDEN próbálkozásnál új
        //    /init-et kért: egy 30 s-nál hosszabb hálózati kiesés (laptop
        //    alvás, Wi-Fi-váltás — ennyi a darabonkénti újrapróbálás kerete)
        //    után egy többgigás videó elölről indult. Most a félbemaradt
        //    feltöltés azonosítója a szignatúrához kötve eltárolódik, és
        //    ugyanannak a fájlnak az újabb feltöltése — AZONOS beállításokkal,
        //    mert a szerver az eredeti /init beállításaival fejezi be — a meglévő
        //    darabok után folytatódik. (Funkció-ellenőrzés, 8/12.)
        emitProg(0, file.size, "init");
        var resumeKey = RESUME_PREFIX + signature;
        var resumeSig = JSON.stringify([
          file.name, file.size, item.extras.mode || "dub_full", item.extras.purpose || "",
          item.extras.language || "hun", item.extras.preset || "youtube",
          !!item.extras.loudness, item.extras.chain_before || [],
        ]);
        var initJson = null;
        try {
          var saved = JSON.parse(window.localStorage.getItem(resumeKey) || "null");
          if (saved && saved.upload_id && saved.sig === resumeSig) {
            var stRes = await fetch(API_BASE + "/status/" + encodeURIComponent(saved.upload_id),
              {credentials: "same-origin", signal: signal});
            if (stRes.ok) {
              var stJson = await stRes.json();
              initJson = {
                status: "ok",
                upload_id: stJson.upload_id,
                chunk_size: stJson.chunk_size,
                received_chunks: stJson.received_chunks || [],
              };
            }
          }
          if (!initJson && saved) window.localStorage.removeItem(resumeKey);
        } catch (e) {
          if (signal.aborted) throw e;
          initJson = null;   // localStorage tiltva / a státusz nem jött — új feltöltés
        }

        if (!initJson) {
          var initBody = {
            filename: file.name,
            total_size: file.size,
            signature: signature,
            mode: item.extras.mode || "dub_full",
            language: item.extras.language || "hun",
            preset: item.extras.preset || "youtube",
            loudness: !!item.extras.loudness,
          };
          // Upload purpose: "flow_input" tells the server to accept the wider
          // Flow Builder extension set (.pptx, …) and to ONLY stage the file
          // (no phantom batch_queue job). Defaults to "batch" server-side.
          if (item.extras.purpose) {
            initBody.purpose = item.extras.purpose;
          }
          // Pre-process chain: ha az extras-ben van chain_before, a backend
          // flow-engine veszi át (NEM a batch_queue). Pl. "intro_outro után
          // subtitle" — egy multi-stage flow-runt indít.
          if (item.extras.chain_before && item.extras.chain_before.length > 0) {
            initBody.chain_before = item.extras.chain_before;
          }
          var initRes = await jsonFetch(API_BASE + "/init", initBody, signal);
          try {
            initJson = await initRes.json();
          } catch (e) {
            initJson = {};
          }
          if (!initRes.ok) {
            throw new Error("Init failed: HTTP " + initRes.status + " — " + (initJson.detail || ""));
          }
          if (initJson.upload_id) {
            try {
              window.localStorage.setItem(resumeKey, JSON.stringify(
                {upload_id: initJson.upload_id, sig: resumeSig, ts: Date.now()}));
            } catch (e) { /* localStorage tiltva — folytatás nélkül */ }
          }
        }
        if (initJson.status === "duplicate") {
          // Existing prior upload by this user — skip.
          emitProg(file.size, file.size, "skipped");
          self._finishItem(token, {
            token: token,
            name: file.name,
            item_id: null,
            job_id: initJson.existing_job_id || null,
            skipped: true,
            signature: signature,
          });
          return;
        }
        var uploadId = initJson.upload_id;
        var serverChunkSize = initJson.chunk_size || CHUNK_SIZE_DEFAULT;
        var receivedSet = new Set(initJson.received_chunks || []);
        if (!uploadId) {
          throw new Error("Init response missing upload_id");
        }

        // 3) Chunk loop. Skip indices the server already has (resume case).
        var totalChunks = Math.ceil(file.size / serverChunkSize);
        var baselineSent = receivedSet.size * serverChunkSize;
        var sentBytes = Math.min(baselineSent, file.size);
        emitProg(sentBytes, file.size, "uploading");

        for (var i = 0; i < totalChunks; i++) {
          if (signal.aborted) throw new Error("Aborted");
          if (receivedSet.has(i)) continue;

          var start = i * serverChunkSize;
          var end = Math.min(start + serverChunkSize, file.size);
          var blob = file.slice(start, end);

          var chunkBaseSent = sentBytes; // for progress callback closure
          var success = false;
          var lastErr = null;

          for (var attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
            try {
              var res = await postChunk({
                url: API_BASE + "/chunk?upload_id=" + encodeURIComponent(uploadId) + "&index=" + i,
                body: blob,
                signal: signal,
                onProgress: function (loaded /*, total*/) {
                  emitProg(chunkBaseSent + loaded, file.size, "uploading");
                },
                timeout: 120000,
              });
              if (res.ok) {
                success = true;
                break;
              }
              // 4xx (except 408/429) → fail-fast, no retry.
              if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
                throw new Error("HTTP " + res.status + " — " + (res.body || ""));
              }
              lastErr = new Error("HTTP " + res.status);
            } catch (e) {
              if (signal.aborted) throw e;
              lastErr = e;
              if (e.message && e.message.indexOf("HTTP 4") === 0 &&
                  e.message.indexOf("HTTP 408") !== 0 &&
                  e.message.indexOf("HTTP 429") !== 0) {
                // Non-retryable 4xx
                throw e;
              }
            }
            // Backoff before next retry (skip on last iteration).
            if (attempt < MAX_CHUNK_RETRIES) {
              var wait = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
              await sleep(wait);
              if (signal.aborted) throw new Error("Aborted");
            }
          }
          if (!success) {
            throw lastErr || new Error("Chunk " + i + " failed after retries");
          }
          receivedSet.add(i);
          sentBytes = Math.min(sentBytes + (end - start), file.size);
          emitProg(sentBytes, file.size, "uploading");
        }

        // 4) Finalize — server re-assembles and verifies signature.
        emitProg(file.size, file.size, "finalizing");
        var finRes = await fetch(
          API_BASE + "/finalize?upload_id=" + encodeURIComponent(uploadId),
          {method: "POST", credentials: "same-origin", signal: signal}
        );
        var finJson;
        try {
          finJson = await finRes.json();
        } catch (e) {
          finJson = {};
        }
        // A finalize után (sikerült vagy végleg elbukott, pl. hibás
        // szignatúra) nincs mit folytatni.
        try { window.localStorage.removeItem(resumeKey); } catch (e) { /* ignore */ }
        if (!finRes.ok) {
          throw new Error("Finalize failed: HTTP " + finRes.status + " — " + (finJson.detail || ""));
        }
        emitProg(file.size, file.size, "done");
        self._finishItem(token, {
          token: token,
          name: file.name,
          item_id: finJson.id || null,
          // Surface job_id from the finalize response. The dub single-file path
          // (purpose="dub_single") returns one; batch/flow finalize do not, so
          // it stays null for them (no regression).
          job_id: finJson.job_id || null,
          // path: absolute server-side path of the assembled file.
          // The Flow Builder needs this to wire upload-nodes to seeded inputs
          // (see flow_builder.js confirmUploadAndRun) — without it the
          // FlowEngine._seed_upload_nodes errors with "Hiányzó input fájl".
          path: finJson.path || null,
          flow_run_id: finJson.flow_run_id || null,
          // A finalize teljes válasza — a céltól függő mezőkkel (pl. a
          // course_zip-é: course_id, video_count). (Funkció-ellenőrzés, 9/12.)
          response: finJson,
          skipped: false,
          signature: signature,
        });
      } catch (err) {
        var aborted = (err && err.message === "Aborted") || (signal && signal.aborted);
        if (aborted) {
          emitProg(0, file.size, "cancelled");
          self._finishItem(token, null);
        } else {
          emitProg(0, file.size, "error");
          self.onError({
            token: token,
            name: file.name,
            error: (err && err.message) || String(err),
            isFatal: true,
          });
          self._finishItem(token, null);
        }
      }
    })();
  };

  UploadQueue.prototype._finishItem = function (token, result) {
    this._active.delete(token);
    if (result) {
      this.onComplete(result);
    }
    this._emitQueue();
    if (!this._destroyed) this._pump();
  };

  UploadQueue.prototype.destroy = function () {
    this._destroyed = true;
    this.cancelAll();
  };

  // Expose globally — no module system in this project.
  window.UploadQueue = UploadQueue;
  window.UploadQueue.clampConcurrency = clampConcurrency;
  window.UploadQueue.loadConcurrency = loadConcurrency;
  window.UploadQueue.saveConcurrency = saveConcurrency;
  window.UploadQueue.MIN = MIN_CONCURRENCY;
  window.UploadQueue.MAX = MAX_CONCURRENCY;
})();
