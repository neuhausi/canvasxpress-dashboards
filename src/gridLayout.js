/**
 * Grid geometry for dashboards. A **uniform-gap** model: the grid is `cols`
 * equal `minmax(0, 1fr)` columns and `maxRow` fixed `rowHeight` rows, with a
 * single uniform `gap` between every track (standard CSS `gap`). Consequences:
 *
 *  - two panels with the same `w` always render the SAME pixel width, and two
 *    with the same `h` the same height, regardless of where other panels sit —
 *    a panel's size no longer depends on foreign edges in other rows;
 *  - a panel spanning `w` columns measures `w` column tracks plus the `w-1`
 *    interior gaps it contains; likewise `h*rowHeight + (h-1)*gap` tall;
 *  - gutters are uniform everywhere and never appear on the outer edges (CSS
 *    `gap` only sits between tracks);
 *  - placement is a plain span from the unit coordinate, so the builder can
 *    restyle cells in place during a drag without the track template changing.
 *
 * @module gridLayout
 */

/**
 * Build the CSS grid track templates and gap for a set of layout items.
 * @param {object[]} items - Layout items (`{x, y, w, h}`).
 * @param {number} cols - Column count.
 * @param {number} rowHeight - Height of one unit row (px).
 * @param {number} gap - Uniform gutter size (px) between tracks.
 * @returns {{columns: string, rows: string, gap: string, maxRow: number}} Track
 *   templates, the CSS gap value, and the row count.
 */
export function gridTemplate(items, cols, rowHeight, gap) {
  items = items || [];
  var maxRow = 1;
  items.forEach(function (it) { maxRow = Math.max(maxRow, it.y + it.h); });

  return {
    columns: 'repeat(' + cols + ', minmax(0, 1fr))',
    rows: 'repeat(' + maxRow + ', ' + rowHeight + 'px)',
    gap: (gap || 0) + 'px',
    maxRow: maxRow
  };
}

/**
 * The `grid-column` / `grid-row` placement for one item — a plain span from the
 * unit coordinate (1-based grid lines).
 * @param {object} item - Layout item (`{x, y, w, h}`).
 * @returns {{column: string, row: string}} CSS grid placement values.
 */
export function cellArea(item) {
  return {
    column: (item.x + 1) + ' / span ' + item.w,
    row: (item.y + 1) + ' / span ' + item.h
  };
}

/**
 * Single-column (stacked) layout for narrow screens: panels in reading order
 * (by `y`, then `x`), each full-width and keeping its own height (`h` unit
 * rows), so a phone shows the dashboard top-to-bottom instead of crushing
 * `cols` tracks into the viewport.
 * @param {object[]} items - Layout items (`{panel, x, y, w, h}`).
 * @param {number} rowHeight - Height of one unit row (px).
 * @param {number} gap - Uniform gutter size (px) between tracks.
 * @returns {{columns: string, rows: string, gap: string, maxRow: number,
 *   areaByPanel: object}} One-column track templates plus each panel's
 *   `{column, row}` placement, keyed by its panel id.
 */
export function stackedTemplate(items, rowHeight, gap) {
  var sorted = (items || []).slice().sort(function (a, b) {
    return (a.y - b.y) || (a.x - b.x);
  });
  var row = 0;
  var areaByPanel = {};
  sorted.forEach(function (it) {
    var h = Math.max(1, it.h || 1);
    areaByPanel[it.panel] = { column: '1 / span 1', row: (row + 1) + ' / span ' + h };
    row += h;
  });
  return {
    columns: 'minmax(0, 1fr)',
    rows: 'repeat(' + Math.max(row, 1) + ', ' + rowHeight + 'px)',
    gap: (gap || 0) + 'px',
    maxRow: Math.max(row, 1),
    areaByPanel: areaByPanel
  };
}
