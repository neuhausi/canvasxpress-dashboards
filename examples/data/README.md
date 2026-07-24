# Demo datasets

Real-world CSVs for developing dashboards against realistic data. Each mixes
categorical columns (grouping / color / facet + cross-panel broadcast) with
numeric measures. `examples/serve.py` seeds them into the demo user's dataset
store on startup, so they appear in the **Data** view and can be bound in the
**Builder**.

| File | Rows | Measures | Categoricals | Notes |
|---|---|---|---|---|
| `penguins.csv` | 342 | bill length/depth, flipper length, body mass | species, island, sex | Small & clean — fast iteration. Rows with missing measurements removed. |
| `gapminder.csv` | 3,313 | year, lifeExp, pop, gdpPercap | country, continent | Has a **time** dimension for line panels. |
| `superstore.csv` | 9,994 | Sales, Quantity, Discount, Profit | Region, Segment, Category, Sub-Category, Ship Mode, State, dates | BI-dashboard classic — great for coordinated panels. Orders only (People/Returns sheets removed). |
| `diamonds.csv` | 53,940 | depth, table, price, x, y, z | cut, color, clarity | Larger set for scale / perf checks. |

The reshape treats a column as a numeric **measure** only when *every* cell is
numeric (see `server/src/cxd_server/datasets.py`), so these files are cleaned of
blank/`NA` cells in their numeric columns — otherwise those columns would fall
back to string annotations.

## Sources

- **Palmer Penguins** — Horst, Hill & Gorman; CC0. via `mwaskom/seaborn-data`.
- **Gapminder** — gapminder.org (unfiltered), via `plotly/datasets`.
- **Diamonds** — ggplot2 / `mwaskom/seaborn-data`.
- **Sample Superstore** — Tableau sample workbook (Orders sheet), via a public
  GitHub mirror.

These are widely-used public teaching datasets included here for development
convenience.
