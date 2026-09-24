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
 * A `kind:"join"` source blends two other sources on a key (see `join.js`);
 * it is computed from its inputs on every resolve and never cached itself.
 *
 * @module dataStore
 */

import { joinData, derivedCycle, sourceAxis } from './join.js';

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
 * @param {string} [options.baseUrl=''] - Base URL of the cxd_server, used to
 *   resolve `kind:"dataset"` sources via `GET /api/datasets/{id}`.
 * @returns {DataStore} The store.
 */
export function createDataStore(options) {
  options = options || {};
  var fetchImpl = options.fetch || (typeof globalThis !== 'undefined' ? globalThis.fetch : undefined);
  var cache = options.cache || sharedCache;
  var defaultTtl = options.ttl != null ? options.ttl : 0;
  var now = options.now || function () { return Date.now(); };
  var baseUrl = options.baseUrl || '';
  var inflight = {}; // cacheKey -> Promise<data>

  /**
   * Build the cache key for a source. Connector sources key on their URL so
   * different refs pointing at the same endpoint still share one fetch.
   * @param {string} ref - The source's ref name (fallback key for inline).
   * @param {object} sourceSpec - The data source spec.
   * @returns {string} A cache key.
   */
  function keyFor(ref, sourceSpec, params) {
    if (sourceSpec && sourceSpec.kind === 'connector') {
      return 'connector:' + appendQuery(sourceSpec.url, resolvedQuery(sourceSpec, params));
    }
    if (sourceSpec && sourceSpec.kind === 'dataset') return 'dataset:' + datasetUrl(sourceSpec, params);
    return 'ref:' + ref;
  }

  /**
   * Resolve a source's `query` template against the current parameter values:
   * each `"$name"` token becomes `params[name]`, and any entry whose resolved
   * value is `null`/`undefined` is dropped (an unset param does not narrow the
   * query — this is how an "All" sentinel widens back to everything). A literal
   * (non-`$`) query value passes through unchanged.
   * @param {object} sourceSpec - The data source spec (may carry `query`).
   * @param {object} [params] - Current param values (name -> value).
   * @returns {object} Concrete query params, ready to encode.
   * @private
   */
  function resolvedQuery(sourceSpec, params) {
    var template = sourceSpec && sourceSpec.query;
    var out = {};
    if (!template) return out;
    params = params || {};
    for (var name in template) {
      if (!Object.prototype.hasOwnProperty.call(template, name)) continue;
      var token = template[name];
      var value = token;
      if (typeof token === 'string' && token.charAt(0) === '$') {
        value = params[token.slice(1)];
      }
      if (value != null) out[name] = value;
    }
    return out;
  }

  /**
   * Append a query object to a URL as a sorted, encoded query string (sorted so
   * the same params always produce the same cache key regardless of key order).
   * @param {string} url - The base URL (may already carry a query string).
   * @param {object} query - Concrete query params from {@link resolvedQuery}.
   * @returns {string} The URL with the query appended (unchanged if empty).
   * @private
   */
  function appendQuery(url, query) {
    var names = Object.keys(query || {}).sort();
    if (!names.length) return url;
    var pairs = [];
    for (var i = 0; i < names.length; i++) {
      pairs.push(encodeURIComponent(names[i]) + '=' + encodeURIComponent(query[names[i]]));
    }
    return url + (url.indexOf('?') === -1 ? '?' : '&') + pairs.join('&');
  }

  /**
   * Build the fetch URL for a stored dataset source. A source may carry an
   * explicit `url` (e.g. a signed `url_for` the server handed back); otherwise
   * it resolves to the owner-scoped `GET /api/datasets/{id}` endpoint.
   * @param {object} sourceSpec - Dataset source spec (has `id`, optional `url`).
   * @returns {string} The URL to fetch the CanvasXpress data object from.
   */
  function datasetUrl(sourceSpec, params) {
    var url;
    if (sourceSpec.url) {
      url = sourceSpec.url;
    } else {
      url = baseUrl + '/api/datasets/' + encodeURIComponent(sourceSpec.id);
      if (sourceSpec.store) url += '?store=' + encodeURIComponent(sourceSpec.store);
    }
    return appendQuery(url, resolvedQuery(sourceSpec, params));
  }

  /**
   * Fetch a cookie-authenticated URL (connector or dataset), parsing the
   * shared error/empty contract (non-2xx carries a JSON `detail`).
   * @param {string} url - The endpoint URL.
   * @param {object} [headers] - Optional extra request headers.
   * @returns {Promise<object>} The CanvasXpress data object.
   */
  function fetchUrl(url, headers) {
    if (typeof fetchImpl !== 'function') {
      return Promise.reject(new Error('no fetch available for remote data source'));
    }
    var init = { credentials: 'include' };
    if (headers) init.headers = headers;
    return fetchImpl(url, init).then(function (res) {
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
     * @param {object} sourceSpec - The data source spec (inline | connector |
     *   dataset | join).
     * @param {object} [opts] - Resolution options.
     * @param {boolean} [opts.force=false] - Bypass a fresh cache entry and refetch.
     * @param {object} [opts.params] - Current dashboard parameter values, used to
     *   resolve the source's `query` template (`$name` tokens) and to key the
     *   cache so different parameter values are distinct fetches.
     * @param {object} [opts.sources] - The spec's `data` map; a `kind:"join"`
     *   source looks its `left`/`right` refs up here.
     * @param {function} [opts.resolveInput] - `function(ref)` returning a
     *   Promise of a join input's data. The renderer passes its per-render memo
     *   so a join shares the fetch of an input panels already use. Defaults to
     *   resolving `opts.sources[ref]` through this store with the same options.
     * @returns {Promise<object>} The resolved data.
     */
    resolve: function (ref, sourceSpec, opts) {
      opts = opts || {};
      if (!sourceSpec) return Promise.reject(new Error('data source "' + ref + '" not found'));

      if (sourceSpec.kind === 'inline') {
        return Promise.resolve(sourceSpec.value);
      }
      if (sourceSpec.kind === 'join') {
        return resolveJoin(this, ref, sourceSpec, opts);
      }
      if (sourceSpec.kind === 'function') {
        return resolveFunction(this, ref, sourceSpec, opts, {
          fetch: fetchImpl, baseUrl: baseUrl, params: opts.params
        });
      }
      if (sourceSpec.kind !== 'connector' && sourceSpec.kind !== 'dataset') {
        return Promise.reject(new Error('unknown data source kind "' + sourceSpec.kind + '"'));
      }

      var key = keyFor(ref, sourceSpec, opts.params);
      var ttl = sourceSpec.ttl != null ? sourceSpec.ttl : defaultTtl;
      var url = sourceSpec.kind === 'dataset'
        ? datasetUrl(sourceSpec, opts.params)
        : appendQuery(sourceSpec.url, resolvedQuery(sourceSpec, opts.params));

      if (!opts.force) {
        var hit = cache.get(key);
        if (hit && hit.expires > now()) return Promise.resolve(hit.data);
        if (inflight[key]) return inflight[key];
      }

      var promise = fetchUrl(url, sourceSpec.headers).then(function (data) {
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
     * @param {object} [params] - Current param values (to key the entry).
     * @returns {void}
     */
    invalidate: function (ref, sourceSpec, params) {
      cache.delete(keyFor(ref, sourceSpec, params));
    }
  };
}

/**
 * Resolve a `kind:"join"` source: resolve its `left` and `right` refs (which may
 * themselves be joins), then blend them with {@link joinData}. A join is never
 * cached itself — its inputs are — so it always reflects their current data.
 * @param {DataStore} store - The store resolving the inputs.
 * @param {string} ref - The join's ref name.
 * @param {object} sourceSpec - The join spec `{left, right, on?, how?, axis?,
 *   leftAxis?, rightAxis?, suffix?}`.
 * @param {object} opts - The options passed to `resolve` (see there).
 * @returns {Promise<object>} The joined CanvasXpress data object.
 * @private
 */
function resolveJoin(store, ref, sourceSpec, opts) {
  var sources = opts.sources || {};
  var cycle = derivedCycle(ref, sources);
  if (cycle) return Promise.reject(new Error('join "' + ref + '" depends on itself (' + cycle.join(' -> ') + ')'));
  var resolveInput = opts.resolveInput || function (inputRef) {
    return store.resolve(inputRef, sources[inputRef], opts);
  };

  // Check both refs before resolving either, so a bad spec fetches nothing.
  var sides = [sourceSpec.left, sourceSpec.right];
  for (var i = 0; i < sides.length; i++) {
    if (typeof sides[i] !== 'string' || !Object.prototype.hasOwnProperty.call(sources, sides[i])) {
      return Promise.reject(new Error('join "' + ref + '" input "' + sides[i] + '" not found in spec.data'));
    }
  }

  return Promise.all([resolveInput(sourceSpec.left), resolveInput(sourceSpec.right)]).then(function (inputs) {
    return joinData(inputs[0], inputs[1], {
      on: sourceSpec.on,
      how: sourceSpec.how,
      // Each side defaults to its input source's own row axis.
      leftAxis: sourceSpec.leftAxis || sourceSpec.axis || sourceAxis(sourceSpec.left, sources),
      rightAxis: sourceSpec.rightAxis || sourceSpec.axis || sourceAxis(sourceSpec.right, sources),
      suffix: sourceSpec.suffix,
      leftName: sourceSpec.left,
      rightName: sourceSpec.right
    });
  });
}

/**
 * Resolve a `kind:"function"` source: resolve its inputs, then POST them with
 * the code to a data-function runtime (`runtime`, default the cxd_server
 * `<baseUrl>/api/functions/run`) and return the CanvasXpress data object it
 * sends back. Like a join, the result is recomputed on every resolve (its
 * inputs are cached, not it).
 *
 * Runtime contract: `POST {language, code, inputs: {name: {data, axis}},
 * params, axis}` -> `{data}` (non-2xx carries `{detail}`).
 * @param {DataStore} store - The store resolving the inputs.
 * @param {string} ref - The function's ref name.
 * @param {object} sourceSpec - `{language, code, inputs, args?, runtime?, axis?}`.
 * @param {object} opts - The options passed to `resolve`.
 * @param {object} env - `{fetch, baseUrl, params}` from the store.
 * @returns {Promise<object>} The function's result data.
 * @private
 */
function resolveFunction(store, ref, sourceSpec, opts, env) {
  var sources = opts.sources || {};
  var cycle = derivedCycle(ref, sources);
  if (cycle) return Promise.reject(new Error('function "' + ref + '" depends on itself (' + cycle.join(' -> ') + ')'));
  var inputs = sourceSpec.inputs;
  var names = [];
  var refs = [];
  if (Array.isArray(inputs)) {
    inputs.forEach(function (r) { names.push(r); refs.push(r); });
  } else if (inputs && typeof inputs === 'object') {
    Object.keys(inputs).forEach(function (name) { names.push(name); refs.push(inputs[name]); });
  }
  for (var i = 0; i < refs.length; i++) {
    if (typeof refs[i] !== 'string' || !Object.prototype.hasOwnProperty.call(sources, refs[i])) {
      return Promise.reject(new Error('function "' + ref + '" input "' + refs[i] + '" not found in spec.data'));
    }
  }
  if (typeof env.fetch !== 'function') {
    return Promise.reject(new Error('no fetch available for data function "' + ref + '"'));
  }
  var resolveInput = opts.resolveInput || function (inputRef) {
    return store.resolve(inputRef, sources[inputRef], opts);
  };
  return Promise.all(refs.map(function (r) { return resolveInput(r); })).then(function (datas) {
    var payload = { language: sourceSpec.language, code: sourceSpec.code, inputs: {}, params: {}, axis: sourceSpec.axis || 'smps' };
    names.forEach(function (name, k) {
      payload.inputs[name] = { data: datas[k], axis: sourceAxis(refs[k], sources) };
    });
    payload.params = resolveTemplate(sourceSpec.args, env.params);
    var url = sourceSpec.runtime || (env.baseUrl + '/api/functions/run');
    // Call fetch unbound: the native window.fetch throws "Illegal invocation"
    // when invoked as a method of another object.
    var doFetch = env.fetch;
    return doFetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text().then(function (text) {
        var body = parseJson(text);
        if (!res.ok) {
          throw new DataError(functionErrorMessage(res.status, body, !!sourceSpec.runtime), res.status);
        }
        if (!body || !body.data) throw new DataError('data function "' + ref + '" returned no data', res.status);
        return body.data;
      });
    });
  });
}

/**
 * A readable message for a failed data-function call. The default runtime
 * missing (a static host: 404 / 405 / 501) or an anonymous viewer (401) get an
 * explanation instead of a bare HTTP status; otherwise the runtime's `detail`.
 * @param {number} status - HTTP status.
 * @param {(object|null)} body - Parsed response body.
 * @param {boolean} customRuntime - Whether the source names its own runtime URL.
 * @returns {string} The message.
 * @private
 */
function functionErrorMessage(status, body, customRuntime) {
  if (!customRuntime && (status === 404 || status === 405 || status === 501)) {
    return 'Data functions are not available here: serve this dashboard from a ' +
      'canvasxpress-dashboards server with data functions enabled (CXD_FUNCTIONS)';
  }
  if (status === 401) return 'Sign in to run data functions';
  return body && body.detail ? body.detail : ('HTTP ' + status);
}

/**
 * Resolve a `{name: literal | "$param"}` template against parameter values
 * (an unset `$param` resolves to null — a data function sees it as missing).
 * @param {object} [template] - The template.
 * @param {object} [params] - Current parameter values.
 * @returns {object} Concrete values.
 * @private
 */
function resolveTemplate(template, params) {
  var out = {};
  params = params || {};
  for (var name in (template || {})) {
    if (!Object.prototype.hasOwnProperty.call(template, name)) continue;
    var token = template[name];
    out[name] = typeof token === 'string' && token.charAt(0) === '$'
      ? (params[token.slice(1)] == null ? null : params[token.slice(1)])
      : token;
  }
  return out;
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
  // Tabular 2D array (header row + data rows): empty without at least one data row.
  if (Array.isArray(data)) return data.length < 2;
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
