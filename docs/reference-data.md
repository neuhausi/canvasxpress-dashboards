# Reference-database dashboards (GTEx, GENCODE, …)

The science dashboards (GTEx tissue expression, the GENCODE genome browser, and
the CCLE / TCGA / WikiPathways overviews) read large **read-only SQLite reference
databases**. Those files are far too large to ship in the package
(GENCODE ≈ 93 MB, GTEx ≈ 4.1 GB), so they are installed separately and the
serving code is **off by default**. This page is how a deployment — including an
**air-gapped** one — gets them working.

## What the server needs

| Variable | Purpose |
|---|---|
| `CXD_SQLITE_DIR` | Directory holding the `<db>.sqlite` files (default `~/Downloads/sqlite`). |
| `CXD_REFERENCE_SOURCES=on` | Register the `GET /api/<db>` services (GENCODE browser, overviews). GENCODE needs only this + the data file. |
| `CXD_CONNECTORS=on` + `ENCRYPTION_KEY` | Additionally needed for **GTEx expression** (a connector database source). |

Databases serve the moment they are present and the flag is on; a known database
with no file installed answers a clear `503`.

## Installing the data

### Air-gapped (no network egress) — hand-drop + verify

1. Copy `<db>.sqlite` into `CXD_SQLITE_DIR` (USB / your approved transfer).
2. Prove it arrived intact:
   ```
   cxd-reference-data verify gencode     # readable + has the expected tables
   cxd-reference-data status             # everything in the data dir at a glance
   ```
3. Set `CXD_REFERENCE_SOURCES=on` (and, for GTEx, `CXD_CONNECTORS=on` + `ENCRYPTION_KEY`) and restart.

### With egress — fetch

```
export CXD_REFERENCE_DATA_BASE_URL=https://canvasxpress.org/reference-data
cxd-reference-data fetch gencode        # streamed, checksum-verified, atomic
cxd-reference-data fetch gtex
```

`fetch` streams to a temp file, verifies the published `.sha256`, and only then
moves the file into place — an interrupted download never leaves a half-written
database. `CXD_REFERENCE_DATA_BASE_URL` is host-agnostic: point it anywhere the
artifacts are published.

## Docker

**Air-gapped — one self-contained image** (data baked in): see
[`Dockerfile.refdata`](../Dockerfile.refdata). You supply the `.sqlite` files in
the build context; the result is a single image to vet and run, no download at
deploy time.

**With egress — fetch on first run:**
```
ENCRYPTION_KEY=<your Fernet key> docker compose -f docker-compose.reference.yml up
```
A one-shot init container downloads the databases into a shared volume, then the
app starts with the reference services on.

## Publishing the data (becoming a distribution point)

A deployment can serve the databases it holds so another install can `fetch`
them: set `CXD_REFERENCE_DATA_SERVE=on`. It exposes
`GET /reference-data/<db>.sqlite` (+ a `.sha256` sidecar) for the **openly
redistributable** databases only — `gencode`, `gtex`, `wp`.

> **Large databases through a reverse proxy.** The app route works for
> GENCODE-sized files, but many proxies cap a *dynamic/proxied* response
> (LiteSpeed's default is ~1 GiB, which truncates GTEx at 4.1 GB). For databases
> over ~1 GiB, serve the file **statically** from your web server instead of
> through the app — e.g. symlink it into a static path and point
> `CXD_REFERENCE_DATA_BASE_URL` there (the file must be world-readable, `chmod
> o+r`) — or raise the proxy's response-size limit. canvasxpress.org publishes
> this way at `https://canvasxpress.org/reference-data` (static, no size cap,
> Range-resumable). TCGA and CCLE have
open vs controlled access tiers and are **not** published unless you have cleared
the terms and list them explicitly in `CXD_REFERENCE_DATA_PUBLISH` (comma-separated,
which overrides the default set).

## Building the databases from source

The read-only SQLite files are produced from public sources by the
`cxdb_etl` pipeline in **canvasxpress-connectors** (`python -m cxdb_etl <db>
--outdir <dir>`); GTEx v8 and GENCODE are frozen releases, so the build is
reproducible. Use this when you prefer to build rather than download (it needs
egress to the public source data).
