/**
 * The reference tab that sits between the masthead and the page content.
 * Light DOM, for the same reason as <site-header>.
 */
class GeoRow extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <div class="georow">
        <div class="ref-tab">REF: MF-001</div>
      </div>`;
  }
}

customElements.define("geo-row", GeoRow);
