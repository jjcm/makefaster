/**
 * Click-to-sort for the two leaderboard tables.
 *
 * Kept free of DOM access so the ordering rules can be tested directly: the
 * component owns the <th> markup and the click handlers, this module owns what
 * "sorted by times improved, descending" actually means.
 *
 * A column declares which way its FIRST click sorts (`firstDir`), because the
 * intuitive first click differs per column: times improved wants the biggest
 * count first, while an LCP time wants the fastest first. Clicking the active
 * column again flips the direction.
 */

/**
 * @typedef {object} SortColumn
 * @property {string} key         identifier used in the header markup and state
 * @property {(row: object) => number|string} value what the column sorts on
 * @property {"asc"|"desc"} firstDir direction the first click applies
 */

/** The direction a click on `key` should produce, given the current state. */
export function nextSort(state, columns, key) {
  var column = findColumn(columns, key);
  if (!column) return state;
  if (state.key === key) {
    return { key: key, dir: state.dir === "asc" ? "desc" : "asc" };
  }
  return { key: key, dir: column.firstDir };
}

export function findColumn(columns, key) {
  for (var i = 0; i < columns.length; i++) {
    if (columns[i].key === key) return columns[i];
  }
  return null;
}

/**
 * A copy of `rows` in sort order. Rows whose value is missing sort last in
 * either direction, so an incomplete row never displaces a measured one.
 * Equal values keep their incoming order, which is the server's ranking.
 */
export function sortRows(rows, columns, state) {
  var column = findColumn(columns, state.key);
  if (!column) return rows.slice();

  var sign = state.dir === "asc" ? 1 : -1;
  return rows
    .map(function (row, index) {
      return { row: row, index: index, value: column.value(row) };
    })
    .sort(function (a, b) {
      var missing = rankMissing(a.value) - rankMissing(b.value);
      if (missing !== 0) return missing;
      var order = compareValues(a.value, b.value);
      if (order !== 0) return order * sign;
      return a.index - b.index;
    })
    .map(function (entry) {
      return entry.row;
    });
}

function rankMissing(value) {
  var absent =
    value === null ||
    value === undefined ||
    value === "" ||
    (typeof value === "number" && !isFinite(value));
  return absent ? 1 : 0;
}

function compareValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en", { sensitivity: "base" });
}

/** The aria-sort value for one header, given the current sort state. */
export function ariaSort(state, key) {
  if (state.key !== key) return "none";
  return state.dir === "asc" ? "ascending" : "descending";
}

/**
 * The header cell for a sortable column. The button carries the click target
 * and the caret; the <th> carries aria-sort so assistive technology reads the
 * column, not the control.
 */
export function sortableHeader(state, key, label, unit) {
  var active = state.key === key;
  var caret = active ? (state.dir === "asc" ? "\u25B2" : "\u25BC") : "\u21C5";
  return (
    '<th scope="col" aria-sort="' + ariaSort(state, key) + '">' +
    '<button type="button" class="th-sort' + (active ? " is-active" : "") + '" data-sort-key="' + key + '">' +
    "<span>" + label + "</span>" +
    '<span class="sort-caret" aria-hidden="true">' + caret + "</span>" +
    "</button>" +
    (unit ? '<span class="unit">' + unit + "</span>" : "") +
    "</th>"
  );
}
