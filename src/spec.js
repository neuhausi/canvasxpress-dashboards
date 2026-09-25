/**
 * The dashboard spec as a portable, versioned format.
 *
 *  - **Version stamp.** A spec carries `schemaVersion: "MAJOR.MINOR"` (the
 *    format version — distinct from `version`, the dashboard's own revision
 *    counter). An unstamped spec is `1.0`, the format before the stamp existed.
 *  - **Compatibility policy** (mirrors the CanvasXpress figure spec): a MINOR
 *    bump is additive — new optional keys, new source kinds / panel types — so
 *    a reader on an older MINOR renders what it understands; a MAJOR bump
 *    removes, renames or re-means something, and {@link migrateSpec} upgrades
 *    older specs on load. A spec from a newer MAJOR is refused with a clear
 *    message.
 *  - **Canonical form.** {@link serializeSpec} writes a stable JSON text (fixed
 *    top-level key order, 2-space indent, trailing newline) so specs diff
 *    cleanly in git.
 *  - **Diff.** {@link dashboardDiff} compares two specs structurally, matching
 *    layout items by panel id rather than position, with a readable summary —
 *    for reviewers, for git, and for the round-trip guarantee.
 *
 * Version history:
 *  - `1.0` — panels (graph / text / image / control), layout, inline /
 *    connector / dataset sources, params, controls.
 *  - `1.1` — `kind:"join"` and `kind:"function"` sources, source `axis`,
 *    `relationships`, `markingMode`, `type:"filters"` panels, `filterSchemes`.
 *  - `1.2` — `kind:"live"` (streaming) sources: `url`, `window`, `variables`,
 *    `initial`.
 *
 * @module spec
 */

/** @type {string} The format version this library writes. */
export var DASHBOARD_SCHEMA_VERSION = '1.2';

/** @type {string} The URL of the published JSON Schema. */
export var DASHBOARD_SCHEMA_URL = 'https://canvasxpress.org/schema/dashboard.schema.json';

/**
 * Upgrades between format versions, in order. A MINOR step is additive, so
 * its `up` only needs to exist for the version walk; a MAJOR step rewrites.
 * `up` receives a SHALLOW copy of the spec (so author-supplied functions, such
 * as panel `events`, survive) and must copy any nested object it changes.
 * @type {Array<{from: string, to: string, description: string, up: function}>}
 */
export var MIGRATIONS = [
  {
    from: '1.0',
    to: '1.1',
    description: 'Additive: join / function sources, relationships, Filters panels (no rewrite)',
    up: function (spec) { return spec; }
  },
  {
    from: '1.1',
    to: '1.2',
    description: 'Additive: live (streaming) sources (no rewrite)',
    up: function (spec) { return spec; }
  }
];

/** Canonical order of the top-level keys (unknown keys follow, in their own order). */
var TOP_LEVEL_ORDER = [
  '$schema', 'schemaVersion', 'id', 'title', 'version', 'theme', 'broadcastGroup',
  'background', 'backgroundImage', 'canvasInset', 'width', 'height', 'maxWidth',
  'layout', 'data', 'relationships', 'markingMode', 'panels', 'controls', 'params',
  'filterSchemes'
];

/**
 * Parse a `MAJOR.MINOR` version string.
 * @param {*} value - Candidate version (absent = the legacy `1.0`).
 * @returns {({major: number, minor: number}|null)} The parts, or null when malformed.
 * @public
 */
export function parseSchemaVersion(value) {
  if (value == null) return { major: 1, minor: 0 };
  var m = /^(\d+)\.(\d+)$/.exec(typeof value === 'string' ? value : '');
  return m ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) } : null;
}

/**
 * How a spec's format version relates to this library.
 * @param {object} spec - The spec.
 * @returns {{version: string, status: string}} `status` is `"current"`,
 *   `"older"` (migratable), `"newer-minor"` (renders, unknown parts skipped),
 *   `"newer-major"` (refused), or `"invalid"` (malformed stamp).
 * @public
 */
export function specCompatibility(spec) {
  var raw = spec && spec.schemaVersion;
  var parsed = parseSchemaVersion(raw);
  if (!parsed) return { version: String(raw), status: 'invalid' };
  var current = parseSchemaVersion(DASHBOARD_SCHEMA_VERSION);
  var version = parsed.major + '.' + parsed.minor;
  if (parsed.major > current.major) return { version: version, status: 'newer-major' };
  if (parsed.major < current.major || parsed.minor < current.minor) return { version: version, status: 'older' };
  if (parsed.minor > current.minor) return { version: version, status: 'newer-minor' };
  return { version: version, status: 'current' };
}

/**
 * Upgrade a spec to the current format: apply every migration from its
 * version onward and stamp `schemaVersion`. The input is not modified (the
 * result is a shallow copy; nested objects are shared unless a migration
 * rewrites them).
 * A spec from a newer MINOR is kept as is (its unknown parts are skipped at
 * render time) with a warning.
 * @param {object} spec - The spec (any supported version).
 * @returns {{spec: object, from: string, to: string, applied: string[], warnings: string[]}}
 *   The upgraded copy and what was done.
 * @throws {Error} For a malformed stamp or a newer MAJOR version.
 * @public
 */
export function migrateSpec(spec) {
  if (spec == null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('A dashboard spec must be an object');
  }
  var compat = specCompatibility(spec);
  if (compat.status === 'invalid') {
    throw new Error('spec.schemaVersion must be "MAJOR.MINOR" (got "' + compat.version + '")');
  }
  if (compat.status === 'newer-major') {
    throw new Error('This dashboard uses spec format ' + compat.version + ', which needs a newer ' +
      'canvasxpress-dashboards (this one reads ' + DASHBOARD_SCHEMA_VERSION.split('.')[0] + '.x)');
  }
  var out = {};
  for (var key in spec) {
    if (Object.prototype.hasOwnProperty.call(spec, key)) out[key] = spec[key];
  }
  var applied = [];
  var warnings = [];
  if (compat.status === 'newer-minor') {
    warnings.push('Spec format ' + compat.version + ' is newer than ' + DASHBOARD_SCHEMA_VERSION +
      '; parts this version does not know are skipped');
    return { spec: out, from: compat.version, to: compat.version, applied: applied, warnings: warnings };
  }
  var at = compat.version;
  for (var i = 0; i < MIGRATIONS.length; i++) {
    if (MIGRATIONS[i].from === at) {
      out = MIGRATIONS[i].up(out) || out;
      applied.push(MIGRATIONS[i].from + ' -> ' + MIGRATIONS[i].to);
      at = MIGRATIONS[i].to;
    }
  }
  out.schemaVersion = DASHBOARD_SCHEMA_VERSION;
  return { spec: out, from: compat.version, to: DASHBOARD_SCHEMA_VERSION, applied: applied, warnings: warnings };
}

/**
 * A copy of a spec with its top-level keys in canonical order (nested key
 * order is kept — it is authored, and some of it is meaningful).
 * @param {object} spec - The spec.
 * @returns {object} The reordered copy.
 * @public
 */
export function canonicalSpec(spec) {
  var copy = JSON.parse(JSON.stringify(spec));
  var out = {};
  TOP_LEVEL_ORDER.forEach(function (key) {
    if (Object.prototype.hasOwnProperty.call(copy, key)) out[key] = copy[key];
  });
  Object.keys(copy).forEach(function (key) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = copy[key];
  });
  return out;
}

/**
 * The canonical JSON text of a spec: canonical key order, 2-space indent,
 * trailing newline. Two specs that are equal serialize identically.
 * @param {object} spec - The spec.
 * @returns {string} JSON text.
 * @public
 */
export function serializeSpec(spec) {
  return JSON.stringify(canonicalSpec(spec), null, 2) + '\n';
}

/**
 * Structural diff of two dashboard specs. Layout items are matched by panel
 * id (`layout.items[panel=<id>]`), so reordering them is not a change.
 * @param {object} before - The original spec.
 * @param {object} after - The candidate spec.
 * @param {object} [options] - Options.
 * @param {string[]} [options.ignore=['$schema', 'schemaVersion']] - Paths to skip.
 * @returns {{added: string[], removed: string[], changed: string[], summary: string[]}}
 *   Paths that were added, removed or changed, and one readable line per change.
 * @public
 */
export function dashboardDiff(before, after, options) {
  var ignore = (options && options.ignore) || ['$schema', 'schemaVersion'];
  var result = { added: [], removed: [], changed: [], summary: [] };

  function skip(path) { return ignore.indexOf(path) !== -1; }

  function walk(a, b, path) {
    if (skip(path)) return;
    if (isPlainObject(a) && isPlainObject(b)) {
      var keys = Object.keys(a);
      Object.keys(b).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); });
      keys.forEach(function (key) {
        var child = path ? path + '.' + key : key;
        if (skip(child)) return;
        var inA = Object.prototype.hasOwnProperty.call(a, key);
        var inB = Object.prototype.hasOwnProperty.call(b, key);
        if (inA && !inB) record('removed', child, a[key], undefined);
        else if (!inA && inB) record('added', child, undefined, b[key]);
        else walk(a[key], b[key], child);
      });
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      var n = Math.max(a.length, b.length);
      for (var i = 0; i < n; i++) {
        var item = path + '[' + i + ']';
        if (i >= a.length) record('added', item, undefined, b[i]);
        else if (i >= b.length) record('removed', item, a[i], undefined);
        else walk(a[i], b[i], item);
      }
      return;
    }
    if (!sameValue(a, b)) record('changed', path, a, b);
  }

  function record(kind, path, from, to) {
    result[kind].push(path);
    var text = kind === 'added' ? 'added ' + path + ' = ' + brief(to)
      : kind === 'removed' ? 'removed ' + path + ' (was ' + brief(from) + ')'
      : 'changed ' + path + ': ' + brief(from) + ' -> ' + brief(to);
    result.summary.push(text);
  }

  walk(keyLayout(before || {}), keyLayout(after || {}), '');
  return result;
}

/**
 * Whether two specs are equal under {@link dashboardDiff}.
 * @param {object} a - One spec.
 * @param {object} b - The other spec.
 * @param {object} [options] - Passed to {@link dashboardDiff}.
 * @returns {boolean} True when there is no difference.
 * @public
 */
export function dashboardsEqual(a, b, options) {
  var d = dashboardDiff(a, b, options);
  return !d.added.length && !d.removed.length && !d.changed.length;
}

/**
 * A copy of a spec whose `layout.items` array is keyed by panel id, so the
 * diff matches items by identity rather than position.
 * @param {object} spec - The spec.
 * @returns {object} The keyed copy.
 * @private
 */
function keyLayout(spec) {
  var copy = JSON.parse(JSON.stringify(spec));
  if (copy.layout && Array.isArray(copy.layout.items)) {
    var byPanel = {};
    copy.layout.items.forEach(function (item, i) {
      var key = item && typeof item.panel === 'string' ? 'panel=' + item.panel : 'index=' + i;
      byPanel[key] = item;
    });
    copy.layout.items = byPanel;
  }
  return copy;
}

/**
 * JSON-level value equality for leaves (numbers, strings, booleans, null,
 * and a leaf that is an object on one side only).
 * @param {*} a - One value.
 * @param {*} b - The other value.
 * @returns {boolean} True when equal.
 * @private
 */
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A short printable form of a value for the summary.
 * @param {*} value - The value.
 * @returns {string} At most ~60 characters.
 * @private
 */
function brief(value) {
  var text = value === undefined ? 'undefined' : JSON.stringify(value);
  return text.length > 60 ? text.slice(0, 57) + '...' : text;
}

/**
 * Plain-object check (not an array, not null).
 * @param {*} v - Value.
 * @returns {boolean} True for a plain object.
 * @private
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
