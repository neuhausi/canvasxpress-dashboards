# Running several servers

The dashboards server (`cxd_server`) can run as several processes, on one host or
many, behind a load balancer. **Any process can serve any request**, so there is
no need for sticky sessions.

- A **session** is a signed cookie, not server memory. Any process holding the
  same `SESSION_SECRET` reads it, including single sign-on's in-flight `state`.
- **Everything else lives in the shared database:**
  - users, dashboards, sharing grants, row and column security rules;
  - roles, groups and single sign-on identities;
  - the audit log, schedules and their runs, email confirmations and limits.
- **Coordination happens in the database:**
  - The audit log's hash chain takes a table lock per write, so it stays one
    linear chain whichever process writes.
  - A due schedule is **claimed** with a conditional update before it runs, so
    exactly one process runs it.
- **Per-process state is only caches** that are safe to duplicate: connection
  pools, the identity provider's discovery document and keys, a Google Drive
  folder-id cache.

The test suite checks this on a real Postgres with two app instances sharing one
database and secret (`server/tests/test_postgres.py`). A session made on one is
used on the other; row security applies from either. Interleaved audit writes
from both keep one verified chain. A due schedule fired on both at once runs
exactly once and sends one email.

## Requirements

| Setting | Several processes, one host | Several hosts |
|---|---|---|
| `SESSION_SECRET` | the same value for all | the same value everywhere (a secrets manager, not a per-host file) |
| Dashboard store (`CXD_DASHBOARD_STORE`) | SQLite works (WAL, one file) | **Postgres**: `postgresql://user:pw@db/cxd` |
| Dataset store (`CXD_DATASET_STORE`) | local `file://` works | shared: `postgresql://…?table=cxd_objects`, `s3://bucket/prefix`, or one shared filesystem |
| `CXD_PUBLISH_BASE_URL` | the public URL | the public URL (links in emails, the single sign-on redirect) |
| Single sign-on | nothing extra | nothing extra (state rides in the signed cookie) |

Install the drivers with the extras: `pip install 'canvasxpress-dashboards-server[web,postgres,sso,llm]'` (`llm` for the natural-language builder)
(add `s3` for an S3 dataset store). `docker-compose.postgres.yml` layers a
Postgres service onto the compose stack and points both stores at it.

## The scheduler

Each process runs the scheduler thread (`CXD_SCHEDULER`, default on) and checks
for due schedules every `CXD_SCHEDULER_TICK` seconds. The claim makes each run
happen once. To keep scheduled work off the web processes, set
`CXD_SCHEDULER=off` on them and run one or two processes with it on; those may
sit behind no load balancer at all. Snapshots for emailed dashboards
(`CXD_INTERNAL_URL`) must reach a process that serves the app, usually the one
rendering them (`http://127.0.0.1:<port>`).

## Health checks

| Endpoint | Use | Answers |
|---|---|---|
| `GET /healthz` | liveness | `200 {"status": "ok", "version": …}` while the process answers; no database call |
| `GET /readyz` | readiness / load-balancer health | `200` when the dashboard store, governance, schedules, audit log and dataset store answer and, if enabled, the scheduler thread runs; otherwise `503` with the failing check named |

Neither needs a session, and neither is written to the audit log. Point the load
balancer's health check at `/readyz`, and the orchestrator's liveness probe at
`/healthz`. Under a path prefix the paths are prefixed too
(`/dashboards/readyz`).

## Upgrades

Tables are created, and new columns added, when a process starts. Changes are
additive, so a rolling upgrade (new and old processes briefly side by side) is
safe. Start one new process first, let it migrate, then replace the rest.

## Backups

All state is in the dashboard database, plus the dataset store if it is not the
same database. Back those up together. The audit log's hash chain lets you check
a restored copy: Admin → *Audit log* → **Verify chain**, or
`GET /api/admin/audit/verify`.

## Example: two processes behind nginx

```nginx
upstream cxd { server 10.0.0.11:8000; server 10.0.0.12:8000; }
server {
  listen 443 ssl;
  server_name dashboards.example.org;
  location / { proxy_pass http://cxd; proxy_set_header Host $host;
               proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $remote_addr; }
}
```

```bash
# on both hosts
SESSION_SECRET=…same-long-random-value…
CXD_DASHBOARD_STORE=postgresql://cxd:…@db.internal/cxd
CXD_DATASET_STORE=postgresql://cxd:…@db.internal/cxd?table=cxd_objects
CXD_PUBLISH_BASE_URL=https://dashboards.example.org
CXD_HTTPS_ONLY=1
python -m cxd_server --host 0.0.0.0 --port 8000
```
