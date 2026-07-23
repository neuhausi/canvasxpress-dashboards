/**
 * Grid geometry for dashboards. Spacing between panels is a "gutter only between
 * adjacent panels" model: a gap track is interleaved between every unit
 * row/column, but each gap track is sized to `gap` **only when a panel edge
 * falls on that boundary** — otherwise 0. Consequences:
 *
 *  - a panel always measures exactly `h*rowHeight` (× its columns), independent
 *    of the gap — internal boundaries are 0-sized, so a gap never inflates it;
 *  - gutters appear only where two panels meet; a lone panel and the outer edges
 *    are never affected;
 *  - placement lines are a fixed function of the unit coordinate
 *    (`2*coord+1`), so only the *track sizes* change with the gap — the builder
 *    can restyle cells in place during a drag without anything jumping.
 *
 * @module gridLayout
 */

/**
 * Build the CSS grid track templates for a set of layout items.
 * @param {object[]} items - Layout items (`{x, y, w, h}`).
 * @param {number} cols - Column count.
 * @param {number} rowHeight - Height of one unit row (px).
 * @param {number} gap - Gutter size (px) between adjacent panels.
 * @returns {{columns: string, rows: string, maxRow: number}} Track templates.
 */
export function gridTemplate(items, cols, rowHeight, gap) {
  items = items || [];
  var maxRow = 1;
  items.forEach(function (it) { maxRow = Math.max(maxRow, it.y + it.h); });

  var colEdge = boundarySet(items, 'x', 'w', cols);
  var rowEdge = boundarySet(items, 'y', 'h', maxRow);

  var columns = interleave(cols, 'minmax(0, 1fr)', colEdge, gap);
  var rows = interleave(maxRow, rowHeight + 'px', rowEdge, gap);
  return { columns: columns, rows: rows, maxRow: maxRow };
}

/**
 * The `grid-column` / `grid-row` placement for one item, in the interleaved
 * track coordinate system (fixed regardless of the gap).
 * @param {object} item - Layout item (`{x, y, w, h}`).
 * @returns {{column: string, row: string}} CSS grid placement values.
 */
export function cellArea(item) {
  return {
    column: (2 * item.x + 1) + ' / ' + (2 * (item.x + item.w)),
    row: (2 * item.y + 1) + ' / ' + (2 * (item.y + item.h))
  };
}

/**
 * The set of interior boundary lines (1..extent-1) that coincide with a panel
 * edge (a top/left or bottom/right of some item).
 * @param {object[]} items - Layout items.
 * @param {('x'|'y')} pos - Position key.
 * @param {('w'|'h')} size - Size key.
 * @param {number} extent - Number of unit tracks in this axis.
 * @returns {Object<number, boolean>} Map of boundary line → true.
 * @private
 */
function boundarySet(items, pos, size, extent) {
  var edges = {};
  items.forEach(function (it) {
    if (it[pos] > 0 && it[pos] < extent) edges[it[pos]] = true;
    var end = it[pos] + it[size];
    if (end > 0 && end < extent) edges[end] = true;
  });
  return edges;
}

/**
 * Interleave content tracks with gap tracks (gap where a boundary exists, else 0).
 * @param {number} count - Number of content tracks.
 * @param {string} track - CSS size of a content track.
 * @param {Object<number, boolean>} edges - Boundary lines that get a gap.
 * @param {number} gap - Gap size (px).
 * @returns {string} A grid-template-* value.
 * @private
 */
function interleave(count, track, edges, gap) {
  var parts = [track];
  for (var line = 1; line < count; line++) {
    parts.push((edges[line] ? gap : 0) + 'px');
    parts.push(track);
  }
  return parts.join(' ');
}
