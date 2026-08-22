/**
 * The masthead, extracted from the three pages that used to duplicate it.
 *
 * Deliberately light DOM, not a shadow root: every rule in css/style.css that
 * targets .masthead, .brand, .site-nav and friends keeps applying, so the
 * component is a pure de-duplication with no styling rewrite behind it. The
 * host element needs `site-header { display: block }` for the same reason.
 *
 * The framed leaderboard pages carry an extra dotted rail below the crosshair
 * cell; the landing sheet does not. Which one we are in is read from the
 * enclosing sheet rather than passed in as an attribute.
 */

const LINKS = [
  { href: "https://github.com/jjcm/makefaster", label: "Github" },
  { href: "/site-leaderboard", label: "Site leaderboard" },
  { href: "/improvement-leaderboard", label: "Improvement leaderboard" },
];

class SiteHeader extends HTMLElement {
  connectedCallback() {
    const currentPage = window.location.pathname;
    const isFramed = Boolean(this.closest(".sheet--framed"));
    const nav = LINKS.map(({ href, label }) => {
      const isCurrent = href === currentPage;
      const currentAttributes = isCurrent ? ' class="active" aria-current="page"' : "";
      return `<a href="${href}"${currentAttributes}>${label}</a>`;
    }).join("");
    this.innerHTML = `
      <header class="masthead">
        <div class="masthead-main">
          <a class="brand" href="/">
            <img src="/assets/logo.svg" alt="Makefaster mark — lightning bolt inside a circular arrow" width="42" height="42">
            <span class="brand-word">Makefaster</span>
          </a>
          <nav class="site-nav" aria-label="Primary">${nav}</nav>
        </div>
        <div class="masthead-cell" aria-hidden="true">
          <svg class="icon" width="30" height="30" viewBox="0 0 30 30" fill="none" stroke="currentColor" stroke-width="1">
            <circle cx="15" cy="15" r="9"></circle><path d="M15 1v28M1 15h28"></path>
          </svg>
        </div>
        ${isFramed ? '<div class="rail-dots" aria-hidden="true"><div class="dots"></div></div>' : ""}
      </header>`;
  }
}

customElements.define("site-header", SiteHeader);
