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
    loadShared: function (token) { return request('GET', '/api/shared/' + encodeURIComponent(token)); }
  };
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
