/**
 * The History API router behind the single-page site.
 *
 * Routes are real paths, not hashes, so `/site-leaderboard` is a URL you can
 * link to, share, and hard-refresh — the Go server falls back to index.html
 * for any app route it does not recognize as a file.
 */

/** The route table. `path` doubles as the in-app href for <site-header>. */
export const ROUTES = [
  {
    path: "/",
    element: "landing-page",
    bodyClass: "landing",
    title: "Makefaster — AI that makes your site faster. Automatically.",
    description:
      "Makefaster.dev is an AI skill that runs an autoresearch loop to continuously discover, test, and implement performance improvements.",
  },
  {
    path: "/site-leaderboard",
    element: "site-leaderboard-page",
    bodyClass: "framed",
    title: "Site leaderboard — Makefaster",
    description: "Average performance stats and per-site LCP / TTI improvements measured by Makefaster.",
  },
  {
    path: "/improvement-leaderboard",
    element: "improvement-leaderboard-page",
    bodyClass: "framed",
    title: "Improvement Leaderboard — Makefaster",
    description:
      "Performance improvement categories ranked by frequency and average impact, measured by Makefaster.",
  },
];

/**
 * The pre-SPA page names. The server 301s these, but a click on a stale
 * in-page link is resolved here too rather than triggering a full reload.
 */
const LEGACY_PATHS = {
  "/index.html": "/",
  "/site-leaderboard.html": "/site-leaderboard",
  "/improvement-leaderboard.html": "/improvement-leaderboard",
};

/** Normalize a pathname to a route path, tolerating trailing slashes. */
export function normalizePath(pathname) {
  if (LEGACY_PATHS[pathname]) return LEGACY_PATHS[pathname];
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname || "/";
}

/** The route for a pathname; unknown paths land on the landing page. */
export function routeFor(pathname) {
  var path = normalizePath(pathname);
  return ROUTES.find(function (route) { return route.path === path; }) || ROUTES[0];
}

/** Push a new route and notify listeners. Same-path navigation is a no-op. */
export function navigate(path) {
  var target = normalizePath(path);
  if (target === normalizePath(window.location.pathname)) return;
  window.history.pushState({}, "", target);
  window.dispatchEvent(new CustomEvent("mf:navigate"));
}

/**
 * Intercept clicks on in-app links so navigation never round-trips to the
 * server. External links, downloads, new-tab clicks, and modified clicks are
 * left to the browser.
 */
export function interceptLinks() {
  document.addEventListener("click", function (event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    var link = event.target.closest && event.target.closest("a[href]");
    if (!link || link.target === "_blank" || link.hasAttribute("download")) return;

    var url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin) return;

    var path = normalizePath(url.pathname);
    if (!ROUTES.some(function (route) { return route.path === path; })) return;

    event.preventDefault();
    navigate(path);
  });
}

/** Run `listener` on every route change, including the browser's back button. */
export function onRouteChange(listener) {
  window.addEventListener("popstate", listener);
  window.addEventListener("mf:navigate", listener);
}
