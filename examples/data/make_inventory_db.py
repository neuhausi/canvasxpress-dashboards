#!/usr/bin/env python3
"""Regenerate the committed demo SQLite database (examples/data/inventory.db).

The database is checked into the repo so every deployment serves identical
demo data; the app opens it READ-ONLY. Re-run this script (and commit the
result) whenever the demo data should change:

    python examples/data/make_inventory_db.py
"""

import os
import random
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "inventory.db")

SIZE = 500              # total products
FURNITURE_COUNT = 50    # exactly this many rows are Furniture


def generate_rows():
    """Deterministic product rows (seeded RNG, so output is reproducible)."""
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
    for i in range(SIZE):
        category = "Furniture" if i < FURNITURE_COUNT else rng.choice(other)
        base = rng.choice(catalogs[category])
        rows.append(("%s %03d" % (base, i + 1), category, rng.choice(warehouses),
                     rng.randint(1, 250), round(rng.uniform(15, 1800), 2)))
    return rows


def main():
    if os.path.exists(DB_PATH):
        os.remove(DB_PATH)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            "CREATE TABLE product_inventory ("
            " item TEXT PRIMARY KEY, category TEXT, warehouse TEXT,"
            " stock INTEGER, price REAL)"
        )
        conn.executemany("INSERT INTO product_inventory VALUES (?, ?, ?, ?, ?)",
                         generate_rows())
        conn.commit()
    finally:
        conn.close()
    print("wrote %s (%d products, %d furniture)" % (DB_PATH, SIZE, FURNITURE_COUNT))


if __name__ == "__main__":
    main()
