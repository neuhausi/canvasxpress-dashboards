"""Demo database sources, shipped with the package.

The connectors integration (:mod:`cxd_server.connectors`) can register a couple
of ready-made database sources for every bridged user, so a fresh deployment has
something to chart from without anyone configuring a database first. These used
to live only in the ``examples/`` dev launcher; moving them into the package
means a plain ``pip install`` server gets them too — enable with
``CXD_CONNECTORS_DEMO_SOURCES=on`` (off by default).

The demo data is a tiny, deterministic SQLite database (``inventory.db``) shipped
as package data under ``demo_data/``. At runtime it is copied into a writable
directory and opened strictly READ-ONLY (``mode=ro&uri=true``); a demo database
that is somehow absent from the install is rebuilt there from an embedded,
deterministic builder, so the sources always have data. ``sales.db`` (backing the
examples' ``/api/data`` endpoints) is handled the same way.

The copy lives under the OS temp directory, so its absolute path can change
between deploys (a new host, a cleared temp). :func:`seed_demo_sources` therefore
re-saves a demo source whose stored URL has drifted from the current one, instead
of skipping it because a source of that name already exists — while never
touching a source the user created themselves.
"""

import os
import sqlite3
import tempfile
from typing import Any, Dict, List, Optional

try:                                                # importlib.resources.files: 3.9+
    from importlib.resources import files as _resource_files
except ImportError:                                 # pragma: no cover - <3.9
    _resource_files = None

_TRUE = ("1", "on", "true", "yes")
DEMO_ENV = "CXD_CONNECTORS_DEMO_SOURCES"
# Marker in a stored URL that identifies a source WE seeded (vs. a user's own
# source that happens to share a demo name): we only ever re-save our own.
_DEMO_DIR_NAME = "cxd-demo-data"


def demo_sources_enabled(env: Optional[dict] = None) -> bool:
    """Whether ``CXD_CONNECTORS_DEMO_SOURCES`` turns demo-source seeding on."""
    env = os.environ if env is None else env
    return str(env.get(DEMO_ENV, "")).strip().lower() in _TRUE


def _demo_dir() -> str:
    """A writable directory for the ready-to-serve copies (created if missing)."""
    path = os.path.join(tempfile.gettempdir(), _DEMO_DIR_NAME)
    os.makedirs(path, exist_ok=True)
    return path


def _packaged_bytes(name: str) -> Optional[bytes]:
    """The shipped ``demo_data/<name>`` bytes, or None when not packaged."""
    if _resource_files is None:
        return None
    try:
        resource = _resource_files("cxd_server").joinpath("demo_data", name)
        if resource.is_file():
            return resource.read_bytes()
    except (FileNotFoundError, ModuleNotFoundError, OSError, AttributeError):
        return None
    return None


def ensure_demo_db(name: str) -> str:
    """Path to a ready copy of demo database ``name`` in a writable directory.

    Copies the packaged database there on first use; if the install does not ship
    it, builds it from the embedded deterministic builder. The copy is written to
    a temp file and atomically renamed into place (``os.replace``), so a second
    worker process never observes a half-written file — important under a
    multi-worker server (Connect). Idempotent: an existing copy is reused, and
    re-copied only if its size does not match the packaged database (e.g. a
    half-written file left by an older build, or a changed package).

    :param name: ``"inventory.db"`` / ``"sales.db"`` (or the bare stem).
    :returns: The absolute path to the writable, read-only-served copy.
    """
    if not name.endswith(".db"):
        name = name + ".db"
    dest = os.path.join(_demo_dir(), name)
    data = _packaged_bytes(name)
    if os.path.isfile(dest):
        # Reuse unless we can prove it is stale/partial (size differs from the
        # packaged bytes). Without packaged bytes we trust an existing copy.
        if data is None or os.path.getsize(dest) == len(data):
            return dest
    if data is not None:
        _atomic_write(dest, data)
    elif name in _BUILDERS:
        tmp = dest + ".build-%d.tmp" % os.getpid()
        try:
            _BUILDERS[name](tmp)
            os.replace(tmp, dest)
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    else:
        raise FileNotFoundError("no packaged demo database %r and no builder for it" % name)
    return dest


def _atomic_write(dest: str, data: bytes) -> None:
    """Write ``data`` to ``dest`` atomically (temp file in the same dir + rename),
    so a concurrent reader only ever sees the complete file."""
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), prefix=".tmp-", suffix=".db")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def demo_db_url(name: str) -> str:
    """A strictly read-only SQLAlchemy SQLite URL for demo database ``name``."""
    return "sqlite:///file:" + ensure_demo_db(name) + "?mode=ro&uri=true"


# ---- the demo sources (names reserved for seeding) --------------------------

_INVENTORY_SQL = (
    'SELECT item AS "Item", stock AS "Stock", price AS "Price",'
    ' category AS "Category", warehouse AS "Warehouse"'
    " FROM product_inventory ORDER BY item")
_FURNITURE_SQL = (
    'SELECT item AS "Item", stock AS "Stock", price AS "Price",'
    ' ROUND(stock * price, 2) AS "Value", warehouse AS "Warehouse"'
    " FROM product_inventory WHERE category = 'Furniture' ORDER BY item")


def demo_sources() -> List[Dict[str, str]]:
    """The demo sources to register, with the current read-only inventory URL."""
    url = demo_db_url("inventory.db")
    return [
        {"name": "inventory", "conn_url": url, "sql": _INVENTORY_SQL},
        {"name": "furniture-only", "conn_url": url, "sql": _FURNITURE_SQL},
    ]


def _is_demo_url(url: Optional[str]) -> bool:
    """Whether a stored URL is one WE seeded (points into the demo copy dir)."""
    return bool(url) and _DEMO_DIR_NAME in url


def seed_demo_sources(store: Any, user: str) -> None:
    """Register the demo sources for ``user`` (idempotent, drift-aware).

    Adds a demo source the user does not have; re-saves one WE previously seeded
    whose stored URL (or SQL) has drifted from the current one — so a demo copy
    whose absolute path changed between deploys keeps working; and never modifies
    or deletes a source the user created themselves (even one sharing a demo name,
    recognised by its URL not pointing into the demo copy directory).

    :param store: The connectors ``Store``.
    :param user: The bridged username to seed for.
    """
    have = set(store.list_sources(user))
    for source in demo_sources():
        name, url, sql = source["name"], source["conn_url"], source["sql"]
        if name not in have:
            store.save_source(user, name, url, sql)
            continue
        current = store.get_source(user, name) or {}
        if not _is_demo_url(current.get("conn_url")):
            continue    # a user's own source sharing the name — leave it alone
        if current.get("conn_url") != url or current.get("sql") != sql:
            store.save_source(user, name, url, sql)


# ---- embedded deterministic builders (fallback if a db is not packaged) ------
# Mirror examples/data/make_inventory_db.py and make_sales_db.py exactly, so a
# rebuilt copy is byte-for-byte equivalent in schema and content.

def _build_inventory(dest: str) -> None:
    import random

    rng = random.Random(42)
    warehouses = ["North", "South", "East", "West", "Central"]
    catalogs = {
        "Furniture": ["Desk", "Chair", "Shelf", "Cabinet", "Table", "Sofa", "Stool"],
        "Electronics": ["Laptop", "Monitor", "Tablet", "Camera", "Printer", "Router", "Speaker"],
        "Accessories": ["Headset", "Keyboard", "Mouse", "Dock", "Cable", "Stand", "Charger", "Case"],
        "Office": ["Notebook", "Binder", "Marker", "Stapler", "Organizer", "Lamp", "Whiteboard"],
    }
    other = [c for c in catalogs if c != "Furniture"]
    rows = []
    for i in range(500):                 # SIZE
        category = "Furniture" if i < 50 else rng.choice(other)   # FURNITURE_COUNT
        base = rng.choice(catalogs[category])
        rows.append(("%s %03d" % (base, i + 1), category, rng.choice(warehouses),
                     rng.randint(1, 250), round(rng.uniform(15, 1800), 2)))
    conn = sqlite3.connect(dest)
    try:
        conn.execute("CREATE TABLE product_inventory (item TEXT PRIMARY KEY, category TEXT,"
                     " warehouse TEXT, stock INTEGER, price REAL)")
        conn.executemany("INSERT INTO product_inventory VALUES (?, ?, ?, ?, ?)", rows)
        conn.commit()
    finally:
        conn.close()


def _build_sales(dest: str) -> None:
    regions = ["North", "South", "East", "West", "Central"]
    products = ["Alpha", "Beacon", "Comet", "Delta"]
    revenue = {
        "North":   {"Alpha": 220, "Beacon": 180, "Comet": 240, "Delta": 180},
        "South":   {"Alpha": 260, "Beacon": 150, "Comet": 205, "Delta": 180},
        "East":    {"Alpha": 300, "Beacon": 210, "Comet": 250, "Delta": 150},
        "West":    {"Alpha": 240, "Beacon": 160, "Comet": 190, "Delta": 140},
        "Central": {"Alpha": 160, "Beacon": 120, "Comet": 170, "Delta": 110},
    }
    price = {"Alpha": 4, "Beacon": 5, "Comet": 6, "Delta": 5}
    rows = []
    for region in regions:
        for product in products:
            rev = revenue[region][product]
            rows.append((region, product, rev, rev // price[product]))
    conn = sqlite3.connect(dest)
    try:
        conn.execute("CREATE TABLE sales (region TEXT NOT NULL, product TEXT NOT NULL,"
                     " revenue INTEGER NOT NULL, units INTEGER NOT NULL)")
        conn.executemany("INSERT INTO sales VALUES (?, ?, ?, ?)", rows)
        conn.commit()
    finally:
        conn.close()


_BUILDERS = {"inventory.db": _build_inventory, "sales.db": _build_sales}
