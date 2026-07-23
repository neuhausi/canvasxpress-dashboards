/**
 * Client helpers for Phase 3 persistence & sharing: export/import a spec as a
 * `.json` file, and a thin API client for the `cxd_server` endpoints
 * (`/api/dashboards`, `/api/shared/:token`). All requests send `credentials:
 * "include"` so the server's session cookie carries identity — same auth model
 * as canvasxpress-connectors.
 *
 * @module persistence
 */

import { validateSpec } from './validateSpec.js';

/**
 * Trigger a browser download of a spec as pretty-printed JSON.
 * @param {object} spec - The dashboard spec.
 * @param {string} [filename] - Download filename; defaults to `<id>.json`.
 * @param {Document} [doc] - Document to use; defaults to global.
 * @returns {void}
 */
export function exportSpec(spec, filename, doc) {
  doc = doc || document;
  var name = filename || ((spec && spec.id ? spec.id : 'dashboard') + '.json');
  var json = JSON.stringify(spec, null, 2);
  var blob = new Blob([json], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = doc.createElement('a');
  a.href = url;
  a.download = name;
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Read + parse a spec from a File (e.g. an `<input type="file">`), validating it.
 * @param {Blob} file - The file to read (File or Blob with `.text()`).
 * @returns {Promise<object>} The parsed, validated spec.
 */
export function importSpecFromFile(file) {
  return file.text().then(function (text) {
    return parseAndValidate(text);
  });
}

/**
 * Parse a JSON string into a validated spec.
 * @param {string} text - JSON text.
 * @returns {object} The validated spec.
 * @throws {Error} If the JSON is malformed or the spec is invalid.
 */
export function parseAndValidate(text) {
  var spec;
  try {
    spec = JSON.parse(text);
  } catch (e) {
    throw new Error('Not valid JSON: ' + e.message);
  }
  var result = validateSpec(spec);
  if (!result.valid) {
    throw new Error('Invalid dashboard spec:\n  - ' + result.errors.join('\n  - '));
  }
  return spec;
}

/**
 * Create a thin client for the dashboards persistence API.
 * @param {object} [options] - Client options.
 * @param {string} [options.baseUrl=''] - Base URL of the cxd_server.
 * @param {function} [options.fetch] - fetch implementation; defaults to global.
 * @returns {DashboardClient} The client.
 */
export function createDashboardClient(options) {
  options = options || {};
  var baseUrl = options.baseUrl || '';
  var fetchImpl = options.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);

  /**
   * Issue a JSON request against the API, throwing on non-2xx with the server's
   * `detail` message.
   * @param {string} method - HTTP method.
   * @param {string} path - Path under baseUrl.
   * @param {object} [body] - JSON body.
   * @returns {Promise<*>} Parsed JSON response.
   */
  function request(method, path, body) {
    if (typeof fetchImpl !== 'function') return Promise.reject(new Error('no fetch available'));
    var init = { method: method, credentials: 'include', headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetchImpl(baseUrl + path, init).then(function (res) {
      return res.text().then(function (text) {
        var payload = text ? safeParse(text) : null;
        if (!res.ok) {
          var detail = payload && payload.detail ? payload.detail : ('HTTP ' + res.status);
          var err = new Error(detail);
          err.status = res.status;
          throw err;
        }
        return payload;
      });
    });
  }

  return {
    /**
     * @param {string} username - Username.
     * @param {string} password - Password.
     * @returns {Promise<object>} `{ user }`.
     */
    login: function (username, password) {
      return request('POST', '/auth/login', { username: username, password: password });
    },
    /**
     * @param {string} username - Username.
     * @param {string} password - Password.
     * @returns {Promise<object>} `{ user }`.
     */
    signup: function (username, password) {
      return request('POST', '/auth/signup', { username: username, password: password });
    },
    /** @returns {Promise<object>} `{ user }`. */
    logout: function () { return request('POST', '/auth/logout'); },
    /** @returns {Promise<object>} `{ user }` (null when logged out). */
    me: function () { return request('GET', '/auth/me'); },

    /** @returns {Promise<object[]>} The current user's dashboard summaries. */
    list: function () { return request('GET', '/api/dashboards').then(function (r) { return r.dashboards; }); },
    /**
     * Save (create or update) a dashboard spec.
     * @param {object} spec - The spec to persist.
     * @returns {Promise<object>} The stored summary.
     */
    save: function (spec) { return request('POST', '/api/dashboards', spec).then(function (r) { return r.dashboard; }); },
    /**
     * Load one of the user's dashboards by id.
     * @param {string} id - Dashboard id.
     * @returns {Promise<object>} The spec.
     */
    load: function (id) { return request('GET', '/api/dashboards/' + encodeURIComponent(id)); },
    /**
     * Delete a dashboard by id.
     * @param {string} id - Dashboard id.
     * @returns {Promise<object[]>} The remaining summaries.
     */
    remove: function (id) { return request('DELETE', '/api/dashboards/' + encodeURIComponent(id)).then(function (r) { return r.dashboards; }); },
    /**
     * Set a dashboard's share visibility.
     * @param {string} id - Dashboard id.
     * @param {('private'|'public'|'auth')} [visibility='public'] - Visibility.
     * @returns {Promise<object>} The summary incl. `share_token`/`share_url`.
     */
    share: function (id, visibility) {
      return request('POST', '/api/dashboards/' + encodeURIComponent(id) + '/share', { visibility: visibility || 'public' })
        .then(function (r) { return r.dashboard; });
    },
    /**
     * Resolve a share token to its read-only spec.
     * @param {string} token - Share token.
     * @returns {Promise<object>} `{ spec, readOnly, owner }`.
     */
    loadShared: function (token) { return request('GET', '/api/shared/' + encodeURIComponent(token)); },

    /**
     * List the server-configured named stores the user may target (names only,
     * never URIs/credentials) — the source of truth for the store picker.
     * @param {('dataset'|'dashboard')} [capability] - Filter by capability.
     * @returns {Promise<object[]>} `[{name, capability, default}]`.
     */
    listStores: function (capability) {
      var path = '/api/stores' + (capability ? '?capability=' + encodeURIComponent(capability) : '');
      return request('GET', path).then(function (r) { return r.stores; });
    },
    /** @returns {Promise<object[]>} The current user's dataset summaries (across all stores). */
    listDatasets: function () {
      return request('GET', '/api/datasets').then(function (r) { return r.datasets; });
    },
    /**
     * Upload a dataset (CSV/JSON), reshaped and stored server-side; bind a panel
     * to the returned id via `{kind:"dataset", id}`.
     * @param {(Blob|string|object)} source - A File/Blob, raw text, or an object.
     * @param {object} [opts] - Upload options.
     * @param {('csv'|'json'|'cx')} [opts.format] - Input format; inferred from a
     *   File's name/type when omitted (defaults to `json`).
     * @param {string} [opts.title] - Human title (seeds the generated id).
     * @param {string} [opts.id] - Explicit id (overwrites in place).
     * @param {string} [opts.store] - Named target store (Phase 5.2; reserved).
     * @returns {Promise<object>} The stored summary `{id, title, rows, cols, url}`.
     */
    uploadDataset: function (source, opts) {
      opts = opts || {};
      return readSource(source, opts.format).then(function (parsed) {
        var body = { format: parsed.format, data: parsed.data };
        if (opts.title) body.title = opts.title;
        if (opts.id) body.id = opts.id;
        if (opts.store) body.store = opts.store;
        return request('POST', '/api/datasets', body).then(function (r) { return r.dataset; });
      });
    },
    /**
     * Delete a dataset by id.
     * @param {string} id - Dataset id.
     * @param {object} [opts] - Delete options.
     * @param {string} [opts.store] - Named store the dataset lives in (defaults
     *   to the server's default dataset store).
     * @returns {Promise<object[]>} The remaining dataset summaries.
     */
    deleteDataset: function (id, opts) {
      opts = opts || {};
      var path = '/api/datasets/' + encodeURIComponent(id);
      if (opts.store) path += '?store=' + encodeURIComponent(opts.store);
      return request('DELETE', path).then(function (r) { return r.datasets; });
    }
  };
}

/**
 * Normalize a dataset upload source to `{format, data}` for the API.
 * A Blob/File is read as text and its format inferred from name/type; a string
 * is passed through as the given (or `json`) format; a plain object is sent as
 * `cx`/`json` data directly.
 * @param {(Blob|string|object)} source - The upload source.
 * @param {string} [format] - Explicit format override.
 * @returns {Promise<{format: string, data: *}>} Normalized payload.
 * @private
 */
function readSource(source, format) {
  if (source && typeof source.text === 'function') {
    var fmt = format || inferFormat(source.name, source.type);
    return source.text().then(function (text) { return { format: fmt, data: text }; });
  }
  if (typeof source === 'string') {
    return Promise.resolve({ format: format || 'json', data: source });
  }
  return Promise.resolve({ format: format || 'cx', data: source });
}

/**
 * Infer an upload format from a filename/MIME type.
 * @param {string} [name] - Filename.
 * @param {string} [type] - MIME type.
 * @returns {('csv'|'json')} The inferred format.
 * @private
 */
function inferFormat(name, type) {
  var n = (name || '').toLowerCase();
  if (n.slice(-4) === '.csv' || (type || '').indexOf('csv') !== -1) return 'csv';
  return 'json';
}

/**
 * JSON.parse that returns null instead of throwing.
 * @param {string} text - JSON text.
 * @returns {(object|null)} Parsed value or null.
 * @private
 */
function safeParse(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}
