/**
 * The site leaderboard: aggregate stat cards, a cold/warm filter, search, a
 * paginated table of sites, and CSV export.
 *
 * Light DOM so css/style.css keeps applying.
 */
import "./site-header.js";
import "./geo-row.js";
import "./spec-footer.js";
import { getSites } from "./api.js";
import { escapeHtml, renderPagination, downloadCsv } from "./format.js";
import { nextSort, sortRows, sortableHeader } from "./table-sort.js";

const PER_PAGE = 10;

/**
 * Both ends of each metric are shown and each is sortable on its own header:
 * clicking "Before" sorts the pre-loop measurement, clicking "After" sorts the
 * measurement the loop ended on. Times sort fastest-first on the first click;
 * the improvement columns are negative when the site got faster, so their
 * first click is ascending — biggest improvement first.
 */
const SORT_COLUMNS = [
  { key: "lcpBefore", value: (r) => r.lcpBefore, firstDir: "asc" },
  { key: "lcpRaw", value: (r) => r.lcpRaw, firstDir: "asc" },
  { key: "lcpDelta", value: (r) => r.lcpDelta, firstDir: "asc" },
  { key: "ttiBefore", value: (r) => r.ttiBefore, firstDir: "asc" },
  { key: "ttiRaw", value: (r) => r.ttiRaw, firstDir: "asc" },
  { key: "ttiDelta", value: (r) => r.ttiDelta, firstDir: "asc" },
];

// The table had no sort of its own before, so the default is the thing the
// board is for: the biggest LCP improvement first.
const DEFAULT_SORT = { key: "lcpDelta", dir: "asc" };

const COLUMN_COUNT = 7;

const fmt = new Intl.NumberFormat("en-US");

// Fixed ascending staircase glyph, as drawn beside raw values in the design.
const SPARK =
  '<svg class="spark" width="27" height="14" viewBox="0 0 27 14" fill="currentColor" aria-hidden="true">' +
  ["3", "4.5", "6", "7.5", "9", "10.5", "12", "13.5"]
    .map(function (h, i) {
      var height = parseFloat(h);
      return '<rect x="' + i * 3.4 + '" y="' + (14 - height) + '" width="2.1" height="' + height + '"/>';
    })
    .join("") +
  "</svg>";

const DOWN_ARROW =
  '<svg class="icon" width="10" height="12" viewBox="0 0 10 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">' +
  '<path d="M5 0v10M1 7l4 4 4-4"/></svg>';

/** One stat card of the summary row; `sub` is the caption under the value. */
function statCard(id, label, glyph, sub) {
  return `
    <div class="stat-card">
      <div class="stat-card-head">
        <svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">${glyph}</svg>
        <span>${label}</span>
      </div>
      <div class="stat-value" id="${id}">&ndash;</div>
      <div class="stat-sub">${sub}</div>
    </div>`;
}

const VS_BASELINE = `
  <svg class="icon" width="10" height="12" viewBox="0 0 10 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
    <path d="M5 0v10M1 7l4 4 4-4"></path>
  </svg>
  <span>vs. baseline</span>`;

/** The pre-loop measurement: same figures as the after column, muted. */
function baselineCell(ms) {
  var td = document.createElement("td");
  td.className = "num-cell num-cell--before";
  td.textContent = typeof ms === "number" ? fmt.format(ms) : "\u2013";
  return td;
}

/** The measurement the loop ended on, with the staircase glyph beside it. */
function measuredCell(ms) {
  var td = document.createElement("td");
  td.className = "num-cell";
  td.innerHTML = typeof ms === "number" ? escapeHtml(fmt.format(ms)) + SPARK : "\u2013";
  return td;
}

function deltaCell(pct) {
  var td = document.createElement("td");
  td.className = "delta-cell";
  td.innerHTML = typeof pct === "number" ? DOWN_ARROW + escapeHtml(pct + "%") : "\u2013";
  return td;
}

class SiteLeaderboardPage extends HTMLElement {
  constructor() {
    super();
    this.state = { mode: "cold", q: "", page: 1, sort: DEFAULT_SORT };
    this.rows = [];
  }

  connectedCallback() {
    this.innerHTML = `
      <div class="sheet sheet--framed">
        <span class="corner-plus tl">+</span>
        <span class="corner-plus tr">+</span>
        <span class="corner-plus ml">+</span>
        <span class="corner-plus mr">+</span>

        <site-header></site-header>

        <div class="sheet-inner">
          <geo-row></geo-row>

          <main>
            <div class="eyebrow">
              <span class="plus">+</span>
              <span>Autonomous Performance Research / 001</span>
              <span class="eyebrow-dots dots" aria-hidden="true"></span>
            </div>

            <div class="page-head">
              <h1 class="page-title">Site leaderboard</h1>
            </div>

            <section class="stat-cards" id="stat-cards" aria-label="Aggregate statistics">
              ${statCard("card-lcp", "Avg LCP Improvement",
                '<path d="M1 13.5 5.5 8l3 3L15 3.5"></path><path d="M10.5 3.5H15V8"></path>', VS_BASELINE)}
              ${statCard("card-tti", "Avg TTI Improvement",
                '<circle cx="8" cy="9.5" r="5.5"></circle><path d="M6 1h4M8 1v3M8 9.5l2.5-2.5"></path>', VS_BASELINE)}
              ${statCard("card-sites", "Sites Submitted",
                '<ellipse cx="8" cy="3.4" rx="6" ry="2.4"></ellipse><path d="M2 3.4v9.2c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V3.4"></path><path d="M2 8c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4"></path>',
                "<span>sites</span>")}
              ${statCard("card-tests", "Avg Tests / Site",
                '<circle cx="8" cy="8" r="7"></circle><path d="M8 3.5V8l3 2"></path>', "<span>tests</span>")}
              <div class="stat-card">
                <div class="stat-card-head">
                  <svg class="icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                    <rect x="1" y="2.5" width="14" height="12.5"></rect><path d="M1 6.5h14M4.5 0.5v4M11.5 0.5v4"></path>
                  </svg>
                  <span>Last Updated</span>
                </div>
                <div class="stat-value small" id="card-updated">&ndash;</div>
                <div class="stat-sub"><span id="card-updated-sub">&nbsp;</span></div>
              </div>
            </section>

            <section class="controls">
              <div class="load-type">
                <span class="mono-label">Load Type</span>
                <div class="segmented" role="group" aria-label="Load type filter">
                  <button type="button" data-mode="cold" class="active">Cold Load</button>
                  <button type="button" data-mode="warm">Warm Load</button>
                </div>
              </div>
              <div class="controls-right">
                <label class="search">
                  <svg class="icon" width="14" height="14" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                    <circle cx="6.5" cy="6.5" r="5"></circle><path d="m10.5 10.5 3.5 3.5"></path>
                  </svg>
                  <input type="search" id="site-search" placeholder="Search sites..." aria-label="Search sites">
                </label>
                <button type="button" class="btn-outline" id="export-csv">
                  <svg class="icon" width="14" height="14" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
                    <path d="M7.5 1v8.5M4 6l3.5 3.5L11 6"></path><path d="M1.5 11v2.5h12V11"></path>
                  </svg>
                  <span>Export CSV</span>
                </button>
              </div>
            </section>

            <div class="table-scroll">
              <table class="data-table" id="sites-table">
                <thead>
                  <tr id="sites-head"></tr>
                </thead>
                <tbody id="sites-tbody"></tbody>
              </table>
            </div>

            <div class="table-foot">
              <span class="showing" id="sites-showing"></span>
              <nav class="pagination" id="sites-pagination" aria-label="Site pages"></nav>
            </div>
          </main>

          <spec-footer></spec-footer>
        </div>
      </div>`;

    this.els = {
      lcp: this.querySelector("#card-lcp"),
      tti: this.querySelector("#card-tti"),
      sites: this.querySelector("#card-sites"),
      tests: this.querySelector("#card-tests"),
      updated: this.querySelector("#card-updated"),
      updatedSub: this.querySelector("#card-updated-sub"),
      head: this.querySelector("#sites-head"),
      tbody: this.querySelector("#sites-tbody"),
      showing: this.querySelector("#sites-showing"),
      pagination: this.querySelector("#sites-pagination"),
      search: this.querySelector("#site-search"),
      exportBtn: this.querySelector("#export-csv"),
      segmented: this.querySelectorAll(".segmented button"),
    };

    this.bind();
    this.renderHead();
    this.load();
  }

  bind() {
    var self = this;

    // One listener on the header row, so re-rendering the <th>s cannot leave
    // stale handlers behind.
    this.els.head.addEventListener("click", function (event) {
      var button = event.target.closest("[data-sort-key]");
      if (!button) return;
      self.state.sort = nextSort(self.state.sort, SORT_COLUMNS, button.dataset.sortKey);
      self.state.page = 1;
      self.renderTable();
    });

    this.els.segmented.forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.mode === self.state.mode) return;
        self.state.mode = btn.dataset.mode;
        self.state.page = 1;
        self.els.segmented.forEach(function (b) {
          b.classList.toggle("active", b === btn);
        });
        self.renderAll();
      });
    });

    this.els.search.addEventListener("input", function () {
      self.state.q = self.els.search.value;
      self.state.page = 1;
      self.renderTable();
    });

    this.els.exportBtn.addEventListener("click", function () {
      downloadCsv(
        "makefaster-sites-" + self.state.mode + ".csv",
        [
          "name", "url", "mode",
          "lcp_before_ms", "lcp_after_ms", "lcp_improvement_pct",
          "tti_before_ms", "tti_after_ms", "tti_improvement_pct",
          "tests", "measured_at",
        ],
        self.filtered().map(function (r) {
          return [
            r.name, r.url, r.mode,
            r.lcpBefore, r.lcpRaw, r.lcpDelta,
            r.ttiBefore, r.ttiRaw, r.ttiDelta,
            r.tests, r.measuredAt,
          ];
        })
      );
    });
  }

  renderHead() {
    var sort = this.state.sort;
    this.els.head.innerHTML =
      '<th scope="col">Site</th>' +
      sortableHeader(sort, "lcpBefore", "LCP Before", "ms") +
      sortableHeader(sort, "lcpRaw", "LCP After", "ms") +
      sortableHeader(sort, "lcpDelta", "LCP Improvement", "vs. baseline") +
      sortableHeader(sort, "ttiBefore", "TTI Before", "ms") +
      sortableHeader(sort, "ttiRaw", "TTI After", "ms") +
      sortableHeader(sort, "ttiDelta", "TTI Improvement", "vs. baseline");
  }

  load() {
    var self = this;
    getSites()
      .then(function (data) {
        self.rows = data;
        self.renderAll();
      })
      .catch(function (err) {
        self.els.tbody.innerHTML =
          '<tr><td colspan="' + COLUMN_COUNT + '" style="text-align:center;color:var(--red);padding:34px 16px;">' +
          "Could not load /data/sites.json &mdash; start the server with ./run.sh (see README). " +
          "(" + escapeHtml(err.message) + ")</td></tr>";
      });
  }

  filtered() {
    var q = this.state.q.trim().toLowerCase();
    var mode = this.state.mode;
    var matching = this.rows.filter(function (r) {
      if (r.mode !== mode) return false;
      if (!q) return true;
      return (
        (r.url || "").toLowerCase().indexOf(q) !== -1 ||
        (r.name || "").toLowerCase().indexOf(q) !== -1
      );
    });
    return sortRows(matching, SORT_COLUMNS, this.state.sort);
  }

  renderCards() {
    var mode = this.state.mode;
    var sel = this.rows.filter(function (r) {
      return r.mode === mode;
    });
    if (!sel.length) return;

    function avg(key) {
      return (
        sel.reduce(function (a, r) {
          return a + (r[key] || 0);
        }, 0) / sel.length
      );
    }

    this.els.lcp.textContent = Math.round(avg("lcpDelta")) + "%";
    this.els.tti.textContent = Math.round(avg("ttiDelta")) + "%";

    var unique = {};
    this.rows.forEach(function (r) {
      unique[r.url] = r.tests || 0;
    });
    var urls = Object.keys(unique);
    this.els.sites.textContent = fmt.format(urls.length);

    var testsAvg =
      urls.reduce(function (a, u) {
        return a + unique[u];
      }, 0) / urls.length;
    this.els.tests.textContent = testsAvg.toFixed(1);

    var latest = this.rows.reduce(function (a, r) {
      return r.measuredAt && r.measuredAt > a ? r.measuredAt : a;
    }, "");
    if (latest) {
      var d = new Date(latest);
      this.els.updated.textContent = new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(d);
      this.els.updatedSub.textContent =
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "UTC",
        }).format(d) + " UTC";
    }
  }

  faviconCell(row) {
    var box = document.createElement("div");
    box.className = "favicon-box";
    var letter = ((row.name || row.url || "?").trim()[0] || "?").toUpperCase();
    if (row.favicon) {
      var img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", function () {
        box.innerHTML = '<div class="favicon-fallback">' + escapeHtml(letter) + "</div>";
      });
      img.src = row.favicon;
      box.appendChild(img);
    } else {
      box.innerHTML = '<div class="favicon-fallback">' + escapeHtml(letter) + "</div>";
    }
    return box;
  }

  renderTable() {
    var self = this;
    this.renderHead();
    var data = this.filtered();
    var pageCount = Math.max(1, Math.ceil(data.length / PER_PAGE));
    if (this.state.page > pageCount) this.state.page = pageCount;
    var start = (this.state.page - 1) * PER_PAGE;
    var pageRows = data.slice(start, start + PER_PAGE);

    this.els.tbody.innerHTML = "";

    if (!pageRows.length) {
      var empty = document.createElement("tr");
      var message = this.rows.length
        ? "No sites match your search."
        : "No sites yet \u2014 the board fills up as loops submit their results.";
      empty.innerHTML =
        '<td colspan="' + COLUMN_COUNT + '" style="text-align:center;color:var(--muted);padding:34px 16px;">' +
        message + "</td>";
      this.els.tbody.appendChild(empty);
    }

    pageRows.forEach(function (r) {
      var tr = document.createElement("tr");

      var siteTd = document.createElement("td");
      var cell = document.createElement("div");
      cell.className = "site-cell";
      cell.appendChild(self.faviconCell(r));
      var meta = document.createElement("div");
      meta.innerHTML =
        '<div class="site-name">' +
        escapeHtml(r.name || r.url) +
        '</div><div class="site-url">' +
        escapeHtml(r.url) +
        "</div>";
      cell.appendChild(meta);
      siteTd.appendChild(cell);
      tr.appendChild(siteTd);

      tr.appendChild(baselineCell(r.lcpBefore));
      tr.appendChild(measuredCell(r.lcpRaw));
      tr.appendChild(deltaCell(r.lcpDelta));
      tr.appendChild(baselineCell(r.ttiBefore));
      tr.appendChild(measuredCell(r.ttiRaw));
      tr.appendChild(deltaCell(r.ttiDelta));

      self.els.tbody.appendChild(tr);
    });

    if (data.length) {
      this.els.showing.textContent =
        "Showing " +
        fmt.format(start + 1) +
        " to " +
        fmt.format(Math.min(start + PER_PAGE, data.length)) +
        " of " +
        fmt.format(data.length) +
        " sites";
    } else {
      this.els.showing.textContent = "Showing 0 sites";
    }

    // Nothing to page through: 0 renders an empty nav rather than a lone "1".
    renderPagination(this.els.pagination, this.state.page, data.length ? pageCount : 0, function (p) {
      self.state.page = p;
      self.renderTable();
    });
  }

  renderAll() {
    this.renderCards();
    this.renderTable();
  }
}

customElements.define("site-leaderboard-page", SiteLeaderboardPage);
