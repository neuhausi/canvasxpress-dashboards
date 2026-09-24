/**
 * Cross-source marking: translate a selection made in one data source into the
 * related rows of every other source reachable through declared relationships.
 *
 * CanvasXpress already links panels that share a data source (or share row
 * names) through its page-global selector. That breaks down across sources
 * whose rows are keyed differently — e.g. expression samples `p1…` vs clinical
 * rows carrying a `patient_id` column. The dashboard declares how sources
 * relate, and this module turns "rows R of source A are marked" into "these
 * rows of source B, C… are marked".
 *
 * Relationships (edges) come from:
 *  - `spec.relationships`: `[{left, right, on?, axis?, leftAxis?, rightAxis?}]`
 *    — the same key grammar as a `kind:"join"` source, without blending.
 *  - every `kind:"join"` source: its two inputs relate through its `on`, and
 *    the join relates to each input through the recorded row provenance.
 *
 * @module marking
 */

import { matchIds, joinProvenance, sourceAxis } from './join.js';

/**
 * Whether a spec declares anything marking can translate across.
 * @param {object} spec - The dashboard spec.
 * @returns {boolean} True when there are relationships or join sources.
 * @public
 */
export function hasRelationships(spec) {
  if (spec && Array.isArray(spec.relationships) && spec.relationships.length) return true;
  var sources = (spec && spec.data) || {};
  for (var ref in sources) {
    if (Object.prototype.hasOwnProperty.call(sources, ref) && sources[ref] && sources[ref].kind === 'join') return true;
  }
  return false;
}

/**
 * Build the relationship graph of a spec.
 * @param {object} spec - The dashboard spec.
 * @returns {object} ref -> array of edges `{to, type, on?, fromAxis?, toAxis?, join?, side?}`.
 *   `type` is `"key"` (match on `on`), `"fromJoin"` (join rows -> an input's
 *   rows) or `"toJoin"` (an input's rows -> join rows).
 * @public
 */
export function relationGraph(spec) {
  var sources = (spec && spec.data) || {};
  var graph = Object.create(null);

  /**
   * Add an edge.
   * @param {string} from - Source ref.
   * @param {object} edge - Edge (carries `to`).
   * @returns {void}
   */
  function add(from, edge) {
    (graph[from] || (graph[from] = [])).push(edge);
  }

  /**
   * Add both directions of a key relationship.
   * @param {object} rel - `{left, right, on?, axis?, leftAxis?, rightAxis?}`.
   * @returns {void}
   */
  function addKeyPair(rel) {
    var leftAxis = rel.leftAxis || rel.axis || sourceAxis(rel.left, sources);
    var rightAxis = rel.rightAxis || rel.axis || sourceAxis(rel.right, sources);
    add(rel.left, { to: rel.right, type: 'key', on: rel.on, fromAxis: leftAxis, toAxis: rightAxis });
    add(rel.right, { to: rel.left, type: 'key', on: swapKeys(rel.on), fromAxis: rightAxis, toAxis: leftAxis });
  }

  ((spec && spec.relationships) || []).forEach(function (rel) {
    if (rel && typeof rel.left === 'string' && typeof rel.right === 'string') addKeyPair(rel);
  });
  Object.keys(sources).forEach(function (ref) {
    var src = sources[ref];
    if (!src || src.kind !== 'join' || typeof src.left !== 'string' || typeof src.right !== 'string') return;
    addKeyPair(src);
    ['left', 'right'].forEach(function (side) {
      add(ref, { to: src[side], type: 'fromJoin', join: ref, side: side });
      add(src[side], { to: ref, type: 'toJoin', join: ref, side: side });
    });
  });
  return graph;
}

/**
 * Translate marked row ids of one source to every related source, walking the
 * relationship graph breadth-first (the first path to reach a source wins).
 * A related source with no matching rows maps to an empty list, so the caller
 * can show it as "nothing related".
 * @param {string} originRef - The source the marking was made in.
 * @param {string[]} ids - Its marked row ids.
 * @param {object} graph - From {@link relationGraph}.
 * @param {function} dataOf - `function(ref)` -> the source's current data
 *   object, or null when not resolved (such a source cannot be traversed).
 * @returns {object} ref -> marked row ids, for every reached source except the origin.
 * @public
 */
export function translateMarks(originRef, ids, graph, dataOf) {
  var marks = {};
  var visited = Object.create(null);
  visited[originRef] = true;
  var queue = [{ ref: originRef, ids: ids }];
  while (queue.length) {
    var current = queue.shift();
    var edges = graph[current.ref] || [];
    for (var i = 0; i < edges.length; i++) {
      var edge = edges[i];
      if (edge.to in visited) continue;
      var mapped = followEdge(current.ref, current.ids, edge, dataOf);
      if (mapped === null) continue;   // unresolvable here; another path may reach it
      visited[edge.to] = true;
      marks[edge.to] = mapped;
      queue.push({ ref: edge.to, ids: mapped });
    }
  }
  return marks;
}

/**
 * Map ids across one edge.
 * @param {string} from - The ref the ids belong to.
 * @param {string[]} ids - Row ids of `from`.
 * @param {object} edge - Edge from {@link relationGraph}.
 * @param {function} dataOf - Data lookup (see {@link translateMarks}).
 * @returns {(string[]|null)} Row ids of `edge.to`, or null when a needed data
 *   object is not available (or the key does not resolve).
 * @private
 */
function followEdge(from, ids, edge, dataOf) {
  if (edge.type === 'key') {
    var fromData = dataOf(from);
    var toData = dataOf(edge.to);
    if (!fromData || !toData) return null;
    try {
      return matchIds(fromData, toData, ids, { on: edge.on, fromAxis: edge.fromAxis, toAxis: edge.toAxis });
    } catch (e) {
      return null;
    }
  }
  var prov = joinProvenance(dataOf(edge.join));
  if (!prov) return null;
  var wanted = Object.create(null);
  ids.forEach(function (id) { wanted[String(id)] = true; });
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < prov.ids.length; i++) {
    var inputId = prov[edge.side][i];
    var hit = edge.type === 'fromJoin'
      ? (prov.ids[i] in wanted ? inputId : null)
      : (inputId !== null && inputId in wanted ? prov.ids[i] : null);
    if (hit !== null && !(hit in seen)) {
      seen[hit] = true;
      out.push(hit);
    }
  }
  return out;
}

/**
 * Reverse the orientation of a join / relationship key spec.
 * @param {(string|object|Array)} [on] - Key spec oriented left -> right.
 * @returns {(string|object|Array|undefined)} The same keys oriented right -> left.
 * @private
 */
function swapKeys(on) {
  if (on == null || typeof on === 'string') return on;
  if (Array.isArray(on)) return on.map(swapKeys);
  return { left: on.right, right: on.left };
}
