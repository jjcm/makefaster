/**
 * The reference tab that sits between the masthead and the page content.
 * Light DOM, for the same reason as <site-header>.
 *
 * `<geo-row bare>` leaves the tab out. The row is then only the gap between
 * the masthead and the content, so it drops to the shorter `georow--bare`
 * height rather than reserving space for a tab that is not there.
 */
class GeoRow extends HTMLElement {
  connectedCallback() {
    this.innerHTML = this.hasAttribute("bare")
      ? '<div class="georow georow--bare"></div>'
      : `
      <div class="georow">
        <div class="ref-tab">REF: MF-001</div>
      </div>`;
  }
}

customElements.define("geo-row", GeoRow);
