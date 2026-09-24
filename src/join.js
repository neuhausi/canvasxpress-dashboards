/**
 * Data blending: join two CanvasXpress data objects on a key, and map row ids
 * between related data objects (for cross-source marking).
 *
 * A dashboard `kind:"join"` source combines two other sources (inline,
 * connector, dataset, or another join) into one CanvasXpress data object, so
 * the ES5 engine stays a single-matrix consumer of the blended result.
 *
 * Each input is read as a table along a row **axis**:
 *  - `"smps"` (default): one row per sample (`y.smps`); the columns are the
 *    variables (`y.vars`) and the row annotations are `x`. This is how
 *    connectors and uploaded CSVs arrive (first column = sample ids).
 *  - `"vars"`: one row per variable (`y.vars`); the columns are the samples
 *    and the row annotations are `z`. This is the scatter orientation (genes or
 *    cells as points, `smps` = `logFC` / `UMAP1` ...).
 * The name of the axis (`"smps"` / `"vars"`) doubles as the key meaning "the
 * row id".
 *
 * Semantics follow R's `merge()` / SQL:
 *  - `how`: `"inner"` (default) keeps matched rows only, `"left"` / `"right"`
 *    also keep unmatched rows of that side, `"outer"` keeps both.
 *  - `on`: the key. The row id (default); any other string names a column or
 *    row annotation present on both sides; `{left, right}` maps differently
 *    named columns; an array of those is a composite key.
 *  - Keys compare as strings (`1` matches `"1"`); a missing key
 *    (null / undefined / "") never matches, as in SQL.
 *  - A one-to-many match emits one row per pair.
 *
 * Output layout (along the left axis): left columns first, then right columns.
 * A key column with the same name on both sides is emitted once (left value,
 * else right). Any other right column whose name is already taken gets
 * `suffix` appended (default `"." + rightName`). The row id is the left row's
 * id (or the right key value when a right-only row joins on the left row id),
 * with the right id appended (`"A|r2"`) for ids that repeat in a one-to-many
 * match. Column annotations (`z` for the smps axis, `x` for vars) follow their
 * column.
 *
 * @module join
 */

/** @type {string[]} Supported join types. */
export var JOIN_TYPES = ['inner', 'left', 'right', 'outer'];

/** @type {string[]} Supported row axes. */
export var AXES = ['smps', 'vars'];

/** @type {string} Key name meaning "the sample id" (`y.smps`) on the default axis. */
export var SAMPLE_KEY = 'smps';

/**
 * Output data object -> which input rows produced each output row.
 * @type {WeakMap<object, {axis: string, ids: string[], left: Array, right: Array}>}
 */
var provenance = new WeakMap();

/**
 * Join two CanvasXpress data objects.
 *
 * @param {object} left - Left CanvasXpress data object `{y:{vars,smps,data}, x?, z?}`.
 * @param {object} right - Right CanvasXpress data object.
 * @param {object} [options] - Join options.
 * @param {(string|object|Array)} [options.on] - Join key(s): a column name on
 *   both sides, `{left, right}` column names, or an array of those. Defaults to
 *   the row ids of both sides.
 * @param {string} [options.how='inner'] - `inner` | `left` | `right` | `outer`.
 * @param {string} [options.axis='smps'] - Row axis of both inputs.
 * @param {string} [options.leftAxis] - Row axis of the left input (overrides
 *   `axis`); also the axis of the output.
 * @param {string} [options.rightAxis] - Row axis of the right input.
 * @param {string} [options.suffix] - Appended to a clashing right column name;
 *   defaults to `"." + options.rightName`.
 * @param {string} [options.leftName='left'] - Left input name (for errors).
 * @param {string} [options.rightName='right'] - Right input name (for errors
 *   and the default suffix).
 * @returns {object} The joined CanvasXpress data object.
 * @throws {Error} When an input is not a `{y}` data object, `how` or an axis is
 *   unknown, or a key column is missing.
 * @public
 */
export function joinData(left, right, options) {
  options = options || {};
  var leftName = options.leftName || 'left';
  var rightName = options.rightName || 'right';
  var how = options.how || 'inner';
  if (JOIN_TYPES.indexOf(how) === -1) {
    throw new Error('join how must be one of ' + JOIN_TYPES.join(', ') + ' (got "' + how + '")');
  }
  var suffix = options.suffix != null ? String(options.suffix) : '.' + rightName;
  var leftTable = toTable(left, leftName, sideAxis(options, 'left'));
  var rightTable = toTable(right, rightName, sideAxis(options, 'right'));
  var keys = resolveKeys(options.on, leftTable, rightTable, leftName, rightName);

  var pairs = matchRows(leftTable, rightTable, keys, how);
  var columns = planColumns(leftTable, rightTable, keys, suffix);
  var ids = rowIds(pairs, leftTable, rightTable, keys);
  var out = buildOutput(pairs, ids, columns, leftTable, rightTable);
  provenance.set(out, {
    axis: leftTable.axis,
    ids: ids,
    left: pairs.map(function (p) { return p.l === null ? null : leftTable.ids[p.l]; }),
    right: pairs.map(function (p) { return p.r === null ? null : rightTable.ids[p.r]; })
  });
  return out;
}

/**
 * Which input rows produced each row of a {@link joinData} result.
 *
 * @param {object} joined - A data object returned by {@link joinData}.
 * @returns {({axis: string, ids: string[], left: Array, right: Array}|null)}
 *   Parallel arrays: output row id, and the left / right input row id (null
 *   for an unmatched side); or null when `joined` is not a join result.
 * @public
 */
export function joinProvenance(joined) {
  return joined && typeof joined === 'object' ? provenance.get(joined) || null : null;
}

/**
 * Map row ids of one data object to the related row ids of another: every
 * `to` row whose key matches the key of a given `from` row.
 *
 * @param {object} fromData - The data object the ids belong to.
 * @param {object} toData - The related data object.
 * @param {string[]} fromIds - Row ids of `fromData`.
 * @param {object} [options] - Relationship options.
 * @param {(string|object|Array)} [options.on] - Key(s), oriented from -> to
 *   (`{left: <from column>, right: <to column>}`); defaults to the row ids.
 * @param {string} [options.fromAxis='smps'] - Row axis of `fromData`.
 * @param {string} [options.toAxis='smps'] - Row axis of `toData`.
 * @returns {string[]} The related `to` row ids, in `to` row order.
 * @throws {Error} When an input is not a `{y}` data object or a key is missing.
 * @public
 */
export function matchIds(fromData, toData, fromIds, options) {
  options = options || {};
  var from = toTable(fromData, 'from', options.fromAxis || 'smps');
  var to = toTable(toData, 'to', options.toAxis || 'smps');
  var keys = resolveKeys(options.on, from, to, 'from', 'to');
  var fromCols = keys.map(function (k) { return k.left; });
  var toCols = keys.map(function (k) { return k.right; });
  var wanted = Object.create(null);
  (fromIds || []).forEach(function (id) { wanted[String(id)] = true; });
  var keysWanted = Object.create(null);
  for (var f = 0; f < from.rows; f++) {
    if (!(from.ids[f] in wanted)) continue;
    var fk = rowKey(from, fromCols, f);
    if (fk !== null) keysWanted[fk] = true;
  }
  var out = [];
  for (var t = 0; t < to.rows; t++) {
    var tk = rowKey(to, toCols, t);
    if (tk !== null && tk in keysWanted) out.push(to.ids[t]);
  }
  return out;
}

/**
 * Find a cycle through `kind:"join"` inputs reachable from a ref. Checked up
 * front because inputs may resolve through a caller's memo, where a cycle would
 * otherwise wait on itself forever.
 * @param {string} ref - The ref to start from.
 * @param {object} sources - The spec's `data` map.
 * @returns {(string[]|null)} The cycle path (first ref repeated last), or null.
 * @public
 */
export function joinCycle(ref, sources) {
  return derivedCycle(ref, sources);
}

/**
 * The refs a derived source reads: a join's `left` / `right`, or a data
 * function's `inputs` (an array of refs, or a `{name: ref}` map). Other kinds
 * read none.
 * @param {object} src - A data source spec.
 * @returns {string[]} Input refs.
 * @public
 */
export function sourceInputs(src) {
  if (!src || typeof src !== 'object') return [];
  if (src.kind === 'join') return [src.left, src.right];
  if (src.kind === 'function') {
    var inputs = src.inputs;
    if (Array.isArray(inputs)) return inputs.slice();
    if (inputs && typeof inputs === 'object') return Object.keys(inputs).map(function (k) { return inputs[k]; });
  }
  return [];
}

/**
 * Find a cycle through derived-source inputs (joins and data functions)
 * reachable from a ref.
 * @param {string} ref - The ref to start from.
 * @param {object} sources - The spec's `data` map.
 * @returns {(string[]|null)} The cycle path (first ref repeated last), or null.
 * @public
 */
export function derivedCycle(ref, sources) {
  var path = [];
  var done = Object.create(null);

  /**
   * Depth-first walk of join inputs.
   * @param {string} node - Current ref.
   * @returns {(string[]|null)} A cycle path, or null.
   */
  function visit(node) {
    var at = path.indexOf(node);
    if (at !== -1) return path.slice(at).concat(node);
    if (node in done) return null;
    var src = Object.prototype.hasOwnProperty.call(sources, node) ? sources[node] : null;
    var inputs = sourceInputs(src);
    if (inputs.length) {
      path.push(node);
      var found = null;
      for (var i = 0; i < inputs.length && !found; i++) found = visit(inputs[i]);
      path.pop();
      if (found) return found;
    }
    done[node] = true;
    return null;
  }
  return visit(ref);
}

/**
 * The row axis of one side of a join / relationship spec: `<side>Axis`, else
 * `axis`, else `"smps"`.
 * @param {object} spec - Options or a join / relationship spec.
 * @param {string} side - `"left"` or `"right"`.
 * @returns {string} The axis.
 * @public
 */
export function sideAxis(spec, side) {
  spec = spec || {};
  return spec[side + 'Axis'] || spec.axis || 'smps';
}

/**
 * The filterable fields of a data object read along a row axis: its numeric
 * columns (variables for the smps axis, samples for vars) and its row
 * annotations (`x` for smps, `z` for vars).
 * @param {object} data - CanvasXpress data object.
 * @param {string} [axis='smps'] - Row axis.
 * @returns {{columns: string[], annotations: string[]}} Field names.
 * @throws {Error} When `data` is not a `{y}` data object.
 * @public
 */
export function tableFields(data, axis) {
  var table = toTable(data, 'data', axis || 'smps');
  return { columns: table.cols.slice(), annotations: table.annNames.slice() };
}

/**
 * Read one field of a data object, row by row along an axis: the row ids (the
 * axis name), a numeric column, or a row annotation.
 * @param {object} data - CanvasXpress data object.
 * @param {string} axis - Row axis (`"smps"` or `"vars"`).
 * @param {string} field - Field name.
 * @returns {({ids: string[], values: Array}|null)} Parallel row ids and
 *   values, or null when the field does not exist.
 * @throws {Error} When `data` is not a `{y}` data object.
 * @public
 */
export function tableColumn(data, axis, field) {
  var table = toTable(data, 'data', axis || 'smps');
  if (!hasColumn(table, field)) return null;
  var values = [];
  for (var row = 0; row < table.rows; row++) values.push(cell(table, field, row));
  return { ids: table.ids, values: values };
}

/**
 * Swap a CanvasXpress data object's axes: samples become variables and vice
 * versa (`y.data` transposed, `x` and `z` annotations swapped). Other keys are
 * kept. The input is not modified.
 * @param {object} data - CanvasXpress data object.
 * @returns {object} The transposed copy (the input itself when it has no `y`).
 * @public
 */
export function transposeCxData(data) {
  if (!data || typeof data !== 'object' || !data.y) return data;
  var y = data.y;
  var vars = Array.isArray(y.vars) ? y.vars : [];
  var smps = Array.isArray(y.smps) ? y.smps : [];
  var matrix = Array.isArray(y.data) ? y.data : [];
  var out = {};
  for (var key in data) {
    if (Object.prototype.hasOwnProperty.call(data, key) && key !== 'y' && key !== 'x' && key !== 'z') out[key] = data[key];
  }
  out.y = {
    vars: smps.slice(),
    smps: vars.slice(),
    data: smps.map(function (s, j) {
      return vars.map(function (v, i) { return matrix[i] ? (matrix[i][j] === undefined ? null : matrix[i][j]) : null; });
    })
  };
  if (data.z) out.x = data.z;
  if (data.x) out.z = data.x;
  return out;
}

/**
 * The row axis of a named source: its own `axis` (default `"smps"`); for a
 * `kind:"join"` source, the axis of its left side (the output follows the left).
 * @param {string} ref - Source ref name.
 * @param {object} sources - The spec's `data` map.
 * @param {object} [seen] - Refs already visited (guards join cycles).
 * @returns {string} `"smps"` or `"vars"`.
 * @public
 */
export function sourceAxis(ref, sources, seen) {
  var src = sources && Object.prototype.hasOwnProperty.call(sources, ref) ? sources[ref] : null;
  if (!src) return 'smps';
  if (src.kind === 'join') {
    if (src.leftAxis || src.axis) return src.leftAxis || src.axis;
    seen = seen || Object.create(null);
    if (ref in seen) return 'smps';
    seen[ref] = true;
    return sourceAxis(src.left, sources, seen);
  }
  return src.axis || 'smps';
}

/**
 * Read a CanvasXpress data object as a table along a row axis.
 * @param {object} data - CanvasXpress data object.
 * @param {string} name - Input name (for errors).
 * @param {string} axis - `"smps"` or `"vars"`.
 * @returns {object} `{axis, ids, cols, colIndex, values, ann, annNames, colAnn, rows}`,
 *   where `values(col, row)` reads a numeric cell.
 * @private
 */
function toTable(data, name, axis) {
  if (AXES.indexOf(axis) === -1) {
    throw new Error('join axis must be "smps" or "vars" (got "' + axis + '")');
  }
  var y = data && typeof data === 'object' && !Array.isArray(data) ? data.y : null;
  if (!y || !Array.isArray(y.smps)) {
    throw new Error('join input "' + name + '" must be a CanvasXpress {y:{vars,smps,data}} object');
  }
  var x = data.x && typeof data.x === 'object' ? data.x : {};
  var z = data.z && typeof data.z === 'object' ? data.z : {};
  var vars = Array.isArray(y.vars) ? y.vars : [];
  var matrix = Array.isArray(y.data) ? y.data : [];
  var bySmps = axis === 'smps';
  var ids = bySmps ? y.smps : vars;
  var cols = bySmps ? vars : y.smps;
  var colIndex = Object.create(null);
  for (var i = 0; i < cols.length; i++) colIndex[cols[i]] = i;
  var ann = bySmps ? x : z;
  return {
    axis: axis,
    ids: ids.map(String),
    cols: cols,
    colIndex: colIndex,
    // y.data is vars x smps: a smps-axis row is a column index, a vars-axis row a row index.
    values: bySmps
      ? function (col, row) { return matrix[col] ? matrix[col][row] : undefined; }
      : function (col, row) { return matrix[row] ? matrix[row][col] : undefined; },
    ann: ann,
    annNames: Object.keys(ann),
    colAnn: bySmps ? z : x,
    rows: ids.length
  };
}

/**
 * Normalize the `on` option to `{left, right}` column pairs and check every
 * key exists. The default key is the row id of each side.
 * @param {(string|object|Array)} [on] - The user's key spec.
 * @param {object} leftTable - Left table.
 * @param {object} rightTable - Right table.
 * @param {string} leftName - Left input name (for errors).
 * @param {string} rightName - Right input name (for errors).
 * @returns {Array<{left: string, right: string}>} Key pairs.
 * @private
 */
function resolveKeys(on, leftTable, rightTable, leftName, rightName) {
  var list = on == null ? [{ left: leftTable.axis, right: rightTable.axis }] : (Array.isArray(on) ? on : [on]);
  if (!list.length) throw new Error('join on must name at least one key');
  var keys = list.map(function (key) {
    if (typeof key === 'string') return { left: key, right: key };
    if (key && typeof key === 'object' && typeof key.left === 'string' && typeof key.right === 'string') {
      return { left: key.left, right: key.right };
    }
    throw new Error('join on entries must be a column name or {left, right}');
  });
  keys.forEach(function (key) {
    assertColumn(leftTable, key.left, leftName);
    assertColumn(rightTable, key.right, rightName);
  });
  return keys;
}

/**
 * Whether a table has a column (the row id, a column, or a row annotation).
 * @param {object} table - Table from {@link toTable}.
 * @param {string} column - Column name.
 * @returns {boolean} True when present.
 * @private
 */
function hasColumn(table, column) {
  return column === table.axis || column in table.colIndex ||
    Object.prototype.hasOwnProperty.call(table.ann, column);
}

/**
 * Throw when a key column is missing from a table.
 * @param {object} table - Table from {@link toTable}.
 * @param {string} column - Key column name.
 * @param {string} name - Input name (for the error).
 * @returns {void}
 * @private
 */
function assertColumn(table, column, name) {
  if (!hasColumn(table, column)) {
    var what = table.axis === 'smps' ? 'a variable, x annotation, or "smps"' : 'a sample, z annotation, or "vars"';
    throw new Error('join key "' + column + '" not found in "' + name + '" (not ' + what + ')');
  }
}

/**
 * Read one cell of a table.
 * @param {object} table - Table from {@link toTable}.
 * @param {string} column - Column name (the row id key, a column, or a row annotation).
 * @param {number} row - Row index.
 * @returns {*} The cell value (undefined when absent).
 * @private
 */
function cell(table, column, row) {
  if (column === table.axis) return table.ids[row];
  if (column in table.colIndex) return table.values(table.colIndex[column], row);
  var annotation = table.ann[column];
  return Array.isArray(annotation) ? annotation[row] : undefined;
}

/**
 * Build the string key of a row, or null when any part is missing.
 * @param {object} table - Table from {@link toTable}.
 * @param {string[]} columns - Key columns on this side.
 * @param {number} row - Row index.
 * @returns {(string|null)} The composite key.
 * @private
 */
function rowKey(table, columns, row) {
  var parts = [];
  for (var i = 0; i < columns.length; i++) {
    var value = cell(table, columns[i], row);
    if (value == null || value === '') return null;
    parts.push(String(value));
  }
  return JSON.stringify(parts);
}

/**
 * Pair up matching rows, in the order of the driving side (right for a right
 * join, else left), then append the other side's unmatched rows for an outer
 * join.
 * @param {object} leftTable - Left table.
 * @param {object} rightTable - Right table.
 * @param {Array<{left: string, right: string}>} keys - Key pairs.
 * @param {string} how - Join type.
 * @returns {Array<{l: (number|null), r: (number|null)}>} Row index pairs.
 * @private
 */
function matchRows(leftTable, rightTable, keys, how) {
  var driveRight = how === 'right';
  var driver = driveRight ? rightTable : leftTable;
  var other = driveRight ? leftTable : rightTable;
  var driverCols = keys.map(function (k) { return driveRight ? k.right : k.left; });
  var otherCols = keys.map(function (k) { return driveRight ? k.left : k.right; });
  var keepDriver = how !== 'inner';
  var keepOther = how === 'outer';

  var index = Object.create(null);
  for (var o = 0; o < other.rows; o++) {
    var ok = rowKey(other, otherCols, o);
    if (ok === null) continue;
    (index[ok] || (index[ok] = [])).push(o);
  }

  var pairs = [];
  var otherMatched = [];
  for (var d = 0; d < driver.rows; d++) {
    var dk = rowKey(driver, driverCols, d);
    var hits = dk === null ? null : index[dk];
    if (hits && hits.length) {
      for (var h = 0; h < hits.length; h++) {
        otherMatched[hits[h]] = true;
        pairs.push(driveRight ? { l: hits[h], r: d } : { l: d, r: hits[h] });
      }
    } else if (keepDriver) {
      pairs.push(driveRight ? { l: null, r: d } : { l: d, r: null });
    }
  }
  if (keepOther) {
    for (var u = 0; u < other.rows; u++) {
      if (!otherMatched[u]) pairs.push({ l: null, r: u });
    }
  }
  return pairs;
}

/**
 * Plan the output columns: every left column / row annotation, then every
 * right one except key columns shared by name with the left (coalesced into
 * the left column), renaming right columns whose name is already taken.
 * @param {object} leftTable - Left table.
 * @param {object} rightTable - Right table.
 * @param {Array<{left: string, right: string}>} keys - Key pairs.
 * @param {string} suffix - Suffix for clashing right column names.
 * @returns {{cols: Array, ann: Array}} Column plans `{name, side, source, coalesce?}`.
 * @private
 */
function planColumns(leftTable, rightTable, keys, suffix) {
  var taken = Object.create(null);
  var cols = [];
  var ann = [];
  // Right key columns that share the left key's name fold into the left column.
  var coalesced = Object.create(null);
  keys.forEach(function (k) {
    if (k.left === k.right && k.left !== leftTable.axis && k.right !== rightTable.axis) coalesced[k.right] = true;
  });

  leftTable.cols.forEach(function (name) {
    taken[name] = true;
    cols.push({ name: name, side: 'l', source: name, coalesce: coalesced[name] === true });
  });
  leftTable.annNames.forEach(function (name) {
    taken[name] = true;
    ann.push({ name: name, side: 'l', source: name, coalesce: coalesced[name] === true });
  });

  /**
   * Pick a free output name for a right column.
   * @param {string} name - The right column name.
   * @returns {string} A name not yet taken.
   */
  function freeName(name) {
    var out = name;
    while (out in taken) out = out + suffix;
    taken[out] = true;
    return out;
  }

  rightTable.cols.forEach(function (name) {
    if (coalesced[name]) return;
    cols.push({ name: freeName(name), side: 'r', source: name });
  });
  rightTable.annNames.forEach(function (name) {
    if (coalesced[name]) return;
    ann.push({ name: freeName(name), side: 'r', source: name });
  });
  return { cols: cols, ann: ann };
}

/**
 * Compute a unique row id for every output row.
 * @param {Array<{l: (number|null), r: (number|null)}>} pairs - Row pairs.
 * @param {object} leftTable - Left table.
 * @param {object} rightTable - Right table.
 * @param {Array<{left: string, right: string}>} keys - Key pairs.
 * @returns {string[]} One id per pair.
 * @private
 */
function rowIds(pairs, leftTable, rightTable, keys) {
  // A right-only row joined on the left row id takes its key as its id, so
  // ids stay in the left's namespace.
  var rightKeyAsId = keys.length === 1 && keys[0].left === leftTable.axis ? keys[0].right : null;
  var bases = pairs.map(function (p) {
    if (p.l !== null) return leftTable.ids[p.l];
    if (rightKeyAsId !== null) return String(cell(rightTable, rightKeyAsId, p.r));
    return rightTable.ids[p.r];
  });
  var counts = Object.create(null);
  bases.forEach(function (b) { counts[b] = (counts[b] || 0) + 1; });
  var seen = Object.create(null);
  return bases.map(function (base, i) {
    var id = base;
    // A one-to-many match repeats the left id: qualify it with the right id.
    if (counts[base] > 1 && pairs[i].r !== null) id = base + '|' + rightTable.ids[pairs[i].r];
    var unique = id;
    var n = 2;
    while (unique in seen) unique = id + '#' + (n++);
    seen[unique] = true;
    return unique;
  });
}

/**
 * Read an output cell for a planned column, coalescing shared key columns.
 * @param {object} column - Column plan.
 * @param {{l: (number|null), r: (number|null)}} pair - Row pair.
 * @param {object} leftTable - Left table.
 * @param {object} rightTable - Right table.
 * @returns {*} The value, or null when absent.
 * @private
 */
function pairValue(column, pair, leftTable, rightTable) {
  var value;
  if (column.side === 'l') {
    value = pair.l === null ? undefined : cell(leftTable, column.source, pair.l);
    if (value == null && column.coalesce && pair.r !== null) value = cell(rightTable, column.source, pair.r);
  } else {
    value = pair.r === null ? undefined : cell(rightTable, column.source, pair.r);
  }
  return value == null ? null : value;
}

/**
 * Assemble the joined CanvasXpress data object along the left table's axis.
 * @param {Array<{l: (number|null), r: (number|null)}>} pairs - Row pairs.
 * @param {string[]} ids - Output row ids.
 * @param {{cols: Array, ann: Array}} columns - Column plans.
 * @param {object} leftTable - Left table.
 * @param {object} rightTable - Right table.
 * @returns {object} `{y:{vars,smps,data}, x?, z?}`.
 * @private
 */
function buildOutput(pairs, ids, columns, leftTable, rightTable) {
  var colNames = columns.cols.map(function (c) { return c.name; });
  var colValues = columns.cols.map(function (c) {
    return pairs.map(function (p) { return pairValue(c, p, leftTable, rightTable); });
  });
  var ann = null;
  if (columns.ann.length) {
    ann = {};
    columns.ann.forEach(function (c) {
      ann[c.name] = pairs.map(function (p) { return pairValue(c, p, leftTable, rightTable); });
    });
  }
  var colAnn = null;
  var colAnnNames = unionKeys(leftTable.colAnn, rightTable.colAnn);
  if (colAnnNames.length && columns.cols.length) {
    colAnn = {};
    colAnnNames.forEach(function (name) {
      colAnn[name] = columns.cols.map(function (c) {
        var table = c.side === 'l' ? leftTable : rightTable;
        var annotation = table.colAnn[name];
        var value = Array.isArray(annotation) ? annotation[table.colIndex[c.source]] : undefined;
        return value == null ? null : value;
      });
    });
  }

  var out;
  if (leftTable.axis === 'smps') {
    out = { y: { vars: colNames, smps: ids, data: colValues } };
    if (ann) out.x = ann;
    if (colAnn) out.z = colAnn;
  } else {
    // vars axis: rows are variables, so y.data is row-major (one array per id).
    out = {
      y: {
        vars: ids,
        smps: colNames,
        data: ids.map(function (id, row) { return colValues.map(function (values) { return values[row]; }); })
      }
    };
    if (ann) out.z = ann;
    if (colAnn) out.x = colAnn;
  }
  return out;
}

/**
 * Union of two objects' own keys, first object's order first.
 * @param {object} a - First object.
 * @param {object} b - Second object.
 * @returns {string[]} Distinct keys.
 * @private
 */
function unionKeys(a, b) {
  var out = Object.keys(a);
  Object.keys(b).forEach(function (k) { if (out.indexOf(k) === -1) out.push(k); });
  return out;
}
