# Pins boards as a live dashboard source (Posit pins via the connector)

A dataset pinned to a **Posit pins** board — written from R or Python with
`pin_write()` — can feed a dashboard **live**, with no export step. The
`canvasxpress-connectors` package ships a first-class `PinsBoardSource`; the
dashboards app reads it through the bridged connectors mount, so a panel bound to
a pins source re-reads the board on each load and the browser only ever sees the
reshaped chart data (board credentials stay server-side).

There are **two** Pins examples, on purpose:

| Example | What it shows | Data path |
|---|---|---|
| **Pins Board Overview** (`pins-overview.html`) | The pins *consumer pattern* and the resulting dashboard | Data is read once at seed time and **baked** into stored datasets — zero runtime dependency, always renders |
| **Pins Board (live connector)** (`pins-live.html`) | The **real connector** reading a pin **live** | Panels bind to a `kind:"connector"` source; the server reads the pin through `PinsBoardSource` on every load |

Use the baked one as a zero-dependency intro; use the live one to demonstrate the
genuine connector path end-to-end.

## How the live example works

1. **Publish** — on startup the demo publishes the Palmer Penguins table to a local
   pins `board_folder` (exactly what an analyst's `pin_write()` produces):

   ```python
   import pins, pandas as pd
   board = pins.board_folder("<data-dir>/pins-board")
   board.pin_write(penguins_df, "penguins", type="csv")
   ```

2. **Register** a `pins` connector source pointing at that board (stored encrypted):

   ```python
   store.save_source(user, "pins-penguins",
       json.dumps({"board_type": "folder", "pin": "penguins",
                   "config": {"path": "<data-dir>/pins-board"}}),
       "", kind="pins")
   ```

   (See `_seed_pins_board_source` in `examples/serve.py`.)

3. **Bind** a dashboard panel to it — the source is a connector URL, so nothing is
   stored in the dataset store:

   ```json
   "data": {
     "penguins": { "kind": "connector", "url": "/connectors/api/data?source=pins-penguins" }
   }
   ```

   The reshape makes the numeric columns the chart **variables**, the first column
   the (unique) **sample id**, and the remaining categorical columns **annotations**
   (here `species`, `island`, `sex`) — so a panel can color or facet by `species`.

4. **Render** — the standalone page bridges the connector session from your app
   login (`GET /api/connectors/credentials` → `POST /connectors/auth/login`, via the
   `prepareConnectors` hook) and renders. Inside the Builder the bridge is automatic;
   open **✏️ Open in Builder** to see the source wiring and the panels' recipes.

## Point it at your own board

`PinsBoardSource` supports four `board_type` backends — change the registered
source's config and the same dashboard reads your board:

- **`connect`** — a Posit Connect server: `config` = `{server_url, api_key}` (or the
  `CONNECT_SERVER` / `CONNECT_API_KEY` environment); pin name is usually `"owner/name"`.
- **`folder`** — a local or mounted directory: `config` = `{path}`.
- **`s3`** — an S3 bucket: `config` = `{path: "<bucket>", region, …}` (needs the
  `pins[pins-s3]` extra + AWS credentials in the server environment).
- **`url`** — a read-only board published over HTTP(S): `config` = `{url, path}` (the
  board root and the pin's versioned sub-path).

A pin written from R reads identically (the `pins` package is cross-compatible), so
an analyst's R `pin_write()` board becomes a live dashboard source with no port.

## Requirements

- The `pins` Python package: `pip install "canvasxpress-connectors[pins]"` (plus
  `[pins-s3]` for S3 boards).
- The connectors mount enabled (`CXD_CONNECTORS=on`, or the demo `examples/serve.py`,
  which enables it automatically).
- A non-tabular pin (a model, a plot) cannot become a chart — `PinsBoardSource`
  raises a clear error rather than a cryptic reshape failure.

To connect **your own** board with your own credentials, see
[Connect a dashboard to a Posit pins board](connect-pins.md) (registration, the server's
folder and S3 rules, and how the board's key is protected).

See also: [live streaming](live-streaming.md) (SSE streams through the same
connectors mount) and the connectors package README for the full source list.
