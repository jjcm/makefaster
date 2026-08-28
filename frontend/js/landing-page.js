/**
 * The landing page: hero, the copyable `npx makefaster` command, the
 * average-improvement band, and the four-step loop diagram.
 *
 * Light DOM so css/style.css keeps applying, and rendered from a template
 * string because the markup is static — the only behaviour is the copy button.
 */
import "./site-header.js";
import "./geo-row.js";
import "./spec-footer.js";

const COMMAND = "npx makefaster";

/** One before/after metric column of the averages band. */
function metric(abbr, label, afterHeight, pct) {
  return `
    <div class="metric">
      <div class="metric-abbr">${abbr}</div>
      <div class="metric-sub">${label}</div>
      <div class="metric-chart">
        <div class="bar bar--before" aria-hidden="true"></div>
        <div class="bar bar--after" style="height:${afterHeight}px" aria-hidden="true"></div>
        <div class="metric-anno">
          <span class="pct">${pct}</span>
          <svg width="22" height="26" viewBox="0 0 22 26" fill="none" stroke="currentColor" stroke-width="1.3" style="color:var(--red)" aria-hidden="true">
            <path d="M18 1c2 8-3 16-11 20"></path><path d="M11.5 17.5 6.4 21.9l6.4 1.4"></path>
          </svg>
        </div>
      </div>
      <div class="metric-xlabels"><span>Before</span><span>After</span></div>
    </div>`;
}

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
        <span class="corner-plus tr">+</span>
        <span class="corner-plus ml">+</span>

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
                <p>Based on sites that have completed 5+ improvement cycles.</p>
                <div class="band-meta">Dataset: public site leaderboard<br>Updated: continuously</div>
                <div class="dots" aria-hidden="true"></div>
              </div>

              ${metric("LCP", "Largest Contentful Paint", 64, "-38%")}
              ${metric("INP", "Interaction to Next Paint", 76, "-27%")}
              ${metric("CLS", "Cumulative Layout Shift", 79, "-24%")}
              ${metric("TTFB", "Time to First Byte", 72, "-31%")}
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
