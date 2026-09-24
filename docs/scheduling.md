# Scheduling: dataset refresh, alerts and emailed dashboards

The dashboards server (`cxd_server`) runs work on a schedule. There are three
kinds of schedule:

| Kind | Does |
|---|---|
| **Refresh** 🔄 | Re-pulls a stored dataset from where it comes from: a URL, or one of your database sources |
| **Alert** 🔔 | Checks a value in a dataset (for example the mean CRP at site A) and emails people when it crosses a threshold |
| **Subscription** 📧 | Emails a dashboard to people: a link to the live dashboard, plus a PNG snapshot |

Create them in the app's **Schedules** view. Shortcuts:

- **Dashboards → Subscribe** starts a subscription for that dashboard.
- **Data → ⏱** starts a refresh for that dataset.

Everything below is also available over the API.

**Rights.** Every schedule runs with the rights of the people involved, never
more:

- A refresh writes only its owner's dataset.
- An alert is evaluated **separately for each recipient**, on the rows and
  columns that recipient may see. That means their access plus the dataset's
  [row/column security](governance.md#row--and-column-level-security). An alert
  therefore never tells someone a value the rules hide from them.
- A subscription goes only to recipients who can open the dashboard. Its
  snapshot is rendered **as that recipient**, so each person sees their own data.

Creating schedules needs the `schedule.create` permission, which the `editor`
role has (see [roles](governance.md#roles-and-permissions)).

---

## When a schedule runs

Each schedule has a cron expression and the time zone it is read in. The
editor offers presets (every 15 minutes, every hour, every day, weekdays or
weekly at a time) and a custom field, and previews the next run times.

Cron has five fields: `minute hour day-of-month month day-of-week`.

| Expression | Runs |
|---|---|
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour, on the hour |
| `0 7 * * *` | Every day at 07:00 |
| `30 8 * * 1-5` | Weekdays at 08:30 |
| `0 8 * * mon` | Mondays at 08:00 |
| `0 6 1 * *` | The 1st of each month at 06:00 |
| `@hourly`, `@daily`, `@weekly`, `@monthly` | Shorthands |

The syntax:

- **Values:** `*`, numbers, ranges (`1-5`), steps (`*/10`, `0-30/10`), lists
  (`1,15`), and month and day names (`jan`, `mon`).
- **Day of week:** 0–7, where 0 and 7 are both Sunday.
- **Both days restricted:** as in cron, when day-of-month and day-of-week are
  both set, a day matching either one runs.

Times are read in the schedule's time zone, an IANA name such as
`Europe/Paris` (default: the browser's zone in the editor, UTC over the API).
Daylight-saving changes are handled, so "07:00" stays 07:00 local time.

**Run now** runs a schedule immediately without moving its next run. Each run
is kept in its **History** with its time, cause (`schedule`, `manual`, or
`after refresh`), result (`ok`, `warning` or `error`) and message. The newest
50 runs are kept per schedule.

---

## Refresh

Every run replaces the dataset's data. Its title, graph config and lock are
kept, so dashboards bound to it simply show the new data. If the dataset does
not exist yet, the first run creates it.

Where the data comes from:

- **A URL.** CSV (or TSV), JSON rows, or CanvasXpress JSON, reshaped exactly
  like an upload.
  - The format comes from the URL's extension, or can be chosen.
  - Downloads are capped at 50 MB.
  - The server refuses private and local addresses (and redirects to them), so a
    schedule cannot reach internal services. `CXD_FETCH_ALLOW_PRIVATE=1` lifts
    this for a trusted network.
- **A database source.** One of your sources under *Data → Database sources*,
  read with **your** stored credentials, exactly as a live connector panel reads
  it. This needs the host application to register a fetcher (see
  [Embedding](#embedding)); the demo app does.

**Alerts on the dataset** are checked right after each refresh, as well as on
their own schedule.

## Alerts

An alert rule has four parts:

- **Value:** the mean, sum, minimum or maximum of a column, or the number of
  rows.
- **Only rows where** (optional): a column equals a value.
- **Comparison:** above, at or above, below, at or below, equal to, or
  different from a threshold.
- **Recipients:** users and groups.

```jsonc
{ "kind": "alert", "name": "CRP high at site A", "cron": "*/15 * * * *", "tz": "UTC",
  "config": { "dataset": "labs", "aggregate": "mean", "measure": "CRP",
              "where": { "site": "A" }, "op": ">", "threshold": 12,
              "recipients": ["group:site-a-clinicians", "user:lead"] } }
```

**Per recipient.** Each recipient's value is computed on their own view of the
dataset. With a row rule "site-a staff see site A rows", a site-A member's mean
covers site A only.

- Recipients who cannot read the dataset are skipped.
- Recipients without an email address are counted in the run's message.

**Edge-triggered.** Recipients are emailed when the condition **becomes true**.
They are emailed again only after it has cleared and become true again, not on
every check.

## Subscriptions

A subscription emails a dashboard to its recipients on its schedule. Each email
holds:

- the dashboard's title and time;
- a **snapshot**, a PNG of the dashboard rendered as that recipient, when the
  server can render (below), otherwise the email carries the link only;
- a **link** to the live dashboard (needs `CXD_PUBLISH_BASE_URL`);
- a footer saying who subscribed them and when it repeats.

```jsonc
{ "kind": "subscription", "name": "Weekly trial board", "cron": "0 8 * * 1",
  "tz": "America/New_York",
  "config": { "dashboard": "trial-dash", "recipients": ["group:site-a"], "snapshot": true } }
```

For a dashboard shared with you, add `"dashboard_owner": "<owner>"`. For an
alert on a dataset shared with you, add `"dataset_owner"` the same way.

---

## Email addresses

Alerts and subscriptions go to the address on each user's profile. Users set
theirs at the top of the **Schedules** view (`PUT /api/me/profile`). Admins can
set anyone's (`POST /api/admin/users/{name}/email`).

## Server setup

| Variable | Default | Effect |
|---|---|---|
| `CXD_SCHEDULER` | `on` | `off` stops running schedules (they can still be created and run by hand) |
| `CXD_SCHEDULER_TICK` | `30` | Seconds between checks for due schedules |
| `CXD_SMTP_HOST` | (none: email off) | SMTP server |
| `CXD_SMTP_PORT` | `587` | |
| `CXD_SMTP_USER`, `CXD_SMTP_PASSWORD` | | Login, if the server needs one |
| `CXD_SMTP_FROM` | the user | Sender address |
| `CXD_SMTP_SECURITY` | `starttls` | `starttls`, `ssl` (port 465) or `none` |
| `CXD_PUBLISH_BASE_URL` | (none) | Public base URL, for links in emails (and share links) |
| `CXD_DASHBOARD_URL` | `{base}/view.html?id={id}&owner={owner}` | Link template for a dashboard |
| `CXD_SNAPSHOTS` | `on` | `off` sends links only |
| `CXD_INTERNAL_URL` | `http://127.0.0.1:<CXD_PORT>` | How the server reaches itself to render snapshots |
| `CXD_FETCH_ALLOW_PRIVATE` | `0` | `1` lets URL refreshes reach private addresses |

**Snapshots** need Playwright and Chromium on the server:

```bash
pip install playwright
playwright install --with-deps chromium
```

Without them, subscriptions send the link only; the Schedules view shows which
applies. A snapshot takes a few seconds per recipient.

**Several server processes.** Schedules live in the dashboards database
(`cxd_schedules`, `cxd_schedule_runs`, `cxd_alert_state`, `cxd_profiles`). Each
process claims a due schedule with a conditional update before running it, so
processes sharing one database never run it twice.

**Audit.** Creating, changing and deleting schedules and running them by hand
are recorded (`schedule.save`, `schedule.delete`, `schedule.run`), and so is
every scheduled run (`schedule.run` with its cause). See the
[audit log](governance.md#audit-log).

## Embedding

`create_dashboards_app()` accepts the scheduling pieces directly:

```python
from cxd_server.app import create_dashboards_app
from cxd_server.mailer import SmtpMailer

app = create_dashboards_app(
    mailer=SmtpMailer("smtp.example.org", 587, "bot@example.org", "…"),
    origin_fetchers={"connector": lambda owner, source: my_read(owner, source)},
    scheduler_enabled=True,
)
# or register a fetcher later:
app.state.origin_fetchers["connector"] = my_fetch
```

- **Origin fetcher:** returns the dataset as a 2D table or a CanvasXpress object,
  read with the owner's rights.
- **Mailer:** any object with `send([(to, subject, text, html, attachments)])`
  works. `MemoryMailer` keeps messages in a list, for tests.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/schedules/status` | What this server supports: `{enabled, scheduler, email, snapshots, links, origins, can_create, email_address}` |
| `GET` | `/api/schedules` | Your schedules (`?all=1`: an admin sees everyone's) |
| `POST` | `/api/schedules` | Create/update `{id?, kind, name, cron, tz, enabled, config}` |
| `DELETE` | `/api/schedules/{id}` | Delete |
| `POST` | `/api/schedules/{id}/run` | Run now → `{run, schedule}` |
| `GET` | `/api/schedules/{id}/runs` | Recent runs |
| `GET` | `/api/cron/preview?cron=&tz=&count=` | `{description, next}`: check an expression |
| `GET`·`PUT` | `/api/me/profile` | Your email address `{email}` |
| `POST` | `/api/admin/users/{name}/email` | Admin: set a user's address |

Client methods (`createDashboardClient`): `scheduleStatus`, `listSchedules`,
`saveSchedule`, `deleteSchedule`, `runSchedule`, `scheduleRuns`, `cronPreview`,
`getProfile`, `setProfile`, `setUserEmail`.
