/**
 * The drawing-block footer, shared by all three pages. Light DOM, for the same
 * reason as <site-header>.
 */
class SpecFooter extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <footer class="specfooter">
        <span class="bracket bl" aria-hidden="true"></span>
        <span class="bracket br" aria-hidden="true"></span>
        <div class="spec-nums">76.5<br>115.4<br>16.7</div>
        <div class="spec-center">
          <span class="plus">+</span>
          <span>Engineered for Performance</span>
          <span class="plus">+</span>
        </div>
        <div class="spec-nums right">Grid: 12.4<br>Scale: 1:10<br>Units: MM</div>
      </footer>`;
  }
}

customElements.define("spec-footer", SpecFooter);
