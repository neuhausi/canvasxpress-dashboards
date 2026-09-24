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

`ibm-optionswall.json` is the input for the OptionsWall example, not a seeded
dataset. It holds IBM daily OHLC prices plus the option chains (strike, IV,
premium) of several expiries. `node examples/gen-optionswall.cjs` turns it into
`examples/options-wall.spec.json`.

The reshape (`server/src/cxd_server/datasets.py`) treats a column as a numeric
**measure** when its non-blank cells are all numeric, emitting any missing cells
as `null` (CanvasXpress renders those as gaps). The Superstore file here is still
trimmed to real order rows (the mirror had the workbook's People/Returns sheets
concatenated in); penguins keeps its canonical complete-case rows.

## Sources

- **Palmer Penguins** — Horst, Hill & Gorman; CC0. via `mwaskom/seaborn-data`.
- **Gapminder** — gapminder.org (unfiltered), via `plotly/datasets`.
- **Diamonds** — ggplot2 / `mwaskom/seaborn-data`.
- **Sample Superstore** — Tableau sample workbook (Orders sheet), via a public
  GitHub mirror.
- **IBM prices and options** — a public market-data snapshot (end-of-day
  prices and option chains, August 2026), captured for the OptionsWall example.

These are widely-used public teaching datasets included here for development
convenience.
