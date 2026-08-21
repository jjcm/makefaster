/**
 * Improvement leaderboard page: ranked categories table with icons,
 * decorative impact sparkbars, pagination, CSV export.
 */
(function () {
  "use strict";

  var PER_PAGE = 12;
  var state = { page: 1 };
  var rows = [];

  var els = {
    tbody: document.getElementById("improvements-tbody"),
    showing: document.getElementById("improvements-showing"),
    pagination: document.getElementById("improvements-pagination"),
    exportBtn: document.getElementById("export-csv"),
  };

  var fmt = new Intl.NumberFormat("en-US");

  /* Generated pictograms (DiffUI text-to-SVG, downloaded locally). */
  var GENERATED_ICONS = {
    gzip: "assets/icons/icon-gzip.svg",
    tree: "assets/icons/icon-tree.svg",
    bolt: "assets/icons/icon-bolt.svg",
  };

  /* Hand-authored standard glyphs (stroke = currentColor). */
  function stroke(inner) {
    return (
      '<svg width="21" height="21" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
      inner +
      "</svg>"
    );
  }

  var HAND_ICONS = {
    clock: stroke('<circle cx="11" cy="11" r="8.5"/><path d="M11 5.5V11l3.8 2.6"/>'),
    image: stroke('<rect x="2" y="3.5" width="18" height="15"/><circle cx="7.5" cy="8.5" r="1.6"/><path d="m4 16 5-5 3.5 3.5L16 11l4 5"/>'),
    code: stroke('<path d="M7.5 6 2.5 11l5 5"/><path d="m14.5 6 5 5-5 5"/><path d="M12.5 4l-3 14"/>'),
    cloud: stroke('<path d="M6.5 17.5a4.5 4.5 0 0 1-.4-9A5.5 5.5 0 0 1 16.7 9a4 4 0 0 1-.7 8.5z"/>'),
    font: stroke('<path d="M4 18 11 4l7 14"/><path d="M6.7 13h8.6"/>'),
    database: stroke('<ellipse cx="11" cy="5" rx="8" ry="2.8"/><path d="M3 5v12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8V5"/><path d="M3 11c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8"/>'),
    cube: stroke('<path d="M11 2.5 19 7v8l-8 4.5L3 15V7z"/><path d="M3 7l8 4.5L19 7"/><path d="M11 11.5v8"/>'),
    document: stroke('<path d="M5 2h8.5L18 6.5V20H5z"/><path d="M13 2v5h5"/><path d="M8 11h7M8 14.5h7"/>'),
    sliders: stroke('<path d="M5.5 3v16M11 3v16M16.5 3v16"/><rect x="3.6" y="7" width="3.8" height="3" fill="currentColor" stroke="none"/><rect x="9.1" y="12" width="3.8" height="3" fill="currentColor" stroke="none"/><rect x="14.6" y="5.5" width="3.8" height="3" fill="currentColor" stroke="none"/>'),
    default: stroke('<path d="M3.5 15.5a8 8 0 1 1 15 0"/><path d="M11 15.5 15 8.5"/><circle cx="11" cy="15.5" r="1.3" fill="currentColor" stroke="none"/>'),
  };

  function iconMarkup(icon) {
    if (GENERATED_ICONS[icon]) {
      return '<img src="' + GENERATED_ICONS[icon] + '" alt="" width="21" height="21">';
    }
    return HAND_ICONS[icon] || HAND_ICONS.default;
  }

  /* Deterministic decorative histogram, scaled by impact. */
  function sparkbars(seed, pct) {
    var rnd = MF.mulberry32(0x6d66 + seed * 977);
    var max = 18;
    var scale = Math.min(1, Math.abs(pct) / 28.6);
    var bars = [];
    for (var i = 0; i < 11; i++) {
      var decay = 1 - i * 0.062;
      var h = max * (0.35 + 0.65 * scale) * decay * (0.7 + rnd() * 0.45);
      h = Math.max(2, Math.min(max, h));
      bars.push(
        '<rect x="' + i * 4.4 + '" y="' + (max - h).toFixed(1) + '" width="2.6" height="' + h.toFixed(1) + '"/>'
      );
    }
    return (
      '<svg width="49" height="18" viewBox="0 0 49 18" fill="currentColor" aria-hidden="true">' +
      bars.join("") +
      "</svg>"
    );
  }

  function renderTable() {
    var pageCount = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    if (state.page > pageCount) state.page = pageCount;
    var start = (state.page - 1) * PER_PAGE;
    var pageRows = rows.slice(start, start + PER_PAGE);

    els.tbody.innerHTML = pageRows
      .map(function (r, i) {
        var rank = r.rank || start + i + 1;
        return (
          "<tr>" +
          '<td class="rank-cell">' + rank + "</td>" +
          '<td><div class="cat-cell"><span class="cat-icon">' +
          iconMarkup(r.icon) +
          '</span><span class="cat-name">' +
          MF.escapeHtml(r.name) +
          "</span></div></td>" +
          '<td class="desc-cell">' + MF.escapeHtml(r.description || "") + "</td>" +
          '<td class="count-cell">' + MF.escapeHtml(fmt.format(r.count)) + "</td>" +
          '<td class="green-cell">' + MF.escapeHtml(r.avgImprovementPct + "%") + "</td>" +
          '<td class="sparkbars-cell">' + sparkbars(rank, r.avgImprovementPct) + "</td>" +
          "</tr>"
        );
      })
      .join("");

    els.showing.textContent =
      "Showing " +
      (start + 1) +
      " to " +
      Math.min(start + PER_PAGE, rows.length) +
      " of " +
      rows.length +
      " improvement categories";

    MF.renderPagination(els.pagination, state.page, pageCount, function (p) {
      state.page = p;
      renderTable();
    });
  }

  els.exportBtn.addEventListener("click", function () {
    MF.downloadCsv(
      "makefaster-improvements.csv",
      ["rank", "name", "description", "times_improved", "avg_improvement_ms", "avg_improvement_pct"],
      rows.map(function (r, i) {
        return [r.rank || i + 1, r.name, r.description, r.count, r.avgImprovementMs, r.avgImprovementPct];
      })
    );
  });

  MakefasterAPI.getImprovements()
    .then(function (data) {
      rows = data.slice().sort(function (a, b) {
        return (a.rank || 0) - (b.rank || 0);
      });
      renderTable();
    })
    .catch(function (err) {
      els.tbody.innerHTML =
        '<tr><td colspan="6" style="text-align:center;color:var(--red);padding:34px 16px;">' +
        "Could not load data/improvements.json &mdash; serve the site over HTTP (see README). " +
        "(" + MF.escapeHtml(err.message) + ")</td></tr>";
    });
})();
