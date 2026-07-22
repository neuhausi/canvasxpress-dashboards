/**
 * Data resolution for dashboards: inline values and authenticated
 * `canvasxpress-connectors` endpoints, with per-source caching, in-flight
 * request de-duplication, and TTL.
 *
 * Phase 2 goals this module delivers:
 *  - `kind: "connector"` sources fetch from a connectors endpoint (cookie-auth;
 *    no credentials in the browser — the session cookie carries identity).
 *  - Panels that share a `dataRef` (or any two sources with the same cache key)
 *    issue a single request; a cache hit avoids re-querying the backend.
 *  - A refresh/TTL story so a dashboard can serve panels from cache and refetch
 *    on an interval.
 *
 * The connectors contract (`GET /api/data?source=<name>`) returns a CanvasXpress
 * data object `{ y: { vars, smps, data }, x? }`, and non-2xx responses carry a
 * JSON `{ detail }` message. See canvasxpress-connectors `web/byo_app.py`.
 *
 * @module dataStore
 */

/**
 * A process-wide default cache shared across `renderDashboard` calls, so two
 * dashboards (or a re-render) hitting the same connector source reuse one fetch.
 * @type {Map<string, {expires: number, data: object}>}
 */
var sharedCache = new Map();

/**
 * Create a data store.
 *
 * @param {object} [options] - Store options.
 * @param {function} [options.fetch] - fetch implementation; defaults to global.
 * @param {Map} [options.cache] - Cache map to use; defaults to a shared module
 *   cache. Pass a fresh `new Map()` to isolate a dashboard.
 * @param {number} [options.ttl=0] - Default cache lifetime in ms for connector
 *   sources without their own `ttl`. `0` disables cross-call caching (each new
 *   render refetches) while still de-duplicating concurrent in-flight requests.
 * @param {function} [options.now] - Clock returning ms; defaults to Date.now
 *   (injectable for tests).
 * @returns {DataStore} The store.
 */
export function createDataStore(options) {
  options = options || {};
  var fetchImpl = options.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
  var cache = options.cache || sharedCache;
  var defaultTtl = options.ttl != null ? options.ttl : 0;
  var now = options.now || function () { return Date.now(); };
  var inflight = {}; // cacheKey -> Promise<data>

  /**
   * Build the cache key for a source. Connector sources key on their URL so
   * different refs pointing at the same endpoint still share one fetch.
   * @param {string} ref - The source's ref name (fallback key for inline).
   * @param {object} sourceSpec - The data source spec.
   * @returns {string} A cache key.
   */
  function keyFor(ref, sourceSpec) {
    if (sourceSpec && sourceSpec.kind === 'connector') return 'connector:' + sourceSpec.url;
    return 'ref:' + ref;
  }

  /**
   * Fetch a connector source, parsing the connectors error/empty contract.
   * @param {object} sourceSpec - Connector source spec (has `url`).
   * @returns {Promise<object>} The CanvasXpress data object.
   */
  function fetchConnector(sourceSpec) {
    if (typeof fetchImpl !== 'function') {
      return Promise.reject(new Error('no fetch available for connector source'));
    }
    var init = { credentials: 'include' };
    if (sourceSpec.headers) init.headers = sourceSpec.headers;
    return fetchImpl(sourceSpec.url, init).then(function (res) {
      return res.text().then(function (text) {
        var payload = parseJson(text);
        if (!res.ok) {
          var detail = payload && payload.detail ? payload.detail : ('HTTP ' + res.status);
          throw new DataError(detail, res.status);
        }
        return payload;
      });
    });
  }

  return {
    cache: cache,

    /**
     * Resolve a data source to a CanvasXpress data object.
     * @param {string} ref - The source ref name (for cache keying/errors).
     * @param {object} sourceSpec - The data source spec (inline | connector).
     * @param {object} [opts] - Resolution options.
     * @param {boolean} [opts.force=false] - Bypass a fresh cache entry and refetch.
     * @returns {Promise<object>} The resolved data.
     */
    resolve: function (ref, sourceSpec, opts) {
      opts = opts || {};
      if (!sourceSpec) return Promise.reject(new Error('data source "' + ref + '" not found'));

      if (sourceSpec.kind === 'inline') {
        return Promise.resolve(sourceSpec.value);
      }
      if (sourceSpec.kind !== 'connector') {
        return Promise.reject(new Error('unknown data source kind "' + sourceSpec.kind + '"'));
      }

      var key = keyFor(ref, sourceSpec);
      var ttl = sourceSpec.ttl != null ? sourceSpec.ttl : defaultTtl;

      if (!opts.force) {
        var hit = cache.get(key);
        if (hit && hit.expires > now()) return Promise.resolve(hit.data);
        if (inflight[key]) return inflight[key];
      }

      var promise = fetchConnector(sourceSpec).then(function (data) {
        if (ttl > 0) cache.set(key, { expires: now() + ttl, data: data });
        delete inflight[key];
        return data;
      }, function (err) {
        delete inflight[key];
        throw err;
      });

      inflight[key] = promise;
      return promise;
    },

    /**
     * Invalidate a cached source (used before a scheduled refresh).
     * @param {string} ref - The source ref name.
     * @param {object} sourceSpec - The data source spec.
     * @returns {void}
     */
    invalidate: function (ref, sourceSpec) {
      cache.delete(keyFor(ref, sourceSpec));
    }
  };
}

/**
 * An error carrying the connector HTTP status alongside the message.
 */
export class DataError extends Error {
  /**
   * @param {string} message - Human-readable message (connectors `detail`).
   * @param {number} [status] - HTTP status code.
   */
  constructor(message, status) {
    super(message);
    this.name = 'DataError';
    this.status = status;
  }
}

/**
 * Determine whether a resolved CanvasXpress data object has no rows.
 * @param {object} data - A CanvasXpress data object.
 * @returns {boolean} True when there is nothing to plot.
 */
export function isEmptyData(data) {
  if (!data || typeof data !== 'object') return true;
  var y = data.y;
  if (!y) {
    // Non-{y} shapes (e.g. network/genome) — treat as non-empty; let CX decide.
    return false;
  }
  var hasSamples = Array.isArray(y.smps) && y.smps.length > 0;
  var hasVars = Array.isArray(y.vars) && y.vars.length > 0;
  var hasData = Array.isArray(y.data) && y.data.length > 0;
  return !(hasSamples && hasVars && hasData);
}

/**
 * Parse JSON, tolerating an empty/non-JSON body (returns null).
 * @param {string} text - Response body text.
 * @returns {(object|null)} Parsed value or null.
 * @private
 */
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/**
 * Clear the process-wide shared cache (test/maintenance hook).
 * @returns {void}
 */
export function clearSharedCache() {
  sharedCache.clear();
}
