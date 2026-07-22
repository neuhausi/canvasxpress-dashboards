# canvasxpress-dashboards-server

Persistence & sharing service for [`canvasxpress-dashboards`](../README.md)
specs — save, load, and share dashboards behind your own origin. Mirrors the
[`canvasxpress-connectors`](https://github.com/neuhausi/canvasxpress-connectors)
app-factory + auth model so the two run side by side under one origin.

The store is **stdlib-only** (SQLite, PBKDF2-salted passwords, per-owner
isolation); the web app adds FastAPI.

## Run

```bash
pip install -e '.[web]'
export SESSION_SECRET=$(python -c "import secrets;print(secrets.token_urlsafe(32))")
uvicorn cxd_server.app:create_dashboards_app --factory --reload
```

Environment: `SESSION_SECRET` (required), `APP_DB_PATH` (default `dashboards.db`),
`ALLOW_SIGNUP` (default `1`).

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/auth/signup` · `/auth/login` · `/auth/logout` | Session auth (cookie) |
| `GET` | `/auth/me` | Current user |
| `GET` | `/api/dashboards` | List the user's dashboards (summaries) |
| `POST` | `/api/dashboards` | Create/update a spec (keyed by `spec.id`) |
| `GET` | `/api/dashboards/{id}` | Load one of the user's specs |
| `DELETE` | `/api/dashboards/{id}` | Delete |
| `POST` | `/api/dashboards/{id}/share` | Set visibility (`public` / `auth` / `private`); returns `share_token` + `share_url` |
| `GET` | `/api/shared/{token}` | Read-only spec for a share link (public: open; `auth`: any logged-in viewer) |

The bundled read-only viewer is served at `/shared.html?token=…`.

**Isolation & permissions.** Every `/api/dashboards*` route is owner-scoped by the
session cookie. Re-saving a spec preserves its share state (a save never silently
unshares). Data still resolves through `canvasxpress-connectors` at render time
with the *viewer's* own permissions — this service only stores/serves the spec,
never credentials.

## Test

```bash
pip install -e '.[dev,web]'
pytest -q
```

## License

MIT © Isaac Neuhaus
