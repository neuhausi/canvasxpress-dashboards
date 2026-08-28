# Database-backed dashboards (live from SQLite)

Five example dashboards read real data live from SQLite databases via a
`/api/<db>` connector endpoint:

All five are **interactive explorers** with the same shape: an autocomplete
entity control that re-queries the database live.

| Dashboard page | DB | Endpoint | Pick… → panels |
|---|---|---|---|
| `ccle-explorer.html` | `ccle.sqlite` | `/api/ccle` | a **gene** → distribution by disease, heatmap, CNV/RNA correlation, mutations |
| `tcga-explorer.html` | `tcga.sqlite` | `/api/tcga` | a **gene** → expression across 33 cancer types + mutations lollipop |
| `gtex-explorer.html` | `gtex.sqlite` | `/api/gtex` | a **gene** → expression across ~54 tissues (violin + boxplot) |
| `gencode-explorer.html` | `gencode.sqlite` | `/api/gencode` | a **gene** → genome browser: transcript exon models + GWAS Catalog SNPs in the region |
| `wp-explorer.html` | `wp.sqlite` | `/api/wp` | a **human pathway** → member genes ranked by hub-ness + a table |

Each endpoint also still serves the earlier aggregate `?source=<ref>` overview
datasets (used by nothing now, but harmless).

## How it fits together

- **`dbservices.py`** — the single source of truth: turns each SQLite DB into
  the CanvasXpress `.data` payloads the panels consume. `handle(db, query)`.
- The dashboard specs use **relative** connector URLs (`"url": "../api/<db>"`),
  so they resolve correctly whether the page is served at `/examples/...`
  (standalone adapter) or `/dashboards/examples/...` (demo server).
- Two ways to serve `/api/<db>`:
  1. **Demo server** — `examples/serve.py` exposes `/api/{db}` (added alongside
     its other `/api/*` routes). Just run/restart it; the pages work under
     `/` and `/dashboards/`.
  2. **Standalone** — `examples/db-adapter.py` serves `/api/<db>` **and** the
     repo's static files, no framework needed.

## Databases

Looked up in `CXD_SQLITE_DIR` (default `~/Downloads/sqlite`) as `<db>.sqlite`;
per-DB override via `CCLE_SQLITE`, `TCGA_SQLITE`, … (opened read-only).

## Run it

Standalone:

```
CXD_SQLITE_DIR=~/Downloads/sqlite python3 examples/db-adapter.py
# open http://localhost:8899/examples/ccle-explorer.html  (or any of the five)
```

Via the demo server (restart to pick up the routes):

```
python examples/serve.py
# open http://localhost:<port>/examples/ccle-explorer.html
# (also works under /dashboards/examples/... behind a prefix proxy)
```

The CCLE explorer replaces the retired `ccleServices.pl` CGI — its panel
configs and query shapes are reproduced from that backend in `dbservices.py`.
