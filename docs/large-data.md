# Large data: aggregate, filter and join in the database

A dashboard over a table of millions of rows should not download the table. With
**pushdown**, a connector source asks the database for the answer the charts
need. The database filters, groups, sorts and limits, and only the result reaches
the browser:

- per-category totals rather than every order;
- the rows a Filters panel selects rather than all rows;
- two tables joined in the database rather than both downloaded.

Pushdown needs a SQL source served by
[canvasxpress-connectors](https://github.com/neuhausi/canvasxpress-connectors) 0.6+.
That covers any SQLAlchemy database, and DuckDB over Parquet files. On a 2,000,000-row
Parquet file, a grouped and filtered query returns in about 0.3 s, and 50 rows travel.

## A pushdown source

Add a `pushdown` block to a `kind:"connector"` source:

```jsonc
"data": {
  "orders": {
    "kind": "connector",
    "url": "/connectors/api/data?source=orders",
    "pushdown": {
      "groupBy": ["region", "product"],
      "measures": [{ "fn": "sum", "column": "amount" }, { "fn": "count" }],
      "where": [{ "column": "status", "op": "in", "value": ["won", "open"] }],
      "orderBy": [{ "column": "sum_amount", "desc": true }],
      "limit": 1000
    }
  }
}
```

The data store sends it as the `_q` request parameter. The connector wraps the
source's own `SELECT` (written by its owner) as a subquery.

| Key | Takes |
|---|---|
| `groupBy` | Columns to group by. Each result row's id joins their values (`EMEA · Laptop`), and each group column stays a column, to `colorBy`, facet or filter. |
| `measures` | `{fn, column, as?}`: `count` (no column = rows), `count_distinct`, `sum`, `avg`/`mean`, `min`, `max`. Output name: `as`, else `fn_column` (e.g. `sum_amount`), or `count`. With no `groupBy`, one row of totals. |
| `where` | `{column, op, value}`: `op` is `=`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not_in`, `between` (`[low, high]`), `is_null` or `not_null`. |
| `columns` | Instead of `groupBy`/`measures`: return these columns of the matching rows. |
| `orderBy` | Output names, or `{column, desc}`. |
| `limit` | Up to 1,000,000. The connector also caps results at `CX_MAX_ROWS` (default 100,000). |
| `filters` | `false` keeps Filters-panel picks in the browser (default: sent to the database). |

Chart the measures by name, for example `"xAxis": ["sum_amount"]`.

**Parameters.** A filter value may be a `"$name"` parameter, which a
[param control](live-data-controls.md) sets:

```jsonc
"params": { "region": { "value": null } },
"data": { "orders": { "kind": "connector", "url": "/connectors/api/data?source=orders",
  "pushdown": { "groupBy": ["product"], "measures": [{ "fn": "sum", "column": "amount" }],
                "where": [{ "column": "region", "op": "in", "value": "$region" }] } } }
```

Setting `region` re-queries the database. An unset parameter drops its filter, so
the query widens back to everything. A single value on an `in` filter is treated
as a one-value list.

**Safety.** The browser never writes SQL:

- Column names are checked against the source's real columns and quoted.
- Functions and operators come from fixed lists.
- Values are bound parameters.

The source's own SQL, and any `:name` parameters it declares, are unchanged.

## Filters on demand

A [Filters panel](../README.md#filters-panel-and-filter-schemes) over a pushdown
source sends its selections to the database: a value list becomes an `in` filter,
and a range becomes `>=` / `<=`. It then re-queries the source, and the sources
built from it, such as joins and functions.

- **Its lists keep every value.** They come from the source's first, unfiltered
  answer, so unticking a value does not hide the others.
- **No per-value counts.** The source's rows are groups the database made, so a
  row count per value would mislead; values are shown alone.
- **Text search stays in the browser.** It filters the rows that come back.

Filters on other sources still narrow a pushdown source through
[relationships](../README.md#cross-source-marking-and-filtering-relationships), as
before.

## Joins in the database

A [`kind:"join"`](../README.md#data-blending-joins) of two connector sources can
run in their database:

```jsonc
"orders":    { "kind": "connector", "url": "/connectors/api/data?source=orders" },
"customers": { "kind": "connector", "url": "/connectors/api/data?source=customers" },
"bySegment": { "kind": "join", "left": "orders", "right": "customers", "on": "customer_id",
               "pushdown": { "groupBy": ["segment"], "measures": [{ "fn": "sum", "column": "amount" }] } }
```

`"pushdown": true` joins in the database. A pushdown object also aggregates the
joined rows there: above, revenue per customer segment in one query, with neither
table downloaded.

The result names its columns exactly as the browser join does: the left's
columns, then the right's, with a clashing right column suffixed `.<right ref>`.

It applies when both inputs:

- are plain connector sources, with no `pushdown` of their own;
- are served by one connectors app (`<base>/api/data?source=…`);
- are row-oriented;
- live on **the same database connection**;

and the join sets no custom `suffix`.

Otherwise the join runs in the browser, exactly as before. The same fallback
applies when the connector refuses, for example because the sources are in
different databases.

## Client scale

Pushdown is the main answer to large data: move the work to the database. For
charts that must show many points in the browser, CanvasXpress already decimates
large scatter plots. A WebGL data layer is planned in the engine.

## Checklist

1. Serve the table through a connectors SQL source (any SQLAlchemy database, or
   DuckDB for Parquet/CSV files).
2. `GET /connectors/api/columns?source=…` lists its columns and types.
3. Give the dashboard's source a `pushdown` block. Chart its measures by name,
   and add a Filters panel for on-demand filtering.
4. Keep the source's own SQL narrow (a view, or a `WHERE` on partitions) and the
   database user read-only.
