/**
 * Shared behaviour: concrete-texture cycling (press C), the copy-command
 * button, and small helpers used by both leaderboard pages.
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------ texture cycling (C) */

  var TEXTURES = [
    "assets/textures/concrete-01.webp", // pale poured concrete
    "assets/textures/concrete-02.webp", // board-formed concrete
    "assets/textures/concrete-03.webp", // fine grit cement
    "assets/textures/concrete-04.webp", // polished cement
    "assets/textures/concrete-05.webp", // weathered slab
  ];
  var TEXTURE_KEY = "makefaster.textureIndex";

  var textureIndex = parseInt(localStorage.getItem(TEXTURE_KEY), 10);
  if (!Number.isInteger(textureIndex) || textureIndex < 0 || textureIndex >= TEXTURES.length) {
    textureIndex = 0;
  }

  function applyTexture(i) {
    document.documentElement.style.setProperty("--texture-image", 'url("' + TEXTURES[i] + '")');
  }

  applyTexture(textureIndex);

  // Warm the cache so cycling is instant.
  TEXTURES.forEach(function (src) {
    var img = new Image();
    img.src = src;
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "c" && e.key !== "C") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ""))) return;
    textureIndex = (textureIndex + 1) % TEXTURES.length;
    localStorage.setItem(TEXTURE_KEY, String(textureIndex));
    applyTexture(textureIndex);
  });

  /* --------------------------------------------------- copy command bar */

  var copyBtn = document.getElementById("copy-cmd");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      var command = copyBtn.getAttribute("data-command") || "npx makefaster";
      var label = copyBtn.querySelector(".cmd-copy-label");

      function flash() {
        if (!label) return;
        label.textContent = "Copied";
        setTimeout(function () {
          label.textContent = "Copy";
        }, 1600);
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(command).then(flash, function () {
          legacyCopy(command);
          flash();
        });
      } else {
        legacyCopy(command);
        flash();
      }
    });
  }

  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (err) {
      /* nothing else we can do */
    }
    document.body.removeChild(ta);
  }

  /* ------------------------------------------------------ shared helpers */

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Numbered pagination with a windowed range: ‹ 1 2 3 … 125 ›
   */
  function renderPagination(container, page, pageCount, onPage) {
    container.innerHTML = "";
    if (pageCount < 1) return;

    function button(label, opts) {
      var b = document.createElement("button");
      b.type = "button";
      b.innerHTML = label;
      if (opts.className) b.className = opts.className;
      if (opts.disabled) b.disabled = true;
      if (opts.page) {
        b.addEventListener("click", function () {
          onPage(opts.page);
        });
        b.setAttribute("aria-label", "Page " + opts.page);
        if (opts.current) b.setAttribute("aria-current", "page");
      }
      container.appendChild(b);
    }

    button("&lsaquo;", { disabled: page <= 1, page: Math.max(1, page - 1) });

    var nums = [];
    for (var p = 1; p <= pageCount; p++) {
      if (p === 1 || p === pageCount || Math.abs(p - page) <= 1) nums.push(p);
    }
    var last = 0;
    nums.forEach(function (p) {
      if (last && p - last > 1) {
        var gap = document.createElement("button");
        gap.type = "button";
        gap.className = "gap";
        gap.textContent = "\u2026";
        gap.disabled = true;
        container.appendChild(gap);
      }
      button(String(p), { className: p === page ? "active" : "", page: p, current: p === page });
      last = p;
    });

    button("&rsaquo;", { disabled: page >= pageCount, page: Math.min(pageCount, page + 1) });
  }

  function downloadCsv(filename, header, rows) {
    function cell(v) {
      var s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = [header.map(cell).join(",")].concat(
      rows.map(function (r) {
        return r.map(cell).join(",");
      })
    );
    var blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Deterministic PRNG for stable decorative sparkbars. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  global.MF = {
    escapeHtml: escapeHtml,
    renderPagination: renderPagination,
    downloadCsv: downloadCsv,
    mulberry32: mulberry32,
  };
})(window);
