/**
 * Site-leaderboard row management: URL normalization and upsert of one
 * measurement run into the rows list (one row per site per cold/warm mode).
 */

const NAME_MAX = 80;

/**
 * Normalize whatever the submitter sent ("https://Example.com/path",
 * "www.example.com", "example.com") to a bare lowercase hostname.
 * Returns null when it cannot be read as a hostname.
 */
export function normalizeSiteUrl(input) {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 300) return null;

  let hostname;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return null;
  }

  hostname = hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  // Require a dotted hostname of sane label characters; localhost and bare
  // hosts are fine for local testing but have no place on a public board.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)) {
    return null;
  }
  if (hostname.length > 253) return null;
  return hostname;
}

/** "docs.example.com" -> "Example" — a display-name fallback. */
export function displayNameForUrl(url) {
  const labels = url.split(".");
  const core = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

export function defaultFaviconForUrl(url) {
  return `https://icons.duckduckgo.com/ip3/${url}.ico`;
}

/**
 * Upsert one validated measurement into the rows list.
 * Existing (url, mode) row: metrics are replaced by the latest run, the test
 * counter increments, and name/favicon refresh when provided. New row: test
 * counter starts at 1.
 *
 * @returns {{rows: Array<object>, row: object, created: boolean}}
 */
export function upsertSite(rows, submission, nowIso) {
  const next = rows.map((row) => ({ ...row }));
  const index = next.findIndex(
    (row) => row.url === submission.url && row.mode === submission.mode,
  );

  const base = index === -1 ? null : next[index];
  const row = {
    name: (submission.name || base?.name || displayNameForUrl(submission.url)).slice(0, NAME_MAX),
    url: submission.url,
    favicon: submission.favicon || base?.favicon || defaultFaviconForUrl(submission.url),
    lcpRaw: submission.lcpRaw,
    lcpDelta: submission.lcpDelta,
    ttiRaw: submission.ttiRaw,
    ttiDelta: submission.ttiDelta,
    mode: submission.mode,
    tests: (base?.tests || 0) + 1,
    measuredAt: nowIso,
  };

  if (index === -1) {
    next.push(row);
  } else {
    next[index] = row;
  }
  return { rows: next, row, created: index === -1 };
}
