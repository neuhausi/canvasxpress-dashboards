# Connect a dashboard to a Posit pins board

A dataset **pinned** to a [Posit pins](https://pins.rstudio.com/) board, written from R or Python
with `pin_write()`, can be used in a dashboard in two ways: **copied in by its web address** in
a few clicks, or **read live** so the dashboard always shows the latest version. A pin written
from R reads exactly like one written from Python.

Read [Connecting your data](connecting-your-data.md) first for how credentials are protected. For
a worked example and how the demo is wired, see [Pins boards as a live source](pins-connector.md).

## Two ways to get a pin into the dashboards

| | **Add the pin's address** (a copy) | **A live source** |
|---|---|---|
| Where | **Data → + Data → External URL / connector** | An API call by the administrator |
| Data | Copied into the dashboards once | Read again every time a dashboard loads |
| Who can set it up | Any dashboard author, no administrator | The administrator |
| Boards it reaches | A pin served at a web address, such as one on Posit Connect | Posit Connect, a folder, S3 or a web address |
| Pin format | **JSON** | Any data-frame format (`csv`, `arrow`, `parquet`) |
| Credentials stored on the server | **None**: your own browser sends your own login | The board's key, encrypted |

Start with the first way if you just want the data in a dashboard. Use the second when the
dashboard must always show the latest version of the pin.

## Way 1: add the pin's address

1. **Pin the data as JSON.** From R: `pins::pin_write(board, my_data, "my-data", type = "json")`.
   A data frame becomes a list of rows, which is what the dashboards read. (CanvasXpress JSON, an
   object with a `y` part, works too.) A pin written as `csv` or `rds` can't be added this way;
   use a live source for those.
2. **Copy the pin's address.** Use the address of the pinned **data file** itself. On Posit
   Connect it has the form `https://connect.example.com/content/<content-id>/<file name>`; open
   it in a browser tab where you are signed in to Connect, and you should see the JSON.
3. In the dashboards open **Data → + Data**. The **Add data** window opens.
4. Type a **Name**, set **Source** to **External URL / connector**, and paste the address.
5. Click **Add**. The data appears under **File sources** with its size (for example
   `120×7`) and you can preview it straight away.

The first column becomes each row's id, columns that are all numbers become variables, and the
other columns become annotations you can color, group or filter by.

**Whose login is used.** The address is fetched by your own browser and sent with your own
session cookie, so you can add exactly what you are allowed to see on Posit Connect, and the
dashboards server never holds a Connect key. This works when the dashboards and the pin are on
**the same Posit Connect server** (the same host name), because your Connect session is then
sent automatically. A pin on a different server is blocked by the browser unless that server
allows it; use a live source for those.

**It's a copy.** The data is stored as a dataset the moment you add it, and doesn't change when
the pin does. To pick up a newer version, add the address again (it makes a new dataset) and
delete the old one with the **×** on its card.

If **Add** fails, see [Troubleshooting](#troubleshooting).

## Way 2: a live source

A live source reads the pin again each time a dashboard loads, so a dashboard always shows the
latest version. The administrator registers it once and authors then pick it by name.

### What you need

1. A pin that is a **data frame**. A model, plot or single value cannot become a chart and gives
   a clear error. Write it in a cross-language format: `type = "csv"`, `"arrow"` or `"parquet"`.
   A pin written as `type = "rds"` is R-only and can't be read.
2. Which kind of board it is, and that board's settings (below).
3. The package on the server: `pip install "canvasxpress-connectors[pins]"`, plus `[pins-s3]` for S3
   boards.

### Choose the board type

| `board_type` | Where the pin lives | `config` | Stored secret |
|---|---|---|---|
| `connect` | A Posit Connect server | `{"server_url": "https://connect.example.com", "api_key": "…"}` | the API key |
| `folder` | A local or mounted directory | `{"path": "/srv/pins/team"}` | none |
| `s3` | An S3 bucket | `{"path": "my-bucket", "region": "us-east-1", "key": "…", "secret": "…"}` | the S3 keys |
| `url` | A read-only board published over HTTP(S) | `{"url": "https://host/board/", "path": "penguins/20240101T000000Z-abcd/"}` | none |

For a Connect board the pin name is usually `owner/name`. For a `url` board, `url` is the board's
root and `path` is the pin's versioned sub-path.

### Register the source (once)

Registration is a short API call by the administrator, signed in as the user who will build the
dashboard. `BASE` is the address of your dashboards app (for example
`https://example.com/dashboards`):

```bash
BASE=https://example.com/dashboards
read -s -p "Dashboards password: " PW; echo
curl -s -c jar -H 'Content-Type: application/json' \
     -d "{\"username\":\"admin\",\"password\":\"$PW\"}" $BASE/auth/login
curl -s -b jar -c jar $BASE/api/connectors/credentials | \
  curl -s -b jar -c jar -H 'Content-Type: application/json' -d @- $BASE/connectors/auth/login
curl -s -b jar -H 'Content-Type: application/json' -X POST $BASE/connectors/api/sources -d '{
  "name": "team-sales",
  "kind": "pins",
  "board_type": "connect",
  "pin": "analyst/sales-summary",
  "config": {"server_url": "https://connect.example.com", "api_key": "…"}
}'
```

The settings are stored **encrypted** and belong to the user who registered the source. The API
key and S3 keys are never shown again: the Builder shows them as `********`. To change a setting,
register the source again under the same name.

### What the server will and won't do

A user who registers a source must not be able to read whatever the *server* can reach, so the
server never borrows its own credentials for a pins source:

| Setting | Default | Effect |
|---|---|---|
| A `connect` board | | `server_url` **and** `api_key` are required in the source. The server's own Connect environment is never used. |
| `CXC_PINS_FOLDER_ROOTS` | unset: **folder boards are disabled** | A colon-separated list of allowed roots, for example `/srv/pins:/data/pins`. A folder board's `path` must sit inside one of them; `..` and symlink escapes are refused. |
| `CXC_PINS_S3_SERVER_CREDENTIALS` | `off` | When `on`, an S3 board with no keys in its settings may use the server's own AWS credentials. Off: the source must carry its own keys. |

If a folder board is refused, the administrator needs to set `CXC_PINS_FOLDER_ROOTS`.

### Use it in a dashboard

The source appears by name where you choose data in the Builder. A dashboard refers to it like
this:

```json
"data": { "sales": { "kind": "connector", "url": "/connectors/api/data?source=team-sales" } }
```

The first column becomes each row's id, numeric columns become variables, and the other columns
become annotations you can color, group or filter by.

## Troubleshooting

### Adding a pin's address

The **Add data** window shows `Couldn’t import from URL:` followed by the reason.

| Reason | Cause and fix |
|---|---|
| `HTTP 404` | The address is wrong. Copy the pinned file's address again from Posit Connect. |
| `HTTP 401` or `HTTP 403` | You may not see that content on Connect, or your Connect session has expired. Sign in to Connect, then try again. |
| `Unexpected token '<' …` (or another "not valid JSON" message) | The address returned a web page, usually a Connect sign-in page, not JSON. Sign in to Connect in this browser, and check the address points at the pinned **file**, not the pin's page. |
| `Failed to fetch` | The browser blocked the request: the pin is on a different server than the dashboards, and that server doesn't allow it. Use a live source instead. |
| `JSON dataset must be a non-empty array of row objects` | The file isn't a table: it is empty, or an object that isn't CanvasXpress JSON (an object needs a `y` part). Pin a data frame with `type = "json"`. |

### A live source

| Symptom | Cause and fix |
|---|---|
| `Folder pins boards are disabled: set CXC_PINS_FOLDER_ROOTS …` | The administrator hasn't allowed any folder. Set `CXC_PINS_FOLDER_ROOTS`. |
| `Folder path '…' is outside the allowed roots` | Move the board under an allowed root, or add its parent to `CXC_PINS_FOLDER_ROOTS`. |
| `A pins Connect board requires an explicit 'server_url' and 'api_key' …` | Put both in the source's settings; the server's own Connect environment is not used. |
| `A pins S3 board requires credentials in its config unless the operator sets CXC_PINS_S3_SERVER_CREDENTIALS=on …` | Add `key` and `secret` to the settings, or have the administrator turn that setting on. |
| `Pin '…' is not a tabular dataset … only a data-frame pin can feed a chart.` | Pin a data frame, not a model or plot. |
| The pin can't be read from Python | It was written `type = "rds"`. Rewrite it as `csv`, `arrow` or `parquet`. |
| `ModuleNotFoundError: pins` | Install `canvasxpress-connectors[pins]` (and `[pins-s3]`) in the environment that runs the server. |
