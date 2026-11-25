#!/usr/bin/env python3
"""Seed the demo Parquet file for the parquet-explorer example.

Writes a few hundred thousand synthetic order rows (region / product / amount /
order_date) so the pushdown value-prop is visible: the file holds ~300k rows, but a
grouped query returns a dozen. Deterministic (fixed DuckDB setseed) so the example
is reproducible.

    python3 examples/gen-parquet.py            # -> examples/data/demo.parquet
    CXD_PARQUET=/tmp/demo.parquet python3 examples/gen-parquet.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.environ.get("CXD_PARQUET", os.path.join(HERE, "data", "demo.parquet"))
ROWS = int(os.environ.get("CXD_PARQUET_ROWS", "300000"))


def main():
    import duckdb

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    con = duckdb.connect()
    con.execute("SELECT setseed(0.42)")
    con.execute(
        """
        COPY (
          SELECT
            ['EMEA','AMER','APAC','LATAM'][(cast(random()*4 as int) % 4) + 1] AS region,
            ['Laptop','Phone','Tablet','Monitor','Keyboard','Mouse'][(cast(random()*6 as int) % 6) + 1] AS product,
            round(20 + random() * 1980, 2) AS amount,
            DATE '2024-01-01' + cast(random() * 700 as int) AS order_date
          FROM range({0})
        ) TO '{1}' (FORMAT PARQUET)
        """.format(ROWS, OUT)
    )
    n = con.execute("SELECT count(*) FROM read_parquet('{0}')".format(OUT)).fetchone()[0]
    print("wrote %s  (%d rows)" % (OUT, n))


if __name__ == "__main__":
    main()
