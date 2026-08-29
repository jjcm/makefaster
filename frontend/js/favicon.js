/**
 * Where the site leaderboard loads a row's icon from.
 *
 * Never the origin's own URL. The board used to point <img src> straight at
 * `row.favicon`, which is a third-party URL, and the sites that answer it with
 * hotlink protection or a cross-origin refusal showed a broken image. The
 * server now downloads each icon once, normalizes it, and serves it from its
 * own origin as `row.faviconPath`; this module is the rule that the page only
 * ever asks for that.
 *
 * A row without a served path — no favicon, a URL the server would not fetch,
 * or a deployment that caches none — gets "" and keeps the letter fallback.
 */

// The exact shape the server hands out (internal/favicon): the icons route,
// then one file name of hostname, digest and extension. Matching it strictly is
// what keeps a stored value from turning into a request to somewhere else: an
// absolute URL, a protocol-relative "//evil.example", or a javascript: URL all
// fail here rather than reaching an <img>.
const SERVED_PATH = /^\/favicons\/[a-z0-9][a-z0-9.-]*-[0-9a-f]+\.png$/;

/**
 * The image URL for a board row, or "" when there is none to load.
 *
 * `base` is the API origin when the SPA is hosted apart from the server
 * (window.MAKEFASTER_API_BASE); the icons are served by the same process as
 * /data/sites.json, so they hang off the same base.
 */
export function faviconSrc(row, base) {
  if (!row || typeof row.faviconPath !== "string") return "";
  var path = row.faviconPath;
  if (!SERVED_PATH.test(path)) return "";
  var origin = typeof base === "string" ? base.replace(/\/$/, "") : "";
  return origin + path;
}
