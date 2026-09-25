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
import { migrateSpec, serializeSpec } from './spec.js';

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
  // The canonical text (stable key order, stamped format version), so an
  // exported spec diffs cleanly in git and is self-describing.
  var json = serializeSpec(migrateSpec(spec).spec);
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
 * Parse a JSON string into a validated spec, upgraded to the current format.
 * @param {string} text - JSON text.
 * @returns {object} The validated, migrated spec.
 * @throws {Error} If the JSON is malformed, the spec is invalid, or it comes
 *   from a newer major format version.
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
  return migrateSpec(spec).spec;
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
    /**
     * Sign out. After a single sign-on session, `logout_url` ends the provider's
     * session too (navigate to it).
     * @returns {Promise<object>} `{ user: null, logout_url }`.
     */
    logout: function () { return request('POST', '/auth/logout'); },
    /**
     * How users sign in on this server (public).
     * @returns {Promise<object>} `{ password, signup, oidc: { enabled, name } }`.
     */
    authConfig: function () { return request('GET', '/auth/config'); },
    /** @returns {Promise<object>} `{ user, is_admin }` (user null when logged out). */
    me: function () { return request('GET', '/auth/me'); },

    // ---- admin: user management (requires the caller to be an admin) ----
    /** @returns {Promise<object[]>} `[{ username, is_admin, dashboards }]`. */
    listUsers: function () { return request('GET', '/api/admin/users').then(function (r) { return r.users; }); },
    /**
     * Create a user (admin — works even when public signup is disabled).
     * @param {string} username - New username (≥3 chars).
     * @param {string} password - New password (≥6 chars).
     * @returns {Promise<object>} `{ user }`.
     */
    createUser: function (username, password) {
      return request('POST', '/api/admin/users', { username: username, password: password });
    },
    /**
     * Reset a user's password.
     * @param {string} username - Target user.
     * @param {string} password - New password (≥6 chars).
     * @returns {Promise<object>} `{ user }`.
     */
    setUserPassword: function (username, password) {
      return request('POST', '/api/admin/users/' + encodeURIComponent(username) + '/password', { password: password });
    },
    /**
     * Grant or revoke a user's admin rights.
     * @param {string} username - Target user.
     * @param {boolean} isAdmin - True to grant, false to revoke.
     * @returns {Promise<object>} `{ user, is_admin }`.
     */
    setUserAdmin: function (username, isAdmin) {
      return request('POST', '/api/admin/users/' + encodeURIComponent(username) + '/admin', { is_admin: !!isAdmin });
    },
    /**
     * Delete a user and all of their dashboards.
     * @param {string} username - Target user.
     * @returns {Promise<string[]>} The remaining usernames.
     */
    deleteUser: function (username) {
      return request('DELETE', '/api/admin/users/' + encodeURIComponent(username)).then(function (r) { return r.users; });
    },

    // ---- admin: audit log (requires the caller to be an admin) ----
    /**
     * A newest-first page of audit events.
     * @param {object} [filters] - `{actor, action, target, outcome, since, until,
     *   before, limit}`; an `action` ending in "." matches as a prefix.
     * @returns {Promise<object>} `{ events, next, enabled, actions }` — pass
     *   `next` as `before` to load older events.
     */
    auditLog: function (filters) {
      return request('GET', '/api/admin/audit' + queryString(filters));
    },
    /**
     * The URL that downloads the audit log (same filters) as CSV or JSON lines.
     * @param {object} [filters] - As for {@link auditLog} (no paging).
     * @param {string} [format='csv'] - `csv` or `jsonl`.
     * @returns {string} The URL (cookie-authenticated).
     */
    auditExportUrl: function (filters, format) {
      var q = {};
      for (var k in (filters || {})) {
        if (Object.prototype.hasOwnProperty.call(filters, k) && k !== 'before' && k !== 'limit') q[k] = filters[k];
      }
      q.format = format === 'jsonl' ? 'jsonl' : 'csv';
      return baseUrl + '/api/admin/audit/export' + queryString(q);
    },
    /**
     * Re-compute the audit log's hash chain.
     * @returns {Promise<object>} `{ ok, checked, first_seq, last_seq, broken_at }`.
     */
    auditVerify: function () { return request('GET', '/api/admin/audit/verify'); },

    /**
     * The dashboards the user can open: their own, the shared examples, and
     * those shared with them (`shared: true`, `owner`, `access`, `readOnly`).
     * @returns {Promise<object[]>} Dashboard summaries.
     */
    list: function () { return request('GET', '/api/dashboards').then(function (r) { return r.dashboards; }); },
    /**
     * Save (create or update) a dashboard spec.
     * @param {object} spec - The spec to persist.
     * @param {object} [opts] - Options.
     * @param {string} [opts.owner] - Save to another owner's dashboard (needs an
     *   `edit` grant on it, or admin rights).
     * @returns {Promise<object>} The stored summary.
     */
    save: function (spec, opts) {
      var path = '/api/dashboards' + queryString({ owner: opts && opts.owner });
      return request('POST', path, spec).then(function (r) { return r.dashboard; });
    },
    /**
     * Load a dashboard by id: the user's own, else a shared example or one shared
     * with them. Stored-dataset sources of another owner's dashboard come back
     * pinned to that owner (`owner` on the source).
     * @param {string} id - Dashboard id.
     * @param {object} [opts] - Options.
     * @param {string} [opts.owner] - The owner, for a dashboard shared with the user.
     * @returns {Promise<object>} The spec.
     */
    load: function (id, opts) {
      return request('GET', '/api/dashboards/' + encodeURIComponent(id) + queryString({ owner: opts && opts.owner }));
    },
    /**
     * Delete a dashboard by id.
     * @param {string} id - Dashboard id.
     * @param {object} [opts] - `{owner}` to delete another owner's dashboard
     *   (an admin, or anyone for a disposable scratch dashboard).
     * @returns {Promise<object[]>} The remaining summaries.
     */
    remove: function (id, opts) {
      return request('DELETE', '/api/dashboards/' + encodeURIComponent(id) + queryString({ owner: opts && opts.owner }))
        .then(function (r) { return r.dashboards; });
    },
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

    // ---- sharing with users and groups, dataset security, lineage ----
    /** @returns {Promise<object>} `{ users, groups }` a resource can be shared with. */
    directory: function () { return request('GET', '/api/directory'); },
    /**
     * Who a dashboard or dataset is shared with (owner, or admin).
     * @param {('dashboard'|'dataset')} kind - Resource kind.
     * @param {string} id - Its id.
     * @param {object} [opts] - `{store, owner}` (store: datasets only).
     * @returns {Promise<object[]>} `[{ principal, level }]`.
     */
    grants: function (kind, id, opts) {
      return request('GET', resourcePath(kind, id, '/grants', opts)).then(function (r) { return r.grants; });
    },
    /**
     * Share a dashboard or dataset with a user, a group, or everyone signed in.
     * @param {('dashboard'|'dataset')} kind - Resource kind.
     * @param {string} id - Its id.
     * @param {string} principal - `user:<name>`, `group:<name>`, or `*`.
     * @param {?('view'|'edit')} level - Access level; null revokes.
     * @param {object} [opts] - `{store, owner}`.
     * @returns {Promise<object[]>} The updated grants.
     */
    setGrant: function (kind, id, principal, level, opts) {
      return request('POST', resourcePath(kind, id, '/grants', opts), { principal: principal, level: level || null })
        .then(function (r) { return r.grants; });
    },
    /**
     * A dataset's row/column security policy (owner, or admin).
     * @param {string} id - Dataset id.
     * @param {object} [opts] - `{store, owner}`.
     * @returns {Promise<?object>} `{rows, columns}` or null.
     */
    getPolicy: function (id, opts) {
      return request('GET', resourcePath('dataset', id, '/policy', opts)).then(function (r) { return r.policy; });
    },
    /**
     * Set (or with null, clear) a dataset's row/column security policy.
     * @param {string} id - Dataset id.
     * @param {?object} policy - `{rows:[{field, allow}], columns:[{hide, except}]}`.
     * @param {object} [opts] - `{store, owner}`.
     * @returns {Promise<?object>} The stored policy.
     */
    setPolicy: function (id, policy, opts) {
      return request('PUT', resourcePath('dataset', id, '/policy', opts), { policy: policy || null })
        .then(function (r) { return r.policy; });
    },
    /**
     * Lineage of the dashboards the user can open (admins: `{all: true}` for everyone's).
     * @param {object} [opts] - `{all}`.
     * @returns {Promise<object>} `{ dashboards, datasets, connectors }`.
     */
    lineage: function (opts) { return request('GET', opts && opts.all ? '/api/admin/lineage' : '/api/lineage'); },

    // ---- scheduling: dataset refresh, alerts, dashboard subscriptions ----
    /**
     * What scheduling can do on this server.
     * @returns {Promise<object>} `{ enabled, scheduler, email, snapshots, links,
     *   origins, can_create, email_address }`.
     */
    scheduleStatus: function () { return request('GET', '/api/schedules/status'); },
    /**
     * The user's schedules (admins: `{all: true}` for everyone's).
     * @param {object} [opts] - `{all}`.
     * @returns {Promise<object[]>} Schedules `{ id, owner, kind, name, cron, tz,
     *   description, config, enabled, next_run, last_run, last_status, last_message }`.
     */
    listSchedules: function (opts) {
      return request('GET', '/api/schedules' + queryString({ all: opts && opts.all ? 1 : undefined }))
        .then(function (r) { return r.schedules; });
    },
    /**
     * Create or update a schedule.
     * @param {object} schedule - `{id?, kind: 'refresh'|'alert'|'subscription', name,
     *   cron, tz, enabled, config}`.
     * @returns {Promise<object>} The stored schedule.
     */
    saveSchedule: function (schedule) {
      return request('POST', '/api/schedules', schedule).then(function (r) { return r.schedule; });
    },
    /**
     * @param {string} id - Schedule id.
     * @returns {Promise<object[]>} The user's remaining schedules.
     */
    deleteSchedule: function (id) {
      return request('DELETE', '/api/schedules/' + encodeURIComponent(id)).then(function (r) { return r.schedules; });
    },
    /**
     * Run a schedule now (its next scheduled run is unchanged).
     * @param {string} id - Schedule id.
     * @returns {Promise<object>} `{ run, schedule }`.
     */
    runSchedule: function (id) { return request('POST', '/api/schedules/' + encodeURIComponent(id) + '/run'); },
    /**
     * A schedule's recent runs, newest first.
     * @param {string} id - Schedule id.
     * @returns {Promise<object[]>} `[{ started, finished, status, message, detail, cause }]`.
     */
    scheduleRuns: function (id) {
      return request('GET', '/api/schedules/' + encodeURIComponent(id) + '/runs').then(function (r) { return r.runs; });
    },
    /**
     * Read a cron expression and list its next run times.
     * @param {string} cron - Five-field cron (or `@daily` etc.).
     * @param {string} [tz='UTC'] - IANA time zone.
     * @returns {Promise<object>} `{ description, next }` (next: ISO UTC times).
     */
    cronPreview: function (cron, tz) {
      return request('GET', '/api/cron/preview' + queryString({ cron: cron, tz: tz || 'UTC' }));
    },
    /** @returns {Promise<object>} `{ user, email, verified }`. */
    getProfile: function () { return request('GET', '/api/me/profile'); },
    /**
     * Set the address alerts and subscriptions are sent to. A new address gets
     * a confirmation link and receives nothing else until it is confirmed.
     * @param {object} profile - `{email}` (empty clears it).
     * @returns {Promise<object>} `{ user, email, verified, confirmation_sent }`.
     */
    setProfile: function (profile) { return request('PUT', '/api/me/profile', profile); },
    /**
     * Email the confirmation link for the user's address again (at most once
     * every ten minutes). Nothing is sent to an address until it is confirmed.
     * @returns {Promise<object>} `{ user, email, verified, confirmation_sent }`.
     */
    resendConfirmation: function () { return request('POST', '/api/me/profile/confirm'); },
    /**
     * Admin: set a user's email address (trusted: no confirmation needed).
     * @param {string} username - Target user.
     * @param {string} email - Address (empty clears it).
     * @returns {Promise<object>} `{ user, email }`.
     */
    setUserEmail: function (username, email) {
      return request('POST', '/api/admin/users/' + encodeURIComponent(username) + '/email', { email: email || '' });
    },

    // ---- electronic records: versions and signatures ----
    /**
     * A dashboard's saved versions, newest first, each with its signatures.
     * @param {string} id - Dashboard id.
     * @param {object} [opts] - `{owner}` for a dashboard shared with the user.
     * @returns {Promise<object>} `{ versions, meanings, can_sign, reauth }`.
     */
    versions: function (id, opts) {
      return request('GET', '/api/dashboards/' + encodeURIComponent(id) + '/versions' + queryString({ owner: opts && opts.owner }));
    },
    /**
     * One saved version's spec.
     * @param {string} id - Dashboard id.
     * @param {number} version - Version number.
     * @param {object} [opts] - `{owner}`.
     * @returns {Promise<object>} `{ version, spec }`.
     */
    version: function (id, version, opts) {
      return request('GET', '/api/dashboards/' + encodeURIComponent(id) + '/versions/' + encodeURIComponent(version) +
        queryString({ owner: opts && opts.owner }));
    },
    /**
     * Make an old version current again (it is saved as a new version).
     * @param {string} id - Dashboard id.
     * @param {number} version - Version to restore.
     * @param {object} [opts] - `{owner}`.
     * @returns {Promise<object>} `{ version }` (the new one).
     */
    restoreVersion: function (id, version, opts) {
      return request('POST', '/api/dashboards/' + encodeURIComponent(id) + '/versions/' + encodeURIComponent(version) +
        '/restore' + queryString({ owner: opts && opts.owner }));
    },
    /**
     * Electronically sign a version. Password accounts pass `password`; single
     * sign-on accounts must have signed in recently (a 401 whose message starts
     * with "reauth" means: sign in again, e.g. `/auth/oidc/login?prompt=login`).
     * @param {string} id - Dashboard id.
     * @param {object} signature - `{version, meaning, password?}`.
     * @param {object} [opts] - `{owner}`.
     * @returns {Promise<object>} `{ signature }`.
     */
    signVersion: function (id, signature, opts) {
      return request('POST', '/api/dashboards/' + encodeURIComponent(id) + '/sign' + queryString({ owner: opts && opts.owner }), signature);
    },
    /** @returns {Promise<object>} Admin: `{ ok, checked, broken_at, reason? }` for every signature. */
    verifySignatures: function () { return request('GET', '/api/admin/signatures/verify'); },

    // ---- admin: roles and groups ----
    /** @returns {Promise<object>} `{ permissions, roles, groups, assignments, default_role }`. */
    governance: function () { return request('GET', '/api/admin/governance'); },
    /**
     * Create or update a group.
     * @param {object} group - `{name, description?, members?, role?}` (members replaces the list).
     * @returns {Promise<object[]>} Every group.
     */
    saveGroup: function (group) { return request('POST', '/api/admin/groups', group).then(function (r) { return r.groups; }); },
    /**
     * @param {string} name - Group name.
     * @returns {Promise<object[]>} The remaining groups.
     */
    deleteGroup: function (name) {
      return request('DELETE', '/api/admin/groups/' + encodeURIComponent(name)).then(function (r) { return r.groups; });
    },
    /**
     * Create or update a custom role.
     * @param {object} role - `{name, permissions, description?}`.
     * @returns {Promise<object[]>} Every role.
     */
    saveRole: function (role) { return request('POST', '/api/admin/roles', role).then(function (r) { return r.roles; }); },
    /**
     * @param {string} name - Custom role name.
     * @returns {Promise<object[]>} The remaining roles.
     */
    deleteRole: function (name) {
      return request('DELETE', '/api/admin/roles/' + encodeURIComponent(name)).then(function (r) { return r.roles; });
    },
    /**
     * Assign a role to `user:<name>` or `group:<name>` (null clears it).
     * @param {string} principal - The principal.
     * @param {?string} role - Role name.
     * @returns {Promise<object>} Every assignment, `principal -> role`.
     */
    assignRole: function (principal, role) {
      return request('POST', '/api/admin/roles/assign', { principal: principal, role: role || null })
        .then(function (r) { return r.assignments; });
    },

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
     * Fetch a stored dataset's CanvasXpress data object by id (e.g. to preview
     * it as a table or bind a panel).
     * @param {string} id - Dataset id.
     * @param {object} [opts] - Options.
     * @param {string} [opts.store] - Named store the dataset lives in (defaults
     *   to the server's default dataset store).
     * @param {string} [opts.owner] - The owner, for a dataset shared with the user.
     * @returns {Promise<object>} The CanvasXpress data object `{y, x?}`.
     */
    getDataset: function (id, opts) {
      opts = opts || {};
      return request('GET', '/api/datasets/' + encodeURIComponent(id) + queryString({ store: opts.store, owner: opts.owner }));
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
     * @param {string} [opts.store] - Named target store.
     * @param {object} [opts.config] - CanvasXpress graph config to associate with
     *   the dataset (returned in its summary; panels adopt it as initial state).
     * @returns {Promise<object>} The stored summary `{id, title, rows, cols, url, config?}`.
     */
    uploadDataset: function (source, opts) {
      opts = opts || {};
      return readSource(source, opts.format).then(function (parsed) {
        var body = { format: parsed.format, data: parsed.data };
        if (opts.title) body.title = opts.title;
        if (opts.id) body.id = opts.id;
        if (opts.store) body.store = opts.store;
        if (opts.config) body.config = opts.config;   // graph config to associate
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
 * The API path of a dashboard/dataset sub-resource (`/grants`, `/policy`).
 * @param {('dashboard'|'dataset')} kind - Resource kind.
 * @param {string} id - Resource id.
 * @param {string} suffix - Sub-resource path.
 * @param {object} [opts] - `{store, owner}` query parameters.
 * @returns {string} The path.
 * @private
 */
function resourcePath(kind, id, suffix, opts) {
  opts = opts || {};
  var base = kind === 'dataset' ? '/api/datasets/' : '/api/dashboards/';
  return base + encodeURIComponent(id) + suffix +
    queryString({ store: kind === 'dataset' ? opts.store : undefined, owner: opts.owner });
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
 * Encode request parameters as a query string (empty values are skipped).
 * @param {object} [params] - name -> value.
 * @returns {string} `?a=1&b=2`, or '' when nothing is set.
 * @private
 */
function queryString(params) {
  var parts = [];
  Object.keys(params || {}).forEach(function (k) {
    var v = params[k];
    if (v !== undefined && v !== null && v !== '') parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  });
  return parts.length ? '?' + parts.join('&') : '';
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
