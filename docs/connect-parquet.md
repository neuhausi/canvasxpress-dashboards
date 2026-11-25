# Connect a dashboard to a Parquet file

A **Parquet file** — local on the server, or a remote `s3://` / `https://` object — can back a
dashboard through [canvasxpress-connectors](https://github.com/neuhausi/canvasxpress-connectors)
and DuckDB. You register it once by its **path or URL**; you never write a `duckdb:///` URL or a
`read_parquet()` SELECT by hand. A registered Parquet source is stored as a plain SQL source, so
filtering and aggregation **push down** into DuckDB — a multi-million-row file powers a dashboard
without downloading the file.

Read [Connecting your data](connecting-your-data.md) first for how credentials are protected, and
[Large data: aggregate, filter and join in the database](large-data.md) for the pushdown model.
The `[duckdb]` extra of canvasxpress-connectors must be installed on the server.

## Register the source

In the bundled connectors web app (**Register a source**):

1. Set **Type** to **Parquet file (DuckDB)**.
2. **Source**: the path or URL — `orders.parquet`, `s3://bucket/orders/*.parquet` (a glob unions
   files), or `https://host/data.parquet`.
3. **Columns** (optional): restrict to specific columns; leave blank for all.
4. For an `s3://` source, fill the **S3 credentials** fields (region, access key, secret key,
   optional endpoint). They are stored encrypted and masked in the edit form; the browser never
   sees them.
5. **Save source.**

The source is stored as a `sql`-kind source (a `duckdb:///` URL plus a `read_parquet()` SELECT),
so `/api/data`, `/api/columns`, join and pushdown all serve it unchanged.

## Point a panel at it, with pushdown

In a dashboard spec, use a `kind:"connector"` source with a `pushdown` block so DuckDB aggregates
and only the result rows reach the browser:

```jsonc
"params": { "region": { "value": null } },
"data": {
  "byProduct": {
    "kind": "connector",
    "url": "/connectors/api/data?source=orders",
    "pushdown": {
      "groupBy": ["product"],
      "measures": [{ "fn": "sum", "column": "amount", "as": "total_amount" },
                   { "fn": "count" }],
      "where": [{ "column": "region", "op": "in", "value": "$region" }],
      "orderBy": [{ "column": "total_amount", "desc": true }]
    }
  }
}
```

Setting the `region` parameter re-queries DuckDB. See the **Parquet Explorer** example
(`examples/parquet-explorer.html`, served by `examples/parquet-adapter.py`) for a runnable
dashboard over a 300,000-row Parquet file where every panel is a pushdown query.

## Remote files

- **Public HTTPS**: no credentials — DuckDB auto-loads `httpfs` on first read.
- **Private S3**: the credentials you enter ride inside the stored connection URL, so the
  pushdown and join paths (which rebuild the engine from the URL alone) inherit them.
