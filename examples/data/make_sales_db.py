#!/usr/bin/env python3
"""Regenerate the committed demo sales database (examples/data/sales.db).

Mirrors make_inventory_db.py: a small, deterministic SQLite table so every
deployment serves identical data. Backs the real, database-connected examples:
  - "Sales Live"        → revenue by region        (/api/data?source=sales)
  - "Live-data controls"→ revenue+units by product, filtered by region/search
                          (/api/data?source=salesProducts&region=&q=), plus the
                          region choice list (/api/data?source=salesRegions).

    python3 examples/data/make_sales_db.py
"""
import os
import sqlite3

DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sales.db")

# region, product, revenue (k$), units — deterministic (no randomness) so the
# committed DB is stable. A full region × product grid so every control has data.
REGIONS = ["North", "South", "East", "West", "Central"]
PRODUCTS = ["Alpha", "Beacon", "Comet", "Delta"]
# revenue[region][product]; units are derived as revenue // a per-product price.
REVENUE = {
    "North":   {"Alpha": 220, "Beacon": 180, "Comet": 240, "Delta": 180},
    "South":   {"Alpha": 260, "Beacon": 150, "Comet": 205, "Delta": 180},
    "East":    {"Alpha": 300, "Beacon": 210, "Comet": 250, "Delta": 150},
    "West":    {"Alpha": 240, "Beacon": 160, "Comet": 190, "Delta": 140},
    "Central": {"Alpha": 160, "Beacon": 120, "Comet": 170, "Delta": 110},
}
PRICE = {"Alpha": 4, "Beacon": 5, "Comet": 6, "Delta": 5}  # k$ per unit


def main():
    if os.path.exists(DB):
        os.remove(DB)
    conn = sqlite3.connect(DB)
    try:
        conn.execute(
            "CREATE TABLE sales ("
            " region   TEXT NOT NULL,"
            " product  TEXT NOT NULL,"
            " revenue  INTEGER NOT NULL,"
            " units    INTEGER NOT NULL)"
        )
        rows = []
        for region in REGIONS:
            for product in PRODUCTS:
                rev = REVENUE[region][product]
                rows.append((region, product, rev, rev // PRICE[product]))
        conn.executemany(
            "INSERT INTO sales (region, product, revenue, units) VALUES (?, ?, ?, ?)",
            rows,
        )
        conn.commit()
    finally:
        conn.close()
    print("wrote %s (%d rows)" % (DB, len(rows)))


if __name__ == "__main__":
    main()
