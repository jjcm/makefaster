/**
 * The landing page: hero, the copyable `npx makefaster` command, the
 * average-improvement band, and the four-step loop diagram.
 *
 * Light DOM so css/style.css keeps applying. The markup is a template string
 * because almost all of it is static; the two behaviours are the copy button
 * and the band, whose numbers are read from the live site leaderboard rather
 * than written into the template (see site-stats.js).
 */
import "./site-header.js";
import "./geo-row.js";
import "./spec-footer.js";
import { getSites } from "./api.js";
import { afterBarHeight, formatDeltaPct, summarizeSites } from "./site-stats.js";

const COMMAND = "npx makefaster";

/**
 * The red annotation arrow beside each percentage: a curve down from the
 * "before" bar to the "after" one, with a chevron head at the tip.
 *
 * The head is symmetric about the curve's own end tangent and spread wide
 * enough to clear it. A narrower head tucks its upper arm underneath the curve,
 * which is what made this read as half a `<` rather than an arrowhead. Both
 * arms are ~6 units long and every point stays inside the 22x26 viewBox, so
 * nothing depends on overflow to be visible.
 */
const ANNO_ARROW = `
  <svg width="22" height="26" viewBox="0 0 22 26" fill="none" stroke="currentColor" stroke-width="1.3"
       stroke-linecap="round" stroke-linejoin="round" style="color:var(--red)" aria-hidden="true">
    <path d="M18 1c2 8-3 16-11 20"></path><path d="M12.9 22.2 7 21l2.6-5.4"></path>
  </svg>`;

/**
 * One before/after metric column. The bar height and the percentage are filled
 * in by renderStats() once the board answers — the template ships the frame,
 * not a number.
 */
function metric(key, abbr, label) {
  return `
    <div class="metric" data-metric="${key}">
      <div class="metric-abbr">${abbr}</div>
      <div class="metric-sub">${label}</div>
      <div class="metric-chart metric-chart--empty">
        <div class="bar bar--before" aria-hidden="true"></div>
        <div class="bar bar--after" style="height:0" aria-hidden="true"></div>
        <div class="metric-anno">
          <span class="pct">&ndash;</span>
          ${ANNO_ARROW}
        </div>
      </div>
      <div class="metric-xlabels"><span>Before</span><span>After</span></div>
    </div>`;
}

/**
 * The count column. Not a before/after pair — how many sites are on the board
 * has no baseline — so it keeps the column frame and prints one number.
 */
function countMetric(key, abbr, label, caption) {
  return `
    <div class="metric" data-metric="${key}">
      <div class="metric-abbr">${abbr}</div>
      <div class="metric-sub">${label}</div>
      <div class="metric-count"><span class="count">&ndash;</span></div>
      <div class="metric-xlabels"><span>${caption}</span></div>
    </div>`;
}

/**
 * What the band says it is averaging. The methodology line is the honest place
 * for the cold/warm choice, and an empty board says so rather than presenting
 * three dashes with no explanation.
 */
const BAND_NOTES = {
  loading: "Averaged across the public site leaderboard.",
  ready: "Averaged across the public site leaderboard \u2014 one run per site, the cold load where a site has both.",
  empty: "No runs on the public site leaderboard yet. It fills up as loops submit their results.",
  failed: "The public site leaderboard could not be read just now.",
};

const CROSSHAIR = `
  <circle cx="15" cy="15" r="9"></circle><path d="M15 1v28M1 15h28"></path>`;

const STEP_ARROW = `
  <svg class="step-arrow icon" width="34" height="12" viewBox="0 0 34 12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
    <path d="M0 6h31"></path><path d="M26 1.5 32 6l-6 4.5"></path>
  </svg>`;

/** One numbered step of the loop diagram; `art` is an <img> or inline <svg>. */
function step(number, title, art, copy) {
  return `
    <div class="step">
      <div class="pictoframe">
        <span class="c tl"></span><span class="c tr"></span><span class="c bl"></span><span class="c br"></span>
        ${art}
      </div>
      <div class="step-label"><span class="num">${number}</span>${title}</div>
      <p>${copy}</p>
    </div>`;
}

function icon(src) {
  return `<img src="${src}" alt="" width="52" height="52">`;
}

class LandingPage extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="sheet sheet--open">
        <span class="corner-plus tl">+</span>
        <span class="corner-plus tr">+</span>

        <site-header></site-header>

        <geo-row></geo-row>

        <main>
          <div class="eyebrow">
            <span class="plus">+</span>
            <span>Autonomous Performance Research / 001</span>
            <span class="eyebrow-dots dots" aria-hidden="true"></span>
          </div>

          <section class="hero">
            <span class="hero-tick" aria-hidden="true"></span>
            <span class="hero-tick" aria-hidden="true"></span>
            <div class="hero-rule" aria-hidden="true"><span class="plus">+</span></div>
            <h1>AI that makes your<br>site faster. Automatically.</h1>
            <p class="lede">Makefaster.dev is an AI skill that runs an autoresearch loop to continuously discover, test, and implement performance improvements. It learns what works for your site&mdash;and keeps making it faster.</p>
          </section>

          <section class="cmd-wrap">
            <div class="cmd-shell">
              <button class="cmd" id="copy-cmd" type="button" data-command="${COMMAND}" aria-label="Copy command: ${COMMAND}">
                <span class="cmd-chevron" aria-hidden="true">&gt;</span>
                <span class="cmd-text">${COMMAND}</span>
                <span class="cmd-copy">
                  <svg class="icon" width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true">
                    <rect x="4.5" y="1" width="9.5" height="9.5"></rect><rect x="1" y="4.5" width="9.5" height="9.5"></rect>
                  </svg>
                  <span class="cmd-copy-label">Copy</span>
                </span>
              </button>
            </div>
            <div class="specimen-line">
              <span class="plus" aria-hidden="true">+</span>
              <a href="https://x.com/pwnies" target="_blank" rel="noopener noreferrer">Made by @pwnies</a>
              <span class="plus" aria-hidden="true">+</span>
            </div>
          </section>

          <section class="band">
            <svg class="band-xhair icon" width="26" height="26" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">${CROSSHAIR}</svg>
            <svg class="band-xhair bottom icon" width="26" height="26" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true">${CROSSHAIR}</svg>

            <div class="band-grid">
              <div class="band-info">
                <span class="mono-label">Average Improvements</span>
                <span class="dash">&mdash;</span>
                <p id="band-note">${BAND_NOTES.loading}</p>
                <div class="band-meta">Dataset: public site leaderboard<br>Updated: continuously</div>
                <div class="dots" aria-hidden="true"></div>
              </div>

              ${metric("lcp", "LCP", "Largest Contentful Paint")}
              ${metric("tti", "TTI", "Time to Interactive")}
              ${countMetric("sites", "SITES", "Measured on the public board", "sites")}
            </div>
          </section>

          <section class="how">
            <div class="how-info">
              <span class="mono-label">How It Works</span>
              <p>An autonomous loop that continuously improves your site over time.</p>
              <div class="dots" aria-hidden="true"></div>
            </div>

            <div class="steps">
              ${step("01", "Research", icon("/assets/icons/icon-research.svg"),
                "AI discovers performance issues and opportunities unique to your site.")}
              ${STEP_ARROW}
              ${step("02", "Experiment", icon("/assets/icons/icon-experiment.svg"),
                "Generates and tests hypothesis in a safe, isolated environment.")}
              ${STEP_ARROW}
              ${step("03", "Implement", `
                <svg width="52" height="52" viewBox="0 0 64 64" fill="none" stroke="#17395e" stroke-width="3.2" aria-hidden="true">
                  <path d="M22 20 10 32l12 12"></path><path d="M42 20 54 32 42 44"></path><path d="M36 14 28 50"></path>
                </svg>`,
                "Applies the best improvements automatically.")}
              ${STEP_ARROW}
              ${step("04", "Repeat", icon("/assets/icons/icon-repeat.svg"),
                "Measures results and starts the next iteration. Always getting faster.")}
            </div>
          </section>
        </main>

        <spec-footer></spec-footer>
      </div>

      <div class="page-end" aria-hidden="true"></div>`;

    this.querySelector("#copy-cmd").addEventListener("click", this.copyCommand.bind(this));
    this.loadStats();
  }

  /**
   * Fill the band from the live board. A board that cannot be read leaves the
   * dashes in place and says so — the rest of the page is not about the
   * leaderboard, so a failure here must not take it down.
   */
  loadStats() {
    var self = this;
    getSites().then(
      function (rows) {
        self.renderStats(summarizeSites(rows));
      },
      function () {
        self.setNote(BAND_NOTES.failed);
      }
    );
  }

  renderStats(stats) {
    this.setDelta("lcp", stats.lcpDelta);
    this.setDelta("tti", stats.ttiDelta);
    this.querySelector('[data-metric="sites"] .count').textContent = String(stats.siteCount);
    this.setNote(stats.siteCount === 0 ? BAND_NOTES.empty : BAND_NOTES.ready);
  }

  /**
   * One metric column. With no measurement the bars stay hidden rather than
   * collapsing to zero height: a 0px "after" bar beside a full "before" bar
   * reads as a 100% improvement, which is the one thing an empty board must
   * not appear to claim.
   */
  setDelta(key, pct) {
    var column = this.querySelector('[data-metric="' + key + '"]');
    var measured = typeof pct === "number" && isFinite(pct);
    column.querySelector(".pct").textContent = formatDeltaPct(pct);
    column.querySelector(".bar--after").style.height = afterBarHeight(pct) + "px";
    column.querySelector(".metric-chart").classList.toggle("metric-chart--empty", !measured);
  }

  setNote(text) {
    this.querySelector("#band-note").textContent = text;
  }

  copyCommand() {
    const button = this.querySelector("#copy-cmd");
    const command = button.getAttribute("data-command") || COMMAND;
    const label = button.querySelector(".cmd-copy-label");

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
  }
}

/** execCommand fallback for browsers without the async clipboard API. */
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

customElements.define("landing-page", LandingPage);
