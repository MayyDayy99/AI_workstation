/*
 * dedup.js — pre-upload duplicate detection.
 *
 * Before a file is uploaded, the browser computes a *sampled* signature
 * (size + first 8 MiB + last 8 MiB → SHA-256) and asks the server whether an
 * identical file already exists among the current user's prior uploads. If so
 * it shows a dialog offering to skip. The byte layout MUST match
 * backend/utils/file_signature.py exactly.
 *
 * Why sampled, not a full hash: GB-sized videos can't be streamed through the
 * Web Crypto digest (no incremental API) and the page CSP forbids WASM. Hashing
 * only 16 MiB is instant on any file size and reliably catches identical
 * re-uploads (it does NOT catch re-encoded "similar" files — different feature).
 *
 * Secure-context note: crypto.subtle only exists over HTTPS / localhost. On a
 * plain-HTTP LAN address it is undefined, so a small pure-JS SHA-256 fallback
 * is included — both produce the same digest, so both agree with the Python
 * server. Everything here is fail-open: any error → treat the file as new and
 * let the upload proceed (dedup must never block a legitimate upload).
 */
(function () {
  "use strict";

  // Keep in sync with backend/utils/file_signature.py.
  var SAMPLE_CHUNK = 8 * 1024 * 1024; // 8 MiB
  var FULL_THRESHOLD = 16 * 1024 * 1024; // <= → hash whole file

  // ── pure-JS SHA-256 (fallback for non-secure contexts) ────────────────────
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function rotr(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  function sha256Create() {
    var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
        h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    var buffer = new Uint8Array(64), bufLen = 0, totalLen = 0;
    var w = new Int32Array(64);

    function processBlock(block, off) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = (block[off + 4 * i] << 24) | (block[off + 4 * i + 1] << 16) |
               (block[off + 4 * i + 2] << 8) | block[off + 4 * i + 3];
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }

    return {
      update: function (bytes) {
        totalLen += bytes.length;
        var i = 0;
        if (bufLen > 0) {
          while (bufLen < 64 && i < bytes.length) buffer[bufLen++] = bytes[i++];
          if (bufLen === 64) { processBlock(buffer, 0); bufLen = 0; }
        }
        while (i + 64 <= bytes.length) { processBlock(bytes, i); i += 64; }
        while (i < bytes.length) buffer[bufLen++] = bytes[i++];
        return this;
      },
      hex: function () {
        var ml = totalLen * 8;
        var padLen = bufLen < 56 ? 56 - bufLen : 120 - bufLen;
        var tail = new Uint8Array(padLen + 8);
        tail[0] = 0x80;
        var hi = Math.floor(ml / 0x100000000);
        var lo = ml >>> 0;
        tail[padLen] = (hi >>> 24) & 0xff;
        tail[padLen + 1] = (hi >>> 16) & 0xff;
        tail[padLen + 2] = (hi >>> 8) & 0xff;
        tail[padLen + 3] = hi & 0xff;
        tail[padLen + 4] = (lo >>> 24) & 0xff;
        tail[padLen + 5] = (lo >>> 16) & 0xff;
        tail[padLen + 6] = (lo >>> 8) & 0xff;
        tail[padLen + 7] = lo & 0xff;
        this.update(tail);
        var out = [h0, h1, h2, h3, h4, h5, h6, h7], s = "", j;
        for (j = 0; j < out.length; j++) {
          s += ("00000000" + (out[j] >>> 0).toString(16)).slice(-8);
        }
        return s;
      },
    };
  }

  function toHex(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += ("0" + u8[i].toString(16)).slice(-2);
    return s;
  }

  // Digest a list of Uint8Array parts (concatenated) → hex SHA-256.
  async function sha256Hex(parts) {
    if (window.crypto && window.crypto.subtle && window.isSecureContext) {
      var total = 0, k;
      for (k = 0; k < parts.length; k++) total += parts[k].length;
      var buf = new Uint8Array(total), off = 0;
      for (k = 0; k < parts.length; k++) { buf.set(parts[k], off); off += parts[k].length; }
      try {
        var digest = await window.crypto.subtle.digest("SHA-256", buf);
        return toHex(new Uint8Array(digest));
      } catch (e) {
        /* fall through to pure-JS */
      }
    }
    var h = sha256Create();
    for (var i = 0; i < parts.length; i++) h.update(parts[i]);
    return h.hex();
  }

  async function readSlice(file, start, end) {
    var blob = file.slice(start, end);
    if (blob.arrayBuffer) return new Uint8Array(await blob.arrayBuffer());
    return await new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(new Uint8Array(fr.result)); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(blob);
    });
  }

  // Compute the sampled signature of a File — byte-identical to the Python side.
  async function computeSignature(file) {
    var size = file.size;
    var prefix = new TextEncoder().encode(size + ":");
    var parts;
    if (size <= FULL_THRESHOLD) {
      parts = [prefix, await readSlice(file, 0, size)];
    } else {
      parts = [
        prefix,
        await readSlice(file, 0, SAMPLE_CHUNK),
        await readSlice(file, size - SAMPLE_CHUNK, size),
      ];
    }
    return await sha256Hex(parts);
  }

  async function checkDuplicate(signature, size, filename) {
    var res = await fetch("api/check-duplicate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ signature: signature, size: size, filename: filename }),
    });
    if (!res.ok) return { duplicate: false };
    return await res.json();
  }

  // ── duplicate confirmation dialog ─────────────────────────────────────────
  var STYLE_ID = "dedup-style";
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent =
      ".dedup-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;" +
      "align-items:center;justify-content:center;z-index:99999}" +
      ".dedup-bx{background:#14142a;color:#e0e0e0;border:1px solid #2a2a4a;" +
      "border-radius:12px;max-width:440px;width:90%;padding:24px;" +
      "font-family:sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5)}" +
      ".dedup-bx h3{margin:0 0 12px;color:#f5b942;font-size:18px}" +
      ".dedup-bx p{margin:6px 0;line-height:1.45;font-size:14px}" +
      ".dedup-bx .dedup-meta{color:#9a9ac0;font-size:13px;word-break:break-all}" +
      ".dedup-row{display:flex;gap:10px;justify-content:flex-end;margin-top:20px}" +
      ".dedup-btn{border:none;border-radius:8px;padding:9px 16px;font-size:14px;" +
      "cursor:pointer}.dedup-skip{background:#3b82f6;color:#fff}" +
      ".dedup-go{background:transparent;color:#9a9ac0;border:1px solid #3a3a5a}";
    document.head.appendChild(st);
  }

  function fmtSize(n) {
    if (!n && n !== 0) return "";
    var u = ["B", "KB", "MB", "GB"], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + " " + u[i];
  }

  // Returns Promise<"skip"|"proceed">.
  function confirmDuplicate(file, match) {
    ensureStyle();
    return new Promise(function (resolve) {
      var ov = document.createElement("div");
      ov.className = "dedup-ov";
      var when = match.created_at ? (" · " + String(match.created_at).slice(0, 10)) : "";
      var existing = (match.filename || "(ismeretlen név)") + when;
      ov.innerHTML =
        '<div class="dedup-bx" role="dialog" aria-modal="true">' +
        "<h3>⚠️ Ezt a fájlt már feltöltötted</h3>" +
        "<p>Egy azonos tartalmú fájl már fenn van:</p>" +
        '<p class="dedup-meta">📄 ' + escapeHtml(existing) + "</p>" +
        '<p class="dedup-meta">Új fájl: ' + escapeHtml(file.name) +
        " (" + fmtSize(file.size) + ")</p>" +
        '<div class="dedup-row">' +
        '<button class="dedup-btn dedup-go">Mégis feltöltöm</button>' +
        '<button class="dedup-btn dedup-skip">Kihagyom</button>' +
        "</div></div>";
      document.body.appendChild(ov);
      function done(val) { if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(val); }
      ov.querySelector(".dedup-skip").addEventListener("click", function () { done("skip"); });
      ov.querySelector(".dedup-go").addEventListener("click", function () { done("proceed"); });
      ov.addEventListener("click", function (e) { if (e.target === ov) done("proceed"); });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /*
   * guard(file) → Promise<"proceed"|"skip">
   *
   * The single entry point a surface calls before uploading. Computes the
   * signature, checks the server, and if a duplicate exists shows the dialog.
   * ALWAYS resolves "proceed" on any error (fail-open) — dedup is a courtesy,
   * never a gate.
   */
  async function guard(file) {
    try {
      if (!file || !file.size) return "proceed";
      var sig = await computeSignature(file);
      var resp = await checkDuplicate(sig, file.size, file.name);
      if (resp && resp.duplicate && resp.match) {
        return await confirmDuplicate(file, resp.match);
      }
      return "proceed";
    } catch (e) {
      if (window.console) console.warn("dedup guard failed (fail-open):", e);
      return "proceed";
    }
  }

  window.DedupUpload = {
    guard: guard,
    computeSignature: computeSignature,
    checkDuplicate: checkDuplicate,
  };
})();
