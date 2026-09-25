"""Dev launcher for the dashboards example.

Runs the ``cxd_server`` API **and** serves the example page + built bundle from
the *same origin* (so ``/api/*`` needs no CORS), and seeds a throwaway ``demo``
user with a couple of datasets so the Data view has something to show.

    python examples/serve.py        # then open the URL it prints

Nothing here is production config — it uses a fixed dev SESSION_SECRET and a
local ``examples/.cxd-demo/`` data dir (gitignored). Stop with Ctrl-C.
"""

import copy
import datetime
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server", "src"))
sys.path.insert(0, HERE)  # so `import dbservices` (the /api/<db> live services) resolves


def _load_env_file(path):
    """Load KEY=VALUE lines from a .env file (already-set env vars win) — so
    the dev launcher picks up the repo-root ``.env`` (e.g. CXD_LLM_API_KEY,
    CXD_PORT) just like the packaged ``python -m cxd_server`` does."""
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass


_load_env_file(os.path.join(ROOT, ".env"))

DATA_DIR = os.path.join(HERE, ".cxd-demo")
DATASET_DIR = os.path.join(DATA_DIR, "datasets")
DB_PATH = os.path.join(DATA_DIR, "dashboards.db")
DATASET_URI = "file://" + DATASET_DIR
os.makedirs(DATASET_DIR, exist_ok=True)

os.environ.setdefault("SESSION_SECRET", "dev-demo-secret-not-for-production")
os.environ.setdefault("APP_DB_PATH", DB_PATH)
os.environ.setdefault("CXD_DATASET_STORE", DATASET_URI)
# The app account owns the shared, locked example artifacts.
os.environ.setdefault("CXD_EXAMPLES_OWNER", "app")
# The shared scratch dashboard (owner/id) anyone signed in may edit and delete;
# _seed recreates it whenever it is missing (every restart / deploy).
SANDBOX_OWNER, SANDBOX_ID = "admin", "sandbox"
os.environ.setdefault("CXD_DISPOSABLE_DASHBOARDS", SANDBOX_OWNER + "/" + SANDBOX_ID)
# Bridge log: every request/response to the canvasxpress-mcp server, as JSONL.
os.environ.setdefault("CXD_MCP_LOG", os.path.join(DATA_DIR, "mcp-bridge.log"))

from cxd_server.app import create_dashboards_app          # noqa: E402
from cxd_server.governance import EVERYONE, open_governance  # noqa: E402
from cxd_server.datasets import DatasetStore, reshape_to_cx  # noqa: E402
from cxd_server.objectstore import open_store             # noqa: E402
from cxd_server.store import DashboardStore               # noqa: E402
from fastapi import Request                               # noqa: E402
from fastapi.staticfiles import StaticFiles               # noqa: E402

# Three seeded accounts. Passwords come from env vars (with dev defaults) so they
# can be changed without touching code — set CXD_DEMO_PASSWORD / CXD_APP_PASSWORD
# / CXD_ADMIN_PASSWORD in the repo-root .env.
#   demo  — the public visitor account (one-click demo login); owns nothing.
#   app   — owns the shipped example datasets/dashboards (locked, read-only shared
#           to everyone; survives code updates). Not meant for interactive login.
#   admin — the maintainer: an admin who can add/edit/delete the app examples via
#           the Admin view.
DEMO_USER, DEMO_PW = "demo", os.environ.get("CXD_DEMO_PASSWORD", "demo1234")
APP_USER, APP_PW = "app", os.environ.get("CXD_APP_PASSWORD", "app1234")
ADMIN_USER, ADMIN_PW = "admin", os.environ.get("CXD_ADMIN_PASSWORD", "admin1234")
EXAMPLES_OWNER = APP_USER  # keep in sync with CXD_EXAMPLES_OWNER (set below)
HOST = os.environ.get("CXD_HOST", "127.0.0.1")
PORT = int(os.environ.get("CXD_PORT", "8000"))

_SALES_CSV = (
    "Region,Q1,Q2,Q3,Q4,Segment\n"
    "North,120,135,150,160,Enterprise\n"
    "South,90,101,96,110,SMB\n"
    "East,140,150,165,180,Enterprise\n"
    "West,80,88,94,100,Consumer\n"
    "Central,110,120,118,130,SMB\n"
)
_WEATHER_CSV = (
    "City,TempC,Humidity,Rainfall,Zone\n"
    "Boston,14,66,42,Temperate\n"
    "Miami,29,74,160,Tropical\n"
    "Denver,11,40,25,Arid\n"
    "Seattle,12,80,95,Marine\n"
    "Phoenix,33,22,8,Desert\n"
)


# Larger, real-world CSVs (in examples/data/) for developing against realistic
# data. Each is a well-known public dataset with a mix of categorical columns
# (grouping/color/facet + cross-panel broadcast) and numeric measures.
DATA_DIR_CSV = os.path.join(HERE, "data")
# add_id: the CSV's first column is a real variable (species/country/carat),
# not a row identifier — prepend a sequence-number Id column so every row has
# a unique id and the first column survives as a proper annotation/measure.
_CSV_DATASETS = [
    ("penguins",   "Palmer Penguins",   "penguins.csv",   True),   # 342 rows
    ("gapminder",  "Gapminder",         "gapminder.csv",  True),   # 3,313 rows (has year)
    ("superstore", "Sample Superstore", "superstore.csv", False),  # 9,994 rows (has Row ID)
    ("diamonds",   "Diamonds",          "diamonds.csv",   True),   # 53,940 rows (scale)
]


# --- Live-from-a-database demo (SQLite) -----------------------------------
# The demo database is COMMITTED to the repo (examples/data/inventory.db —
# regenerate with examples/data/make_inventory_db.py), so every deployment
# serves identical data. The app opens it strictly READ-ONLY; the writable
# runtime state (accounts, dashboards, connectors store) stays in .cxd-demo/.
INVENTORY_DB = os.path.join(HERE, "data", "inventory.db")
# SQLAlchemy read-only SQLite URI (mode=ro blocks any write at the driver).
INVENTORY_URL = "sqlite:///file:" + INVENTORY_DB + "?mode=ro&uri=true"

# The real database behind the "Sales Live" example (examples/data/sales.db —
# regenerate with examples/data/make_sales_db.py). Opened strictly read-only.
SALES_DB = os.path.join(HERE, "data", "sales.db")


def _init_inventory_db():
    """The database ships in the repo — just check it is there."""
    if not os.path.isfile(INVENTORY_DB):
        print("  [seed] NOTE: %s missing — run examples/data/make_inventory_db.py"
              % INVENTORY_DB)


def _inventory_source():
    """The demo query as a canvasxpress-connectors SqlSource (SQLAlchemy)."""
    from cx_connectors.sources import SqlSource

    return SqlSource(
        INVENTORY_URL,
        'SELECT item AS "Item", stock AS "Stock", price AS "Price",'
        ' category AS "Category", warehouse AS "Warehouse"'
        " FROM product_inventory ORDER BY item",
    )


def _read_inventory():
    """The demo query's (header, rows) — through canvasxpress-connectors when
    installed, else a stdlib-sqlite3 fallback so the demo server always boots."""
    try:
        return _inventory_source().read()
    except ImportError:
        import sqlite3

        print("  [seed] NOTE: canvasxpress-connectors not installed in this "
              "Python — inventory demo falls back to stdlib sqlite3. "
              "(pip install 'canvasxpress-connectors[sql]')")
        conn = sqlite3.connect("file:" + INVENTORY_DB + "?mode=ro", uri=True)
        try:
            rows = conn.execute(
                "SELECT item, stock, price, category, warehouse"
                " FROM product_inventory ORDER BY item"
            ).fetchall()
        finally:
            conn.close()
        return ["Item", "Stock", "Price", "Category", "Warehouse"], [list(r) for r in rows]


def _query_inventory():
    """Run the SQL through canvasxpress-connectors: SqlSource executes the
    query and rows_to_cx reshapes the result into `{y, x}` (numeric columns
    become variables, string columns sample annotations)."""
    try:
        from cx_connectors.sources.base import to_cx

        return to_cx(_inventory_source())
    except ImportError:
        header, rows = _read_inventory()
        return [list(header)] + [list(r) for r in rows]


def _query_sales():
    """Live revenue-by-region from the sales database, as a CanvasXpress data
    object. Aggregates the sales table (opened read-only) so the "Sales Live"
    example binds to a REAL database over /api/data?source=sales — the same
    connector contract the fake-backend demo used to simulate."""
    import sqlite3

    conn = sqlite3.connect("file:" + SALES_DB + "?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT region, SUM(revenue) FROM sales GROUP BY region"
            " ORDER BY SUM(revenue) DESC"
        ).fetchall()
    finally:
        conn.close()
    regions = [r[0] for r in rows]
    revenue = [_live(r[1]) for r in rows]
    return {
        "y": {"vars": ["Revenue"], "smps": regions, "data": [revenue]},
        "x": {"Region": regions},
    }


def _sales_conn():
    """Open the sales database read-only."""
    import sqlite3

    return sqlite3.connect("file:" + SALES_DB + "?mode=ro", uri=True)


def _live(value):
    """Apply a small random delta (±15%) to a database base value, so the
    auto-refreshing Sales Live panels visibly update each poll — a simulated
    live feed layered on the (static) committed demo database."""
    import random

    return int(round(value * (0.85 + random.random() * 0.30)))


def _query_sales_share():
    """Revenue by region shaped for a single pie: regions are the VARIABLES and
    there is one sample, so CanvasXpress draws one pie with a slice per region
    (a pie is drawn per sample, sliced by variable — hence the transpose)."""
    conn = _sales_conn()
    try:
        rows = conn.execute(
            "SELECT region, SUM(revenue) FROM sales GROUP BY region"
            " ORDER BY SUM(revenue) DESC"
        ).fetchall()
    finally:
        conn.close()
    regions = [r[0] for r in rows]
    return {
        "y": {"vars": regions, "smps": ["Revenue"], "data": [[_live(r[1])] for r in rows]},
    }


def _query_sales_regions():
    """The distinct regions, as the choice list feeding the Region dropdown
    (via the control's optionsFrom annotation `region`)."""
    conn = _sales_conn()
    try:
        regions = [r[0] for r in conn.execute(
            "SELECT DISTINCT region FROM sales ORDER BY region").fetchall()]
    finally:
        conn.close()
    return {
        "y": {"vars": ["n"], "smps": regions, "data": [[1] * len(regions)]},
        "x": {"region": regions},
    }


def _query_sales_products(region, q):
    """Revenue + units per product, filtered by region (when set) and
    product-name-contains-q (when set) — the parameterized source the Live-data
    controls re-query as the Region dropdown / Search box change."""
    sql = "SELECT product, SUM(revenue), SUM(units) FROM sales WHERE 1=1"
    args = []
    if region:
        sql += " AND region = ?"
        args.append(region)
    if q:
        sql += " AND lower(product) LIKE ?"
        args.append("%" + q.lower() + "%")
    sql += " GROUP BY product ORDER BY product"
    conn = _sales_conn()
    try:
        rows = conn.execute(sql, args).fetchall()
    finally:
        conn.close()
    products = [r[0] for r in rows]
    return {
        "y": {
            "vars": ["Revenue", "Units"],
            "smps": products,
            "data": [[r[1] for r in rows], [r[2] for r in rows]],
        },
        "x": {"Product": products},
    }


def _inventory_csv():
    """The inventory query as CSV text (for seeding the dataset store)."""
    header, rows = _read_inventory()
    lines = [",".join(str(c) for c in header)]
    lines += [",".join(str(c) for c in row) for row in rows]
    return "\n".join(lines) + "\n"


def _add_row_ids(csv_text):
    """Prepend an ``Id`` sequence column (1..N) to CSV text."""
    lines = csv_text.splitlines()
    out = []
    n = 0
    for i, line in enumerate(lines):
        if not line.strip():
            continue
        if not out:
            out.append("Id," + line)
        else:
            n += 1
            out.append("%d,%s" % (n, line))
    return "\n".join(out) + "\n"


def _seed_admin_board(dashboards, datasets, gov, now, spec, prefix, label):
    """Seed an example owned by the admin and shared view-only with everyone:
    its inline tables move into the admin's dataset store, the board is saved
    under the admin, locked, and granted ``view`` to ``*``. An earlier copy
    under the examples owner (``app``) is removed. Idempotent."""
    if not spec:
        return
    board_id = spec["id"]
    if dashboards.get_summary(EXAMPLES_OWNER, board_id) is not None:
        dashboards.delete_dashboard(EXAMPLES_OWNER, board_id)      # was app-owned
        print("  [seed] moved %s from %s to %s" % (board_id, EXAMPLES_OWNER, ADMIN_USER))
    if dashboards.get_summary(ADMIN_USER, board_id) is None:
        spec = copy.deepcopy(spec)
        have = {d["id"] for d in datasets.list(ADMIN_USER)}
        for ref, source in spec.get("data", {}).items():
            if source.get("kind") != "inline":
                continue
            dataset_id = prefix + ref
            if dataset_id not in have:
                datasets.create(ADMIN_USER, source["value"], now,
                                title=label + ref, dataset_id=dataset_id, locked=True)
            spec["data"][ref] = {"kind": "dataset", "id": dataset_id, "store": "local"}
        dashboards.save_dashboard(ADMIN_USER, spec, now)
        dashboards.set_locked(ADMIN_USER, board_id, True)
        print("  [seed] shipped dashboard: %s (owner %s)" % (board_id, ADMIN_USER))
    gov.set_grant("dashboard", ADMIN_USER, board_id, EVERYONE, "view")


def _seed():
    """Create the demo user + demo datasets + shipped dashboards (idempotent)."""
    dashboards = DashboardStore(DB_PATH)
    # Three accounts (all no-ops if they already exist). Only admin is an admin;
    # the example artifacts below are owned by `app`, so demo/app logins cannot
    # delete them — only admin can. Passwords are re-applied every start so a
    # changed CXD_*_PASSWORD takes effect on restart.
    dashboards.create_user(DEMO_USER, DEMO_PW)
    dashboards.create_user(APP_USER, APP_PW)
    dashboards.create_user(ADMIN_USER, ADMIN_PW, is_admin=True)
    dashboards.set_password(DEMO_USER, DEMO_PW)
    dashboards.set_password(APP_USER, APP_PW)
    dashboards.set_password(ADMIN_USER, ADMIN_PW)
    dashboards.set_admin(ADMIN_USER, True)
    datasets = DatasetStore(open_store(DATASET_URI), store_name="local")
    have = {d["id"] for d in datasets.list(EXAMPLES_OWNER)}
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    def add(dataset_id, title, csv_text):
        if dataset_id in have:
            return
        datasets.create(EXAMPLES_OWNER, reshape_to_cx("csv", csv_text), now,
                        title=title, dataset_id=dataset_id, locked=True)

    # Small inline sets. Stable ids so the Builder's starting panels can bind
    # ({kind:"dataset", id:"regional-sales"}), keeping Builder + Data consistent.
    add("regional-sales", "Regional Sales", _SALES_CSV)
    add("weather-sample", "Weather Sample", _WEATHER_CSV)

    # The demo SQLite database backs the LIVE sources only (the per-user
    # "inventory" connector source and /api/data?source=inventory) — no
    # snapshot dataset is seeded; live supersedes frozen.
    _init_inventory_db()

    # Larger CSVs from examples/data/ (skipped gracefully if a file is absent).
    for dataset_id, title, filename, add_id in _CSV_DATASETS:
        path = os.path.join(DATA_DIR_CSV, filename)
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as handle:
                text = handle.read()
            add(dataset_id, title, _add_row_ids(text) if add_id else text)
        else:
            print("  [seed] NOTE: %s not found — skipping %s." % (path, dataset_id))

    _seed_shipped_dashboards(dashboards, datasets, have, now)


def _seed_shipped_dashboards(dashboards, datasets, have, now):
    """Ship the example dashboards inside the app: their data goes into the
    dataset store, and the specs (rewired from inline to kind:"dataset") are
    saved as demo-user dashboards, so the Dashboards view has real content."""
    import copy
    import json

    def load_spec(rel):
        path = os.path.join(HERE, rel)
        if not os.path.isfile(path):
            print("  [seed] NOTE: %s not found — skipping shipped dashboard." % path)
            return None
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)

    saved = {d["id"] for d in dashboards.list_dashboards(EXAMPLES_OWNER)}

    # Reproducible Bench: generated spec carries inline data; move each inline
    # value into the dataset store and point the spec at it.
    bench = load_spec("reproducible-bench/bench.spec.json")
    if bench and bench["id"] not in saved:
        bench = copy.deepcopy(bench)
        for ref, source in bench.get("data", {}).items():
            if source.get("kind") != "inline":
                continue
            dataset_id = "bench-" + ref
            if dataset_id not in have:
                datasets.create(EXAMPLES_OWNER, source["value"], now,
                                title="Bench: " + ref, dataset_id=dataset_id, locked=True)
            bench["data"][ref] = {"kind": "dataset", "id": dataset_id, "store": "local"}
        dashboards.save_dashboard(EXAMPLES_OWNER, bench, now)
        dashboards.set_locked(EXAMPLES_OWNER, bench["id"], True)
        print("  [seed] shipped dashboard: %s" % bench["id"])

    # KPI Overview: ring-card meters + region filter; its inline datasets move
    # into the dataset store (editable in the app) and the spec binds to them.
    kpi = load_spec("kpi-overview.spec.json")
    if kpi and kpi["id"] not in saved:
        kpi = copy.deepcopy(kpi)
        for ref, source in kpi.get("data", {}).items():
            if source.get("kind") != "inline":
                continue
            dataset_id = "kpi-" + ref
            if dataset_id not in have:
                datasets.create(EXAMPLES_OWNER, source["value"], now,
                                title="KPI: " + ref, dataset_id=dataset_id, locked=True)
            kpi["data"][ref] = {"kind": "dataset", "id": dataset_id, "store": "local"}
        dashboards.save_dashboard(EXAMPLES_OWNER, kpi, now)
        dashboards.set_locked(EXAMPLES_OWNER, kpi["id"], True)
        print("  [seed] shipped dashboard: %s" % kpi["id"])

    # Genomics Oncology Cohort: six inline scientific datasets (heatmap, three
    # DEG scatters, single-cell UMAP, cohort meter, survival) move into the
    # dataset store; the spec (three filter controls) binds to them.
    genomics = load_spec("genomics-oncology.spec.json")
    if genomics and genomics["id"] not in saved:
        genomics = copy.deepcopy(genomics)
        for ref, source in genomics.get("data", {}).items():
            if source.get("kind") != "inline":
                continue
            dataset_id = "genomics-" + ref
            if dataset_id not in have:
                datasets.create(EXAMPLES_OWNER, source["value"], now,
                                title="Genomics: " + ref, dataset_id=dataset_id, locked=True)
            genomics["data"][ref] = {"kind": "dataset", "id": dataset_id, "store": "local"}
        dashboards.save_dashboard(EXAMPLES_OWNER, genomics, now)
        dashboards.set_locked(EXAMPLES_OWNER, genomics["id"], True)
        print("  [seed] shipped dashboard: %s" % genomics["id"])

    # The two data-function showcases — Cohort Explorer (join + relationship +
    # Filters panel + an R function) and Dose-Response Lab (an R nls() fit and two
    # Python pandas summaries) — are owned by the ADMIN and shared view-only with
    # everyone. With CXD_FUNCTIONS=admin only administrators may write functions,
    # but code saved in an administrator's dashboard runs for any signed-in user,
    # so everyone sees these charts (and their "</> Code" recipe, read-only).
    gov = open_governance(dashboards, DB_PATH)
    for spec_file, prefix, label in (("cohort-explorer.spec.json", "cohort-", "Cohort: "),
                                     ("dose-response-lab.spec.json", "doselab-", "Dose-Response Lab: ")):
        _seed_admin_board(dashboards, datasets, gov, now, load_spec(spec_file), prefix, label)

    # The Sandbox: a disposable scratch dashboard anyone may edit or delete
    # (CXD_DISPOSABLE_DASHBOARDS). Recreated from examples/sandbox.spec.json
    # whenever it is missing; an existing (edited) copy is left as it is.
    sandbox = load_spec("sandbox.spec.json")
    if sandbox and dashboards.get_summary(SANDBOX_OWNER, SANDBOX_ID) is None:
        dashboards.save_dashboard(SANDBOX_OWNER, dict(sandbox, id=SANDBOX_ID), now)
        print("  [seed] recreated disposable dashboard: %s/%s" % (SANDBOX_OWNER, SANDBOX_ID))
    gov.set_grant("dashboard", SANDBOX_OWNER, SANDBOX_ID, EVERYONE, "edit")

    # Biomarker Cohort: 60-sample immuno-oncology board (two boxplots with
    # individual points, a scatter, a heatmap; Sex/Timepoint filter controls).
    # Its three inline datasets move into the dataset store.
    biomarker = load_spec("biomarker-cohort.spec.json")
    if biomarker and biomarker["id"] not in saved:
        biomarker = copy.deepcopy(biomarker)
        for ref, source in biomarker.get("data", {}).items():
            if source.get("kind") != "inline":
                continue
            dataset_id = "biomarker-" + ref
            if dataset_id not in have:
                datasets.create(EXAMPLES_OWNER, source["value"], now,
                                title="Biomarker: " + ref, dataset_id=dataset_id, locked=True)
            biomarker["data"][ref] = {"kind": "dataset", "id": dataset_id, "store": "local"}
        dashboards.save_dashboard(EXAMPLES_OWNER, biomarker, now)
        dashboards.set_locked(EXAMPLES_OWNER, biomarker["id"], True)
        print("  [seed] shipped dashboard: %s" % biomarker["id"])

    # Quality Metrics: manufacturing board (three ring meters, a per-line yield
    # trend, a stacked defects bar; Line/Shift controls). Its five inline
    # datasets move into the dataset store.
    quality = load_spec("quality-metrics.spec.json")
    if quality and quality["id"] not in saved:
        quality = copy.deepcopy(quality)
        for ref, source in quality.get("data", {}).items():
            if source.get("kind") != "inline":
                continue
            dataset_id = "quality-" + ref
            if dataset_id not in have:
                datasets.create(EXAMPLES_OWNER, source["value"], now,
                                title="Quality: " + ref, dataset_id=dataset_id, locked=True)
            quality["data"][ref] = {"kind": "dataset", "id": dataset_id, "store": "local"}
        dashboards.save_dashboard(EXAMPLES_OWNER, quality, now)
        dashboards.set_locked(EXAMPLES_OWNER, quality["id"], True)
        print("  [seed] shipped dashboard: %s" % quality["id"])

    # Sales Overview: small inline spec, shipped as-is.
    sales = load_spec("sales-overview.spec.json")
    if sales and sales["id"] not in saved:
        dashboards.save_dashboard(EXAMPLES_OWNER, sales, now)
        dashboards.set_locked(EXAMPLES_OWNER, sales["id"], True)
        print("  [seed] shipped dashboard: %s" % sales["id"])

    # HEOR — Cost-Effectiveness & Outcomes: patient records + treatment-level
    # cost-effectiveness / ICER / budget datasets move into the dataset store so
    # the board opens (and edits) in the Builder like the other examples.
    heor = load_spec("heor-overview.spec.json")
    if heor and heor["id"] not in saved:
        heor = copy.deepcopy(heor)
        for ref, source in heor.get("data", {}).items():
            if source.get("kind") != "inline":
                continue
            dataset_id = "heor-" + ref
            if dataset_id not in have:
                datasets.create(EXAMPLES_OWNER, source["value"], now,
                                title="HEOR: " + ref, dataset_id=dataset_id, locked=True)
            heor["data"][ref] = {"kind": "dataset", "id": dataset_id, "store": "local"}
        dashboards.save_dashboard(EXAMPLES_OWNER, heor, now)
        dashboards.set_locked(EXAMPLES_OWNER, heor["id"], True)
        print("  [seed] shipped dashboard: %s" % heor["id"])

    # (The old Inventory (Live SQL) shipped dashboard was retired — its
    # connector endpoint /api/data?source=inventory remains for the docs and
    # for hand-built connector dashboards.)


_seed()

# API routes first, then mount the repo so /examples/builder.html and /dist/*.js
# are served from the same origin as /api/* (route lookup tries the API first).
app = create_dashboards_app(serve_static=False)


# Serve the app (builder) directly at / — routes win over the static mount.
# builder.html loads the bundle app-root-relative ("canvasxpress-dashboards.umd.js"),
# which resolves to the _shared_bundle route below on both / and a /dashboards/ subpath.
@app.get("/", include_in_schema=False)
def _root():
    from fastapi.responses import FileResponse
    return FileResponse(os.path.join(HERE, "builder.html"), media_type="text/html")


# The read-only share viewer ships inside the cxd_server package; serve it (and
# the bundle it references relatively) so share links work under the dev server.
_PKG_STATIC = os.path.join(ROOT, "server", "src", "cxd_server", "static")


@app.get("/shared.html", include_in_schema=False)
def _shared():
    from fastapi.responses import FileResponse
    return FileResponse(os.path.join(_PKG_STATIC, "shared.html"), media_type="text/html")


# --- canvasxpress-connectors BYO-database app (bridged session) -------------
# Mounts the full per-user connectors web app at /connectors: each user
# registers named database sources (connection string + read-only SQL, stored
# ENCRYPTED) and charts them live via /connectors/api/data?source=<name>.
# The session is BRIDGED: the front-end asks /api/connectors/credentials
# (guarded by the cxd session) for a derived per-user credential and logs into
# the connectors app with it — the user signs in once, to the dashboards app.
_connectors_store = None
try:
    from cx_connectors.store import Store as _CxcStore
    from cx_connectors.store import generate_key as _cxc_generate_key
    from cx_connectors.web.byo_app import create_byo_app

    # The Fernet key encrypting stored connection strings must be stable across
    # restarts: use ENCRYPTION_KEY from the env/.env when set, else generate
    # once and persist it next to the demo data.
    _KEY_FILE = os.path.join(DATA_DIR, "encryption.key")
    if not os.environ.get("ENCRYPTION_KEY"):
        if os.path.isfile(_KEY_FILE):
            with open(_KEY_FILE, encoding="utf-8") as _fh:
                os.environ["ENCRYPTION_KEY"] = _fh.read().strip()
        else:
            os.environ["ENCRYPTION_KEY"] = _cxc_generate_key()
            with open(_KEY_FILE, "w", encoding="utf-8") as _fh:
                _fh.write(os.environ["ENCRYPTION_KEY"])

    _connectors_store = _CxcStore(os.path.join(DATA_DIR, "connectors.db"),
                                  os.environ["ENCRYPTION_KEY"])
    app.mount("/connectors", create_byo_app(store=_connectors_store, serve_static=False))
    print("  [connectors] BYO-database app mounted at /connectors")

    def _refresh_from_connector(owner, name):
        """Scheduled refresh from a user's database source, run with THEIR stored
        credentials, the same way /connectors/api/data reads it (SQL bind
        parameters are passed as NULL; SaaS sources go through their reader)."""
        from cx_connectors.reshape import rows_to_cx
        from cx_connectors.sources.sql import SqlSource, bind_param_names
        from cx_connectors.web.byo_app import _read_saas_source

        record = _connectors_store.get_source(owner, name)
        if not record:
            raise ValueError("No database source named %r" % name)
        if record.get("kind") == "packed":
            raise ValueError("Matrix sources need a gene list and cannot be refreshed on a schedule")
        if record.get("kind") in ("salesforce", "servicenow"):
            header, rows = _read_saas_source(record)
        else:
            sql = record["sql"]
            params = {n: None for n in bind_param_names(sql)}
            header, rows = SqlSource(record["conn_url"], sql, params).read()
        return rows_to_cx(header, rows)

    app.state.origin_fetchers["connector"] = _refresh_from_connector
except Exception as exc:  # noqa: BLE001 — missing extra just disables the feature
    print("  [connectors] NOTE: connectors web app not mounted (%s)" % exc)


@app.get("/api/connectors/credentials", include_in_schema=False)
def _connectors_credentials(request: "Request"):
    """Session bridge: hand the SIGNED-IN cxd user a derived credential for the
    connectors app (same username; password = HMAC(SESSION_SECRET, user), so it
    is stable, never stored, and only obtainable with a valid cxd session).
    Ensures the connectors user exists and seeds the demo inventory source."""
    import hashlib
    import hmac as _hmac

    from fastapi.responses import JSONResponse

    user = request.session.get("user")
    if not user:
        return JSONResponse({"detail": "Not logged in"}, status_code=401)
    if _connectors_store is None:
        return JSONResponse({"detail": "connectors app not available"}, status_code=503)
    password = _hmac.new(os.environ["SESSION_SECRET"].encode(),
                         ("cxc-bridge:" + user).encode(), hashlib.sha256).hexdigest()[:32]
    _connectors_store.create_user(user, password)   # no-op when it exists
    # Every bridged user starts with the demo SQLite sources registered
    # (read-only URLs into the repo-committed database).
    have_sources = _connectors_store.list_sources(user)
    if "inventory" not in have_sources:
        _connectors_store.save_source(
            user, "inventory", INVENTORY_URL,
            'SELECT item AS "Item", stock AS "Stock", price AS "Price",'
            ' category AS "Category", warehouse AS "Warehouse"'
            " FROM product_inventory ORDER BY item")
    if "furniture-only" not in have_sources:
        _connectors_store.save_source(
            user, "furniture-only", INVENTORY_URL,
            'SELECT item AS "Item", stock AS "Stock", price AS "Price",'
            ' ROUND(stock * price, 2) AS "Value", warehouse AS "Warehouse"'
            " FROM product_inventory WHERE category = 'Furniture' ORDER BY item")
    return {"username": user, "password": password}


@app.get("/api/connectors/sources-meta", include_in_schema=False)
def _connectors_sources_meta(request: Request):
    """The signed-in user's database sources with display metadata: last-saved
    timestamp and a CREDENTIAL-FREE location (dialect + host only)."""
    from urllib.parse import urlsplit

    from fastapi.responses import JSONResponse

    user = request.session.get("user")
    if not user:
        return JSONResponse({"detail": "Not logged in"}, status_code=401)
    if _connectors_store is None:
        return JSONResponse({"detail": "connectors app not available"}, status_code=503)
    out = []
    for meta in _connectors_store.list_sources_meta(user):
        record = _connectors_store.get_source(user, meta["name"])
        location = ""
        if record:
            parts = urlsplit(record["conn_url"])
            location = (parts.scheme or "").split("+")[0]
            if parts.hostname:
                location += "@" + parts.hostname
        out.append({"name": meta["name"], "updated_at": meta["updated_at"],
                    "location": location})
    return {"sources": out}


@app.get("/api/connectors/source", include_in_schema=False)
def _connectors_source_detail(request: Request, name: str = ""):
    """Owner-only read-back of one source's connection URL + SQL, so the Data
    page can prefill the edit form (the byo app itself only lists names).
    Guarded by the cxd session; a user can only read their own sources."""
    from fastapi.responses import JSONResponse

    user = request.session.get("user")
    if not user:
        return JSONResponse({"detail": "Not logged in"}, status_code=401)
    if _connectors_store is None:
        return JSONResponse({"detail": "connectors app not available"}, status_code=503)
    record = _connectors_store.get_source(user, name)
    if not record:
        return JSONResponse({"detail": "No such source"}, status_code=404)
    return {"name": name, "conn_url": record["conn_url"], "sql": record["sql"]}


@app.get("/api/data", include_in_schema=False)
def _connector_data(source: str = "", region: str = "", q: str = ""):
    """Connectors-style endpoint: run the query live and return the result as a
    CanvasXpress data object. `region`/`q` parameterize the sales-by-product
    source (the Live-data controls re-query it as those change)."""
    from fastapi.responses import JSONResponse
    # A null/empty parameter means "no filter" (the control is unset).
    region = region if region and region != "null" else None
    q = q if q and q != "null" else None
    if source == "inventory":
        return JSONResponse(_query_inventory())
    if source == "sales":
        return JSONResponse(_query_sales())
    if source == "salesShare":
        return JSONResponse(_query_sales_share())
    if source == "salesRegions":
        return JSONResponse(_query_sales_regions())
    if source == "salesProducts":
        return JSONResponse(_query_sales_products(region, q))
    return JSONResponse({"detail": "unknown source '%s'" % source}, status_code=404)


@app.get("/api/{db}", include_in_schema=False)
def _db_service(db: str, request: Request):
    """Live data services for the five database dashboards (ccle / tcga / gtex /
    gencode / wp): read the matching SQLite via examples/dbservices.py and return
    the CanvasXpress `.data` payload each panel consumes. Reached from the pages
    as the relative `../api/<db>` connector URL (so it resolves under whatever
    mount prefix the app is served at)."""
    from fastapi.responses import JSONResponse
    import dbservices
    if db not in ("ccle", "tcga", "gtex", "gencode", "wp"):
        return JSONResponse({"detail": "unknown db '%s'" % db}, status_code=404)
    qs = {k: request.query_params.getlist(k) for k in request.query_params.keys()}
    try:
        payload = dbservices.handle(db, qs)
    except Exception as exc:  # noqa: BLE001 - surface DB/query errors to the client
        return JSONResponse({"detail": str(exc)}, status_code=500)
    if payload is None:
        return JSONResponse({"detail": "no data for these params"}, status_code=404)
    return JSONResponse(payload)


@app.get("/view.html", include_in_schema=False)
def _view():
    """Full-page preview of one saved dashboard (Dashboards page's Preview)."""
    from fastapi.responses import FileResponse
    return FileResponse(os.path.join(_PKG_STATIC, "view.html"), media_type="text/html")


@app.get("/canvasxpress-dashboards.umd.js", include_in_schema=False)
def _shared_bundle():
    from fastapi.responses import FileResponse
    # Prefer the freshly built repo bundle over the packaged copy.
    return FileResponse(os.path.join(ROOT, "dist", "canvasxpress-dashboards.umd.js"),
                        media_type="text/javascript")


app.mount("/", StaticFiles(directory=ROOT, html=True), name="repo")


# Some reverse proxies (e.g. LiteSpeed's ProxyPass-in-<Location>) forward the
# public path prefix unstripped. Set CXD_MOUNT_PREFIX=/dashboards to serve the
# whole app under that prefix as well as at /.
_PREFIX = (os.getenv("CXD_MOUNT_PREFIX") or "").rstrip("/")
if _PREFIX:
    from fastapi import FastAPI as _FastAPI

    # Mounted sub-apps do not get lifespan events; hand the inner app's to the
    # wrapper so its startup work (the scheduler thread) still runs.
    _inner, app = app, _FastAPI(openapi_url=None, lifespan=app.router.lifespan_context)
    app.mount(_PREFIX, _inner)
    app.mount("/", _inner)


if __name__ == "__main__":
    import uvicorn

    url = "http://%s:%d/" % (HOST, PORT)
    print("\n  CanvasXpress Dashboards demo running:\n    %s\n" % url)
    print("  Demo login is automatic (user 'demo'). Data dir: %s\n" % DATA_DIR)
    uvicorn.run(app, host=HOST, port=PORT)
