# Live data (streaming)

A `kind: "live"` data source pushes data to the page as it happens. The panel
subscribes to a **Server-Sent-Events** (SSE) stream on your
[canvasxpress-connectors](https://github.com/neuhausi/canvasxpress-connectors)
server, and every message appends new samples to the chart, which keeps a
bounded rolling window.

The [Live Ops](../examples/live-ops.html) example shows two live panels next to a
24-hour snapshot.

Use it for "dashboard-live" views — metrics, sensor or quote feeds that update
every second or so. It is not a trading-grade feed (no sub-second latency
guarantees), not a store of the stream's history, and not a stream-processing
engine: aggregate upstream if you need windowed queries over the stream.

## The source

```jsonc
"data": {
  "feed": {
    "kind": "live",
    "url": "/connectors/api/stream/demo?interval=1&vars=cpu,mem",
    "window": 120,
    "variables": ["cpu", "mem"],
    "initial": { "y": { "vars": ["cpu", "mem"], "smps": ["t0"], "data": [[50], [60]] } }
  }
}
```

| Key | Meaning |
|---|---|
| `url` | The SSE endpoint. A relative URL resolves against the renderer's `baseUrl`. **Required.** |
| `window` | Samples kept per chart (a positive integer); older samples are dropped. Default **1000**. A stream always has a window: an unbounded one would grow memory forever. |
| `variables` | Optional. The series the stream emits; used for the empty starting chart. |
| `initial` | Optional. A CanvasXpress data object shown before the first message. Without it the panel shows *Loading…* until then. |

Bind panels to it with `dataRef` like any other source. For a time series with
time along the horizontal axis, give a Line panel
`"graphOrientation": "vertical"`.

Live sources are part of spec format **1.2**. An older reader accepts the spec
with a warning and renders the rest of the dashboard; panels bound to a live
source show an error there.

## Building one without code

In the builder, a panel's **Data** list offers the streams your server provides
(marked 📡). Pick one and the panel follows it: a panel still on the default Bar
becomes a vertical Line. Two fields then appear next to **Data**:

- **Window** — samples to keep (empty = 1000).
- **Every (s)** — seconds between updates, sent to the stream as `?interval=`;
  the server keeps it within its own bounds.

Each change reopens the stream with the new settings.

## Hosting

The builder learns which streams exist from `listLiveSources`, and a live
stream authenticates with the connectors session, which `prepareLive`
establishes before any stream opens:

```js
createBuilder(host, {
  listLiveSources: () => ensureConnectorsSession()
    .then(() => fetch('/connectors/api/streams', { credentials: 'include' }))
    .then(r => r.json())
    .then(res => res.streams.map(s => ({ ...s, url: '/connectors' + s.url }))),
  prepareLive: ensureConnectorsSession
});
renderDashboard(spec, host, { prepareLive: ensureConnectorsSession });
```

`prepareLive` runs once, only for a dashboard with a live source; streams open
when it settles (also if it fails — a refused stream then reports itself). The
bundled server's app does this with its connectors bridge.

## Adding streams

The connectors app lists its streams at `GET /api/streams` and serves each at
`GET /api/stream/<name>`. It ships a simulated `demo` feed; register your own
when you mount it:

```python
from cx_connectors.web.byo_app import create_byo_app

def open_quotes(query, interval, user):
    # Runs on the server, per subscription: any upstream secret stays here,
    # and `user` lets you use the viewer's own credentials.
    return MyQuoteFeed(symbols=query.get("symbols", "IBM").split(","), interval=interval)

app.mount("/connectors", create_byo_app(
    store=store, serve_static=False,
    live_streams={"quotes": {"title": "Quotes", "variables": ["IBM"],
                             "open": open_quotes}}))
```

A feed is any object with an `interval` and a `poll()` that returns the next
message (or `None` for nothing new).

## Governance

- **Audit:** every subscription is recorded as `live.subscribe` — who, which
  stream, allowed or refused — when the stream opens.
- **Lineage** lists live streams and the dashboards that read them.
- **Access:** a stream is served with the viewer's own connectors session, like
  a database connector; row- and column-level rules protect stored datasets and
  do not apply to streams. See [governance](governance.md#limits).
- **Share links:** a viewer who is not signed in cannot open a stream; live
  panels show their `initial` data, or stay on *Loading…*.

## Messages

Each SSE event of type `tick` carries a CanvasXpress data object with **only the
new samples**:

```json
{ "y": { "vars": ["cpu", "mem"], "smps": ["t42"], "data": [[51.2], [63.8]] },
  "x": { "time": ["2026-09-25T12:00:42Z"] } }
```

- `y.data` has one row per variable and one column per new sample.
- When `y.vars` is present, rows are matched to the chart's variables **by
  name**; otherwise in order.
- `x` holds optional per-sample annotations (e.g. a timestamp).

A connectors server produces this from any live source (a class with an
`interval` and a `poll()` returning such a message) — see the connectors README.
Its `/api/stream/demo` endpoint streams a simulated metric feed for trying this
out.

## How updates are applied

- Messages that arrive between two animation frames are **merged into one**, so
  a burst costs a single redraw per frame.
- Each merged message goes to the chart's `pushData`, which appends the samples,
  drops the oldest beyond the window, and redraws. Cached statistics over the
  data are recomputed for the new window.
- With a CanvasXpress build that predates `pushData`, or a panel that transposes
  its data, the renderer keeps the window itself and calls `updateData` with it
  instead — slower, same result.
- Streaming targets **chart panels**. A table control bound to a live source
  without `initial` data stays empty; bind tables to a snapshot source.

## Connection and security

- The browser subscribes to **your** server with the session cookie
  (`withCredentials`); it never holds an upstream credential. The connectors
  server keeps any secret (encrypted) and relays.
- `EventSource` reconnects on its own after a drop (the server sends a retry
  hint and an event id per message); in between, the panel keeps showing its
  last data.
- `destroy()` on the dashboard handle closes every stream.
- Outside a browser (no `EventSource`) nothing is subscribed, so a live panel
  shows its `initial` data or stays on *Loading…*; pass `options.EventSource`
  to `renderDashboard` to supply an implementation.

## Which charts make sense live

Charts that plot samples along an axis — Line, Area, Bar, Scatter2D, Dotplot —
read naturally as a rolling window. Statistics over the window (regression,
smoothing, clustering, forecasts) are recomputed on every update, so they
describe *the current window*, not the whole history, and can move as it
slides; prefer a snapshot source when you need a stable fit.
