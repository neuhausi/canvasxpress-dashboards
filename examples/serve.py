"""Dev launcher for the dashboards example.

Runs the ``cxd_server`` API **and** serves the example page + built bundle from
the *same origin* (so ``/api/*`` needs no CORS), and seeds a throwaway ``demo``
user with a couple of datasets so the Data view has something to show.

    python examples/serve.py        # then open the URL it prints

Nothing here is production config — it uses a fixed dev SESSION_SECRET and a
local ``examples/.cxd-demo/`` data dir (gitignored). Stop with Ctrl-C.
"""

import datetime
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server", "src"))

DATA_DIR = os.path.join(HERE, ".cxd-demo")
DATASET_DIR = os.path.join(DATA_DIR, "datasets")
DB_PATH = os.path.join(DATA_DIR, "dashboards.db")
DATASET_URI = "file://" + DATASET_DIR
os.makedirs(DATASET_DIR, exist_ok=True)

os.environ.setdefault("SESSION_SECRET", "dev-demo-secret-not-for-production")
os.environ.setdefault("APP_DB_PATH", DB_PATH)
os.environ.setdefault("CXD_DATASET_STORE", DATASET_URI)
# Bridge log: every request/response to the canvasxpress-mcp server, as JSONL.
os.environ.setdefault("CXD_MCP_LOG", os.path.join(DATA_DIR, "mcp-bridge.log"))

from cxd_server.app import create_dashboards_app          # noqa: E402
from cxd_server.datasets import DatasetStore, reshape_to_cx  # noqa: E402
from cxd_server.objectstore import open_store             # noqa: E402
from cxd_server.store import DashboardStore               # noqa: E402
from fastapi.staticfiles import StaticFiles               # noqa: E402

DEMO_USER, DEMO_PW = "demo", "demo1234"
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


def _seed():
    """Create the demo user + demo datasets + shipped dashboards (idempotent)."""
    dashboards = DashboardStore(DB_PATH)
    dashboards.create_user(DEMO_USER, DEMO_PW)  # no-op if it exists
    datasets = DatasetStore(open_store(DATASET_URI), store_name="local")
    have = {d["id"] for d in datasets.list(DEMO_USER)}
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    def add(dataset_id, title, csv_text):
        if dataset_id in have:
            return
        datasets.create(DEMO_USER, reshape_to_cx("csv", csv_text), now,
                        title=title, dataset_id=dataset_id)

    # Small inline sets. Stable ids so the Builder's starting panels can bind
    # ({kind:"dataset", id:"regional-sales"}), keeping Builder + Data consistent.
    add("regional-sales", "Regional Sales", _SALES_CSV)
    add("weather-sample", "Weather Sample", _WEATHER_CSV)

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

    saved = {d["id"] for d in dashboards.list_dashboards(DEMO_USER)}

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
                datasets.create(DEMO_USER, source["value"], now,
                                title="Bench: " + ref, dataset_id=dataset_id)
            bench["data"][ref] = {"kind": "dataset", "id": dataset_id, "store": "local"}
        dashboards.save_dashboard(DEMO_USER, bench, now)
        print("  [seed] shipped dashboard: %s" % bench["id"])

    # Sales Overview: small inline spec, shipped as-is.
    sales = load_spec("sales-overview.spec.json")
    if sales and sales["id"] not in saved:
        dashboards.save_dashboard(DEMO_USER, sales, now)
        print("  [seed] shipped dashboard: %s" % sales["id"])


_seed()

# API routes first, then mount the repo so /examples/builder.html and /dist/*.js
# are served from the same origin as /api/* (route lookup tries the API first).
app = create_dashboards_app(serve_static=False)


# Serve the app (builder) directly at / — routes win over the static mount.
# builder.html's relative "../dist/…" resolves to /dist/… from here, which the
# repo mount below serves.
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


@app.get("/canvasxpress-dashboards.umd.js", include_in_schema=False)
def _shared_bundle():
    from fastapi.responses import FileResponse
    # Prefer the freshly built repo bundle over the packaged copy.
    return FileResponse(os.path.join(ROOT, "dist", "canvasxpress-dashboards.umd.js"),
                        media_type="text/javascript")


app.mount("/", StaticFiles(directory=ROOT, html=True), name="repo")


if __name__ == "__main__":
    import uvicorn

    url = "http://%s:%d/" % (HOST, PORT)
    print("\n  CanvasXpress Dashboards demo running:\n    %s\n" % url)
    print("  Demo login is automatic (user 'demo'). Data dir: %s\n" % DATA_DIR)
    uvicorn.run(app, host=HOST, port=PORT)
