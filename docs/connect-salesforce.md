# Connect a dashboard to Salesforce

A dashboard can read **live Salesforce data** (Opportunities, Accounts, Cases, anything a SOQL
query can return) with your own Salesforce credentials. Each time a dashboard loads, the server
runs your query against your org; nothing is copied into the dashboard.

Read [Connecting your data](connecting-your-data.md) first for how credentials are protected.

## 1. Choose how the server signs in to Salesforce

| | **OAuth app** (recommended) | **Username, password and token** |
|---|---|---|
| What you give the server | A Salesforce app's key and secret, kept in the server's settings | A user's password and security token |
| What a source stores | Only the app's name | The login, encrypted |
| A user password to keep current | No | Yes, and the token changes with it |
| Works after Salesforce retires SOAP `login()` (Summer '27) | Yes | No |
| Setup effort | More: an app in Salesforce plus a server setting | Less |

If you can, use the OAuth app. The password login is described last, for orgs that can't.

## 2. OAuth app

### In Salesforce (a Salesforce administrator)

1. Create an app for the integration: an **External Client App** (older orgs: a **Connected App**).
2. Turn on OAuth with the **`api`** scope and **Enable Client Credentials Flow**. If the form asks
   for a callback URL, any HTTPS address will do, because this flow never redirects. Screen names
   vary a little between Salesforce releases.
3. In the app's policies set **Run As** to a **dedicated integration user**. Every query runs as
   that user, so give it read access to only the objects and fields the dashboards need.
4. Copy the app's **Consumer Key** and **Consumer Secret**. Salesforce asks you to verify your
   identity first.

The flow works only against your **My Domain** address. See [Your My Domain](#your-my-domain)
below.

### On the server (the server administrator)

Install the package and tell the server about the app, one entry per app:

```bash
pip install "canvasxpress-connectors[salesforce]"
export CXC_SALESFORCE_APPS='{
  "default": {"domain": "acme.my", "client_id": "<consumer key>", "client_secret": "<consumer secret>",
              "users": ["alice", "bob"]}
}'
```

- `users` lists who may use the app. `"*"` allows everyone who can sign in; leaving `users` out
  allows nobody.
- Put the value in your secrets manager or a protected `.env` file. It is read on every request,
  so rotating the secret or editing `users` takes effect at once. Removing someone from `users`
  stops their sources immediately, including scheduled refreshes.
- Give different audiences different apps and integration users: everyone allowed to use an app
  can read whatever its Run As user can.
- To refuse stored Salesforce passwords on this server altogether, set
  `CXC_SALESFORCE_PASSWORD_AUTH=off`.

### Register the source (once)

Sign in, then register a source that **names the app**. `BASE` is the address of your dashboards
app (for example `https://example.com/dashboards`):

```bash
BASE=https://example.com/dashboards
read -s -p "Dashboards password: " PW; echo
curl -s -c jar -H 'Content-Type: application/json' \
     -d "{\"username\":\"admin\",\"password\":\"$PW\"}" $BASE/auth/login
curl -s -b jar -c jar $BASE/api/connectors/credentials | \
  curl -s -b jar -c jar -H 'Content-Type: application/json' -d @- $BASE/connectors/auth/login
curl -s -b jar -H 'Content-Type: application/json' -X POST $BASE/connectors/api/sources -d '{
  "name": "salesforce-opps",
  "kind": "salesforce",
  "soql": "SELECT Name, StageName, Amount, CloseDate, Account.Name FROM Opportunity",
  "oauth_app": "default"
}'
```

A source belongs to the user who registered it, so register it as the user who will build the
dashboard. `GET $BASE/connectors/api/salesforce/apps` lists the app names that user may choose,
never a key or secret.

## 3. Username, password and token

Use this only if you cannot use an OAuth app.

**What you need**

| Value | Where it comes from |
|---|---|
| `username` | The Salesforce user's login name (Setup → Users). It is often not the email address. |
| `password` | The user's Salesforce password. |
| `security_token` | Emailed when you use **Reset My Security Token** (avatar → Settings → My Personal Information). Case-sensitive. |
| `domain` | Your My Domain, as described below. |

**One-time setup for recently created orgs.** Salesforce turns SOAP `login()` off by default:

1. Setup → User Interface → turn on **Enable SOAP API login()**.
2. Setup → Permission Sets → New → System Permissions → check **Use Any API Auth** → assign the
   permission set to the integration user.
3. Changing the password issues a new token and the old one stops working. Reset the token
   after the last password change, and use the newest one. Logins from an IP range listed under
   Setup → Network Access don't need a token.

**Register it.** The same commands as above, with the login in place of `oauth_app`:

```bash
curl -s -b jar -H 'Content-Type: application/json' -X POST $BASE/connectors/api/sources -d '{
  "name": "salesforce-opps", "kind": "salesforce",
  "soql": "SELECT Name, StageName, Amount, CloseDate, Account.Name FROM Opportunity",
  "auth": {"username": "integration@acme.com", "password": "…", "security_token": "…", "domain": "acme.my"}
}'
```

The password and token are stored encrypted and are never shown again. To change them, register
the source again under the same name.

## Your My Domain

Sign in to Salesforce and read the address bar. Drop the trailing `.salesforce.com` (or
`.salesforce-setup.com` on Lightning Setup pages); what remains is the `domain`:

| Org type | Host in the browser | `domain` |
|---|---|---|
| Production | `acme.my.salesforce.com` | `acme.my` |
| Developer Edition | `acme-dev-ed.develop.my.salesforce.com` | `acme-dev-ed.develop.my` |
| Sandbox | `acme--uat.sandbox.my.salesforce.com` | `acme--uat.sandbox.my` |

Copy it character by character. A name that doesn't exist is **not** reported as a bad host:
Salesforce answers it with an HTML "Stay Tuned / We are setting things up" page (HTTP 420), which
looks like an org still being set up but is a typo. To check a host is real:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://acme.my.salesforce.com/services/data/   # 200
```

## 4. Use it in a dashboard

The source appears by name (`salesforce-opps`) where you choose data in the Builder: in each
panel's **Data** list and in the chat's dataset list. A dashboard refers to it like this:

```json
"data": { "opps": { "kind": "connector", "url": "/connectors/api/data?source=salesforce-opps",
                    "ttl": 60000, "refresh": 300 } }
```

`refresh` is in seconds. The first selected field becomes each record's id, numeric fields
become variables (`Amount`), and text and date fields become annotations (`StageName`,
`CloseDate`, `Account.Name`). Roll up in the chart, not in SOQL: a Bar with
`"groupingFactors": ["StageName"]` and `"summaryType": "sum"` gives amount by stage.

**Limits**

- Only `SELECT` queries run.
- **Aggregate functions** (`SUM()`, `COUNT()`) aren't supported: their columns are dropped from
  the result. Select the record fields and aggregate in the chart.
- The whole result set is returned, so keep the query selective with a `WHERE` or a `LIMIT`.

## Troubleshooting

When a login fails Salesforce reports only `INVALID_LOGIN`. The real reason is in **Setup →
Login History**, in the Status column on the row for your attempt:

| Status in Login History | What to do |
|---|---|
| Failed: SOAP Login Disabled | Password login only: turn on Enable SOAP API login() (step 1 of the one-time setup). |
| Failed: SOAP Login requires the Use Any API Auth user permission | Password login only: assign the permission set (step 2). |
| Invalid Password | The password and token aren't a matching pair. Reset the token after the last password change. |
| Password Lockout | Too many failures. Wait about 15 minutes. |

For an OAuth app the message comes straight back:

| Message | What to do |
|---|---|
| `…token request failed: client identifier invalid` | The consumer key is wrong. Copy it again from the Salesforce app. |
| `…HTTP 420 (the My Domain name … may not exist …)` | The `domain` in `CXC_SALESFORCE_APPS` is mistyped. |
| `Salesforce OAuth app '…' is not available to this user` (403) | The app name is wrong, or the user isn't in its `users` list. Both look the same on purpose. |
| `CXC_SALESFORCE_APPS is not valid JSON` (500) | Fix the server's setting. |

If the token request works but the query fails, the Run As user lacks access to that object or
field.

**A dashboard that refreshes** re-runs the login every interval. After changing a credential,
fix or remove the source promptly so failed logins don't pile up into a lockout.

**`ModuleNotFoundError: simple_salesforce`**: install the package in the same Python environment
that runs the server.
