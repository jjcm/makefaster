/**
 * Site leaderboard page: aggregate stat cards, cold/warm filter, search,
 * paginated table of sites, CSV export.
 */
(function () {
  "use strict";

  var PER_PAGE = 10;

  var state = { mode: "cold", q: "", page: 1 };
  var rows = [];

  var els = {
    lcp: document.getElementById("card-lcp"),
    tti: document.getElementById("card-tti"),
    sites: document.getElementById("card-sites"),
    tests: document.getElementById("card-tests"),
    updated: document.getElementById("card-updated"),
    updatedSub: document.getElementById("card-updated-sub"),
    tbody: document.getElementById("sites-tbody"),
    showing: document.getElementById("sites-showing"),
    pagination: document.getElementById("sites-pagination"),
    search: document.getElementById("site-search"),
    exportBtn: document.getElementById("export-csv"),
    segmented: document.querySelectorAll(".segmented button"),
  };

  var fmt = new Intl.NumberFormat("en-US");

  // Fixed ascending staircase glyph, as drawn beside raw values in the design.
  var SPARK =
    '<svg class="spark" width="27" height="14" viewBox="0 0 27 14" fill="currentColor" aria-hidden="true">' +
    ["3", "4.5", "6", "7.5", "9", "10.5", "12", "13.5"]
      .map(function (h, i) {
        var height = parseFloat(h);
        return '<rect x="' + i * 3.4 + '" y="' + (14 - height) + '" width="2.1" height="' + height + '"/>';
      })
      .join("") +
    "</svg>";

  var DOWN_ARROW =
    '<svg class="icon" width="10" height="12" viewBox="0 0 10 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
    '<path d="M5 0v10M1 7l4 4 4-4"/></svg>';

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return rows.filter(function (r) {
      if (r.mode !== state.mode) return false;
      if (!q) return true;
      return (
        (r.url || "").toLowerCase().indexOf(q) !== -1 ||
        (r.name || "").toLowerCase().indexOf(q) !== -1
      );
    });
  }

  function renderCards() {
    var sel = rows.filter(function (r) {
      return r.mode === state.mode;
    });
    if (!sel.length) return;

    function avg(key) {
      return (
        sel.reduce(function (a, r) {
          return a + (r[key] || 0);
        }, 0) / sel.length
      );
    }

    els.lcp.textContent = Math.round(avg("lcpDelta")) + "%";
    els.tti.textContent = Math.round(avg("ttiDelta")) + "%";

    var unique = {};
    rows.forEach(function (r) {
      unique[r.url] = r.tests || 0;
    });
    var urls = Object.keys(unique);
    els.sites.textContent = fmt.format(urls.length);

    var testsAvg =
      urls.reduce(function (a, u) {
        return a + unique[u];
      }, 0) / urls.length;
    els.tests.textContent = testsAvg.toFixed(1);

    var latest = rows.reduce(function (a, r) {
      return r.measuredAt && r.measuredAt > a ? r.measuredAt : a;
    }, "");
    if (latest) {
      var d = new Date(latest);
      els.updated.textContent = new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(d);
      els.updatedSub.textContent =
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "UTC",
        }).format(d) + " UTC";
    }
  }

  function faviconCell(row) {
    var box = document.createElement("div");
    box.className = "favicon-box";
    var letter = ((row.name || row.url || "?").trim()[0] || "?").toUpperCase();
    if (row.favicon) {
      var img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", function () {
        box.innerHTML = '<div class="favicon-fallback">' + MF.escapeHtml(letter) + "</div>";
      });
      img.src = row.favicon;
      box.appendChild(img);
    } else {
      box.innerHTML = '<div class="favicon-fallback">' + MF.escapeHtml(letter) + "</div>";
    }
    return box;
  }

  function renderTable() {
    var data = filtered();
    var pageCount = Math.max(1, Math.ceil(data.length / PER_PAGE));
    if (state.page > pageCount) state.page = pageCount;
    var start = (state.page - 1) * PER_PAGE;
    var pageRows = data.slice(start, start + PER_PAGE);

    els.tbody.innerHTML = "";

    if (!pageRows.length) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        '<td colspan="5" style="text-align:center;color:var(--muted);padding:34px 16px;">No sites match your search.</td>';
      els.tbody.appendChild(tr);
    }

    pageRows.forEach(function (r) {
      var tr = document.createElement("tr");

      var siteTd = document.createElement("td");
      var cell = document.createElement("div");
      cell.className = "site-cell";
      cell.appendChild(faviconCell(r));
      var meta = document.createElement("div");
      meta.innerHTML =
        '<div class="site-name">' +
        MF.escapeHtml(r.name || r.url) +
        '</div><div class="site-url">' +
        MF.escapeHtml(r.url) +
        "</div>";
      cell.appendChild(meta);
      siteTd.appendChild(cell);
      tr.appendChild(siteTd);

      var lcpTd = document.createElement("td");
      lcpTd.className = "num-cell";
      lcpTd.innerHTML = MF.escapeHtml(fmt.format(r.lcpRaw)) + SPARK;
      tr.appendChild(lcpTd);

      var lcpDeltaTd = document.createElement("td");
      lcpDeltaTd.className = "delta-cell";
      lcpDeltaTd.innerHTML = DOWN_ARROW + MF.escapeHtml(r.lcpDelta + "%");
      tr.appendChild(lcpDeltaTd);

      var ttiTd = document.createElement("td");
      ttiTd.className = "num-cell";
      ttiTd.innerHTML = MF.escapeHtml(fmt.format(r.ttiRaw)) + SPARK;
      tr.appendChild(ttiTd);

      var ttiDeltaTd = document.createElement("td");
      ttiDeltaTd.className = "delta-cell";
      ttiDeltaTd.innerHTML = DOWN_ARROW + MF.escapeHtml(r.ttiDelta + "%");
      tr.appendChild(ttiDeltaTd);

      els.tbody.appendChild(tr);
    });

    if (data.length) {
      els.showing.textContent =
        "Showing " +
        fmt.format(start + 1) +
        " to " +
        fmt.format(Math.min(start + PER_PAGE, data.length)) +
        " of " +
        fmt.format(data.length) +
        " sites";
    } else {
      els.showing.textContent = "Showing 0 sites";
    }

    MF.renderPagination(els.pagination, state.page, pageCount, function (p) {
      state.page = p;
      renderTable();
    });
  }

  function renderAll() {
    renderCards();
    renderTable();
  }

  els.segmented.forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (btn.dataset.mode === state.mode) return;
      state.mode = btn.dataset.mode;
      state.page = 1;
      els.segmented.forEach(function (b) {
        b.classList.toggle("active", b === btn);
      });
      renderAll();
    });
  });

  els.search.addEventListener("input", function () {
    state.q = els.search.value;
    state.page = 1;
    renderTable();
  });

  els.exportBtn.addEventListener("click", function () {
    var data = filtered();
    MF.downloadCsv(
      "makefaster-sites-" + state.mode + ".csv",
      ["name", "url", "mode", "lcp_ms", "lcp_improvement_pct", "tti_ms", "tti_improvement_pct", "tests", "measured_at"],
      data.map(function (r) {
        return [r.name, r.url, r.mode, r.lcpRaw, r.lcpDelta, r.ttiRaw, r.ttiDelta, r.tests, r.measuredAt];
      })
    );
  });

  MakefasterAPI.getSites()
    .then(function (data) {
      rows = data;
      renderAll();
    })
    .catch(function (err) {
      els.tbody.innerHTML =
        '<tr><td colspan="5" style="text-align:center;color:var(--red);padding:34px 16px;">' +
        "Could not load data/sites.json &mdash; serve the site over HTTP (see README). " +
        "(" + MF.escapeHtml(err.message) + ")</td></tr>";
    });
})();
