/**
 * The application shell. It owns exactly one thing: swapping the page
 * component for the current route, and keeping the document metadata in sync
 * with it.
 *
 * Pages are replaced rather than hidden, so each one re-renders (and re-fetches
 * its board) on entry and leaves nothing behind on exit.
 */
import "./landing-page.js";
import "./site-leaderboard-page.js";
import "./improvement-leaderboard-page.js";
import { routeFor, onRouteChange } from "./router.js";

const BODY_CLASSES = ["landing", "framed"];

class AppRoot extends HTMLElement {
  connectedCallback() {
    this.render();
    onRouteChange(this.render.bind(this));
  }

  render() {
    const route = routeFor(window.location.pathname);
    if (this.currentPath === route.path) return;
    this.currentPath = route.path;

    document.title = route.title;
    const description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute("content", route.description);

    document.body.classList.remove(...BODY_CLASSES);
    document.body.classList.add(route.bodyClass);

    this.replaceChildren(document.createElement(route.element));
    window.scrollTo(0, 0);
  }
}

customElements.define("app-root", AppRoot);
