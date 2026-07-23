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

from cxd_server.app import create_dashboards_app          # noqa: E402
from cxd_server.datasets import DatasetStore, reshape_to_cx  # noqa: E402
from cxd_server.objectstore import open_store             # noqa: E402
from cxd_server.store import DashboardStore               # noqa: E402
from fastapi.staticfiles import StaticFiles               # noqa: E402

DEMO_USER, DEMO_PW = "demo", "demo1234"
HOST, PORT = "127.0.0.1", 8000

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


def _seed():
    """Create the demo user + a couple of datasets (idempotent)."""
    DashboardStore(DB_PATH).create_user(DEMO_USER, DEMO_PW)  # no-op if it exists
    datasets = DatasetStore(open_store(DATASET_URI), store_name="local")
    if datasets.list(DEMO_USER):
        return
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    # Stable ids so the Builder's starting panels can bind to these same datasets
    # ({kind:"dataset", id:"regional-sales"}), keeping Builder + Data consistent.
    datasets.create(DEMO_USER, reshape_to_cx("csv", _SALES_CSV), now,
                    title="Regional Sales", dataset_id="regional-sales")
    datasets.create(DEMO_USER, reshape_to_cx("csv", _WEATHER_CSV), now,
                    title="Weather Sample", dataset_id="weather-sample")


_seed()

# API routes first, then mount the repo so /examples/builder.html and /dist/*.js
# are served from the same origin as /api/* (route lookup tries the API first).
app = create_dashboards_app(serve_static=False)
app.mount("/", StaticFiles(directory=ROOT, html=True), name="repo")


if __name__ == "__main__":
    import uvicorn

    url = "http://%s:%d/examples/builder.html" % (HOST, PORT)
    print("\n  CanvasXpress Dashboards demo running:\n    %s\n" % url)
    print("  Demo login is automatic (user 'demo'). Data dir: %s\n" % DATA_DIR)
    uvicorn.run(app, host=HOST, port=PORT)
