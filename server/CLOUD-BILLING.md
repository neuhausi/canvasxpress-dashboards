# CanvasXpress Cloud — Billing & Paywall Setup

This is the hands-on runbook for standing up the **CanvasXpress Cloud** paywall (Pro
subscription + prepaid AI credits over PayPal) — on a **new development computer** or on the
**production server**. It's the practical companion to the strategy/design docs in the
`canvas-ai` repo (`docs/plans/monetization/`).

> **The paywall is OFF by default.** None of this affects anyone self-hosting the MIT-licensed
> dashboards: every gate is disabled unless you explicitly set `CXD_PAYWALL=on` (and AI metering
> unless `CX_AI_METER=on`). This runbook only applies to *your* hosted Cloud instance.

---

## 1. How it fits together

| Component | Repo / path | Role |
|---|---|---|
| Dashboards server (`cxd_server`) | `canvasxpress-dashboards/server` | Hosts entitlements, the token pool, the gates, and the PayPal **webhook** (`/billing/paypal/webhook`) + `/billing/*` routes. **This is the piece PayPal talks to.** |
| Billing module | `…/server/src/cxd_server/billing.py` | Token minting/verification, `TokenPool`, `EntitlementStore`, PayPal webhook verification. |
| Pool CLI | `…/server/bin/cxd-pool` (or `cxd-pool` console script) | Pre-generate / inspect entitlement tokens. |
| Marketing page | `canvas-ai` → `python/src/html/cloud.html` (built by `build.py`) | The pricing page + PayPal subscribe button. |
| AI metering | `canvasxpress-mcp` → `src/cloud_meter.py` | Reserves one AI credit per model-backed generation (calls the dashboards server's `/billing/consume`). |

Data flow on a purchase: **button (cloud.html) → PayPal → webhook to `cxd_server` → verify → claim a pool token → write entitlement**.

---

## 2. Critical state — back these up (production)

Two files under `CXD_BILLING_DIR` (default `~/cx-cloud-data/`) **are your billing records**:

- **`entitlements.json`** — *who has paid* (tier, token, expiry, PayPal subscription id, AI credits).
  **Losing this loses your paying customers' entitlements.** Put it on persistent, backed-up storage.
- **`token-pool.json`** — the pre-generated tokens and which are sold.

Also treat **`CXD_TOKEN_SIGNING_KEY` as a permanent secret**: it signs every entitlement token.
**If it ever changes, every already-issued token becomes invalid** (customers drop to Community).
Set it once, store it in a secrets manager, never rotate it casually. The pool **must be filled
with the same signing key the server runs with.**

---

## 3. Environment variables

Put these in `server/.env` (git-ignored; `chmod 600`). The server auto-loads `.env`; the
`cxd-pool` CLI and `build.py` need them exported (`set -a; . ./.env; set +a`).

### Dashboards server (`cxd_server`)

| Var | Dev (sandbox) | Prod (live) | Notes |
|---|---|---|---|
| `CXD_PAYWALL` | `on` | `on` | Master switch. Omit/`off` = no gating. |
| `CXD_TOKEN_SIGNING_KEY` | any strong string | **stable secret** | Signs tokens. **Never change in prod.** |
| `CXD_BILLING_DIR` | `~/cx-cloud-data` | persistent, backed-up dir | Holds pool + entitlements. |
| `CXD_METER_KEY` | strong string | strong secret | Shared with the MCP server for `/billing/consume`. |
| `CXD_AI_PACK_CREDITS` | e.g. `500` | your pack size | Credits granted per pack purchase. |
| `CXD_HOST` / `--host` | `::` | per your proxy | **macOS/ngrok need `::`** (see Gotchas). |
| `CXD_PORT` / `--port` | `8899` (dev) | behind reverse proxy | Dev: avoid reserved ports. |
| `PAYPAL_ENV` | `sandbox` | `live` | Switches PayPal API base. |
| `PAYPAL_CLIENT_ID` | sandbox id | live id | Public. |
| `PAYPAL_CLIENT_SECRET` | sandbox secret | live secret | **Secret — env only.** |
| `PAYPAL_WEBHOOK_ID` | sandbox webhook id | live webhook id | From the PayPal webhook you register. |

### MCP server (`canvasxpress-mcp`) — only if metering AI

| Var | Value | Notes |
|---|---|---|
| `CX_AI_METER` | `on` | Off by default (standalone MCP is free). |
| `CX_CLOUD_BILLING_URL` | e.g. `http://127.0.0.1:8899` (prod: the internal dashboards URL) | Where `/billing/consume` lives. |
| `CXD_METER_KEY` | **must match** the dashboards value | Shared secret. |

### Site build (`canvas-ai`, at `build.py` time)

| Var | Value | Notes |
|---|---|---|
| `PAYPAL_CLIENT_ID` | same as server | Public; injected into `cloud.html`. |
| `PAYPAL_PRO_PLAN_ID` | PayPal plan id (`P-…`) | Public; the Pro subscription plan. Unset ⇒ Pro card shows the waitlist CTA. |
| `PAYPAL_AI_PACK_PRICE` | e.g. `10.00` | Public; price of one AI credit pack (one-time). Unset ⇒ AI card shows the waitlist CTA. |
| `PAYPAL_AI_PACK_CREDITS` | e.g. `500` | Public; credits granted per pack. Must be set with the price for the AI button to appear. |

> **Binding a purchase to an account:** the checkout reads `?account=<id>` from the page URL and
> attaches it to the purchase as `custom_id`, so the webhook credits that account (falling back to
> the PayPal subscriber email if absent). Link your logged-in "Upgrade" button to
> `…/cloud.html?account=<username>`. The **AI pack button only appears when `?account=` is present**
> (you buy credits *for* an account); the Pro button works with or without it.

---

## 4. Fresh **development** machine (sandbox)

```bash
# 0. Clone the repos (canvasxpress-dashboards, canvas-ai, canvasxpress-mcp) under ~/git
# 1. Install the server with web + dev extras
cd ~/git/canvasxpress-dashboards/server
pip install -e ".[web,dev]"

# 2. Create server/.env (sandbox). Generate secrets; paste PayPal sandbox creds.
mkdir -p ~/cx-cloud-data
cat > .env <<EOF
CXD_PAYWALL=on
CXD_PORT=8899
CXD_BILLING_DIR=$HOME/cx-cloud-data
PAYPAL_ENV=sandbox
PAYPAL_PRO_PLAN_ID=<your sandbox plan id, P-...>
CXD_TOKEN_SIGNING_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
CXD_METER_KEY=$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')
EOF
# add your PayPal sandbox client id + secret (from developer.paypal.com):
printf 'PAYPAL_CLIENT_ID=%s\n'     '<sandbox client id>' >> .env
printf 'PAYPAL_CLIENT_SECRET=%s\n' '<sandbox secret>'    >> .env
chmod 600 .env

# 3. Fill the token pool (uses the signing key from .env)
set -a; . ./.env; set +a
bin/cxd-pool fill --tier pro --count 20
bin/cxd-pool status

# 4. Run the server (bind :: so ngrok's IPv6 localhost reaches it)
python3 -m cxd_server --host :: --port 8899
```

In other terminals:

```bash
# 5. Tunnel so PayPal can reach the webhook (free ngrok URL changes each restart!)
ngrok http 8899
#    -> copy the https URL

# 6. In PayPal (sandbox) → your app → Add Webhook:
#    URL:    https://<ngrok-url>/billing/paypal/webhook
#    Events: Billing subscription (all), Payment sale completed
#    then: echo "PAYPAL_WEBHOOK_ID=<id>" >> .env   and restart the server (step 4)

# 7. Build + serve the marketing page (from canvas-ai)
cd ~/git/canvas-ai/python
set -a; . ~/git/canvasxpress-dashboards/server/.env; set +a
python3 build.py --debug
cd ~/git/canvas-ai/2026 && python3 -m http.server 8898
#    open http://localhost:8898/cloud.html -> Pro card shows the PayPal button
```

**Test:** subscribe with a PayPal **sandbox buyer** (developer.paypal.com → Testing Tools →
Sandbox Accounts → a Personal account), watch `http://127.0.0.1:4040` for a `200` on
`/billing/paypal/webhook`, then verify:

```bash
cd ~/git/canvasxpress-dashboards/server && set -a; . ./.env; set +a
bin/cxd-pool status                 # pro available dropped by 1
cat ~/cx-cloud-data/entitlements.json   # a record with "tier": "pro"
```

---

## 5. **Production** server (live)

> **⚠️ A PayPal _Business_ account is required for LIVE payments — not for sandbox.** You can build
> and fully test everything in **sandbox** with a free Personal account (that's all we've used). But
> **live** mode needs a Business account because:
> - live REST API credentials are Business-only (the "Upgrade to view live credentials" banner), and
> - Subscriptions/Billing Plans and commercial receiving require Business.
>
> Upgrading Personal → Business is **free** (PayPal only charges a per-transaction fee, ~2.9% + $0.30
> US, when you actually get paid). **You may already have one** — the engine-license PayPal buttons
> on `canvasxpress.org/license.html` receive payments, so check developer.paypal.com: if the **Live**
> tab shows API credentials with no upgrade banner, you're already set.
>
> **Not upgrading yet is fine** — stay in sandbox; nothing below is needed until you decide to accept
> real money. The sandbox flow (§4) is a complete, faithful rehearsal of production.

Same shape as dev, with these differences:

1. **PayPal Business account + LIVE app.** (See the note above — Business is required for live.)
   Create a **live** REST app → live `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET`. Create the **live**
   subscription **plan** (`PAYPAL_PRO_PLAN_ID`). AI credit packs are one-time Orders and need **no**
   pre-created product — just set `PAYPAL_AI_PACK_PRICE` / `PAYPAL_AI_PACK_CREDITS` at build time.
2. **`PAYPAL_ENV=live`** in `.env`.
3. **Real webhook URL, no ngrok.** Register the live webhook at your public domain:
   `https://<your-domain>/billing/paypal/webhook` (same events). Put its id in `PAYPAL_WEBHOOK_ID`.
   Make sure your reverse proxy forwards `POST /billing/*` to `cxd_server`.
4. **Run it as a managed service** (systemd / launchd / Docker) rather than a terminal, e.g. bound
   to `127.0.0.1:<port>` behind nginx/Apache. The repo ships a `Dockerfile` and `server.sh`.
5. **`CXD_BILLING_DIR` on persistent, backed-up storage** (see §2). Do **not** lose
   `entitlements.json`.
6. **Fill the live pool** with the live signing key: `set -a; . ./.env; set +a; bin/cxd-pool
   fill --tier pro --count <N>`. Top up when `bin/cxd-pool status` runs low.
7. **MCP metering (optional):** on the MCP host set `CX_AI_METER=on`, `CX_CLOUD_BILLING_URL`
   (the internal dashboards URL), and the **matching** `CXD_METER_KEY`; restart it.
8. **Build + publish the site** with the live `PAYPAL_CLIENT_ID` + `PAYPAL_PRO_PLAN_ID` so the
   live `cloud.html` carries the live button (your normal `build.py` publish flow).

---

## 6. Gotchas (learned the hard way)

- **IPv6 / `--host ::`** — on macOS, `localhost` resolves to IPv6 (`::1`) first, so ngrok (and
  some proxies) hit the IPv6 listener. Run `cxd_server` with `--host ::` or the webhook may land
  on the wrong process (symptom: `501 Unsupported method ('POST')` from a stray `http.server`).
- **Two servers, two ports (dev)** — the marketing page (`cloud.html`, static, e.g. **8898**) and
  the dashboards app (**8899**, the one ngrok tunnels) are different servers. Don't serve the page
  on the app's port.
- **ngrok free URL changes on every restart** — update the PayPal webhook URL each time.
- **Exported env shadows `.env`** — if you `set -a; . ./.env` then edit `.env`, the old value is
  still exported in that shell. Open a new shell, `unset` the var, or pass a CLI flag (e.g.
  `--port`), which wins.
- **Signing key / pool must match** — fill the pool with the same `CXD_TOKEN_SIGNING_KEY` the
  server runs with, or claimed tokens won't verify.
- **`200` ≠ "granted"** — the webhook returns `200` for ignored events too (e.g. subscription
  *created*/*updated*). Only `BILLING.SUBSCRIPTION.ACTIVATED` claims a token. Confirm via
  `entitlements.json` / `bin/cxd-pool status`.

---

## 7. Operations cheat-sheet

```bash
cd ~/git/canvasxpress-dashboards/server && set -a; . ./.env; set +a

bin/cxd-pool status                         # pool counts (available/sold per tier)
bin/cxd-pool fill --tier pro --count 50     # top up Pro tokens
cat $CXD_BILLING_DIR/entitlements.json      # who's entitled

curl -s http://127.0.0.1:$CXD_PORT/healthz  # server up?
# Admin dry-run grant (no real payment; needs admin login cookie) — see /billing/dev/grant
```

- **`/billing/status`** (logged in) — a user's tier, AI credits, limits.
- **`/billing/paypal/webhook`** — PayPal posts here (verified via `PAYPAL_WEBHOOK_ID`).
- **`/billing/consume`** — internal, MCP-only, shared-secret (`CXD_METER_KEY`).
- **`/billing/dev/grant`** — admin-only, grants a tier/credits without payment (testing).

---

## 8. Known follow-ups (not yet built)

- **Enterprise white-label** — real engine mark-removal keys (private keygen), offline per contract.
- **MCP credit ownership link** — associate a Cloud account (email) with its MCP `api_key_id` so
  purchased AI credits are spent against the right key (AI metering currently keys on `api_key_id`).

*(Built as of 2026-10-09: Pro subscription + AI credit-pack checkout, webhook signature
verification + idempotency, `custom_id`→account binding, the live-source + free-count gates, and AI
credit metering in the MCP server.)*

---

## 9. Tests

```bash
cd ~/git/canvasxpress-dashboards/server
pip install -e ".[web,dev]"
pytest tests/test_billing.py -v     # webhook->pool->Pro, gates, cancel, credits+meter, admin grant
```
