"""Scheduling: cron expressions, the schedule store, and the background runner.

A schedule belongs to a user and has a ``kind``:

``refresh``
    Re-pull a stored dataset from its origin (a URL, or a database connector).
``alert``
    Evaluate a rule on a dataset value and email the recipients when it becomes true.
``subscription``
    Email a dashboard (link, plus a PNG snapshot when available) to the recipients.

What a job does lives in :mod:`cxd_server.jobs`; this module decides *when*.
Times are stored in UTC (ISO-8601). Each schedule has a cron expression and
the time zone it is read in.

The runner is a daemon thread that wakes every ``tick`` seconds, runs the
schedules that are due, and moves each one's ``next_run`` forward. A job is
*claimed* with a conditional update before it runs, so several server
processes sharing one database never run the same job twice.
"""

from __future__ import annotations

import datetime
import json
import secrets
import threading
import traceback
from typing import Any, Callable, Dict, List, Optional, Set

try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None
    ZoneInfoNotFoundError = Exception

KINDS = ("refresh", "alert", "subscription")
UTC = datetime.timezone.utc

_SCHEMA = [
    "CREATE TABLE IF NOT EXISTS cxd_schedules ("
    " id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, name TEXT,"
    " cron TEXT NOT NULL, tz TEXT NOT NULL, config TEXT NOT NULL, enabled INTEGER NOT NULL,"
    " next_run TEXT, last_run TEXT, last_status TEXT, last_message TEXT,"
    " created_at TEXT, updated_at TEXT)",
    "CREATE TABLE IF NOT EXISTS cxd_schedule_runs ("
    " id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, started TEXT NOT NULL, finished TEXT,"
    " status TEXT NOT NULL, message TEXT, detail TEXT, cause TEXT)",
    "CREATE TABLE IF NOT EXISTS cxd_alert_state ("
    " schedule_id TEXT NOT NULL, recipient TEXT NOT NULL, active INTEGER NOT NULL,"
    " PRIMARY KEY (schedule_id, recipient))",
    "CREATE TABLE IF NOT EXISTS cxd_profiles ("
    " username TEXT PRIMARY KEY, email TEXT, verified INTEGER NOT NULL DEFAULT 0,"
    " token TEXT, token_sent TEXT)",
    "CREATE TABLE IF NOT EXISTS cxd_email_log ("
    " username TEXT NOT NULL, day TEXT NOT NULL, sent INTEGER NOT NULL,"
    " PRIMARY KEY (username, day))",
]

# Columns added after cxd_profiles first shipped (migrated on start).
_PROFILE_COLUMNS = [
    "ALTER TABLE cxd_profiles ADD COLUMN verified INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE cxd_profiles ADD COLUMN token TEXT",
    "ALTER TABLE cxd_profiles ADD COLUMN token_sent TEXT",
]
RESEND_SECONDS = 600

ALIASES = {
    "@hourly": "0 * * * *",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@weekly": "0 0 * * 0",
    "@monthly": "0 0 1 * *",
}
_DOW_NAMES = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}
_MONTH_NAMES = {m: i + 1 for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"))}


class ScheduleError(ValueError):
    """A schedule the scheduler rejects (bad cron, time zone, kind or config)."""


# ---- cron --------------------------------------------------------------------
class Cron:
    """A five-field cron expression: minute hour day-of-month month day-of-week.

    Fields accept ``*``, numbers, ranges (``1-5``), steps (``*/15``, ``0-30/10``),
    lists (``1,15``) and month/day names (``jan``, ``mon``). Day-of-week is 0-7
    (0 and 7 are Sunday). As in cron, when both day-of-month and day-of-week are
    restricted, a day matching either one runs. ``@hourly``, ``@daily``,
    ``@weekly`` and ``@monthly`` are accepted.
    """

    def __init__(self, expr: str):
        text = (expr or "").strip().lower()
        text = ALIASES.get(text, text)
        parts = text.split()
        if len(parts) != 5:
            raise ScheduleError("A cron expression has five fields: minute hour day month weekday")
        self.expr = " ".join(parts)
        self.minutes = _field(parts[0], 0, 59, {}, "minute")
        self.hours = _field(parts[1], 0, 23, {}, "hour")
        self.days = _field(parts[2], 1, 31, {}, "day of month")
        self.months = _field(parts[3], 1, 12, _MONTH_NAMES, "month")
        dows = _field(parts[4], 0, 7, _DOW_NAMES, "day of week")
        self.dows = {0 if d == 7 else d for d in dows}
        self._dom_any = parts[2] == "*"
        self._dow_any = parts[4] == "*"

    def _day_matches(self, day: datetime.date) -> bool:
        dom = day.day in self.days
        dow = (day.isoweekday() % 7) in self.dows
        if self._dom_any and self._dow_any:
            return True
        if self._dom_any:
            return dow
        if self._dow_any:
            return dom
        return dom or dow

    def next_after(self, when: datetime.datetime, tz: str = "UTC") -> datetime.datetime:
        """The first time strictly after ``when`` that matches, as an aware UTC datetime."""
        zone = zone_for(tz)
        local = when.astimezone(zone).replace(tzinfo=None, second=0, microsecond=0)
        t = local + datetime.timedelta(minutes=1)
        for _ in range(200000):
            if t.month not in self.months:
                year, month = (t.year + 1, 1) if t.month == 12 else (t.year, t.month + 1)
                t = datetime.datetime(year, month, 1)
                continue
            if not self._day_matches(t.date()):
                t = datetime.datetime(t.year, t.month, t.day) + datetime.timedelta(days=1)
                continue
            if t.hour not in self.hours:
                t = t.replace(minute=0) + datetime.timedelta(hours=1)
                continue
            if t.minute not in self.minutes:
                t = t + datetime.timedelta(minutes=1)
                continue
            result = t.replace(tzinfo=zone).astimezone(UTC)
            if result > when.astimezone(UTC):
                return result
            t = t + datetime.timedelta(minutes=1)
        raise ScheduleError("The cron expression '%s' never matches" % self.expr)

    def describe(self) -> str:
        """A short English reading of common expressions (else the expression)."""
        m, h, dom, mon, dow = self.expr.split()
        if self.expr == "* * * * *":
            return "every minute"
        if m.startswith("*/") and h == dom == mon == dow == "*":
            return "every %s minutes" % m[2:]
        if m.isdigit() and h == dom == mon == dow == "*":
            return "every hour at :%02d" % int(m)
        if m.isdigit() and h.isdigit() and dom == mon == "*":
            at = "%02d:%02d" % (int(h), int(m))
            if dow == "*":
                return "every day at " + at
            if dow in ("1-5", "mon-fri"):
                return "weekdays at " + at
            days = sorted(self.dows)
            names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
            return "every " + ", ".join(names[d] for d in days) + " at " + at
        if m.isdigit() and h.isdigit() and dom.isdigit() and mon == dow == "*":
            return "monthly on day %s at %02d:%02d" % (dom, int(h), int(m))
        return "cron " + self.expr


def _field(text: str, low: int, high: int, names: Dict[str, int], label: str) -> Set[int]:
    values: Set[int] = set()
    for part in text.split(","):
        step = 1
        if "/" in part:
            part, step_text = part.split("/", 1)
            if not step_text.isdigit() or int(step_text) < 1:
                raise ScheduleError("Bad step in the %s field" % label)
            step = int(step_text)
        if part == "*":
            start, end = low, high
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = _value(a, names, label), _value(b, names, label)
        else:
            start = end = _value(part, names, label)
            if step != 1:
                end = high
        if not (low <= start <= high and low <= end <= high and start <= end):
            raise ScheduleError("The %s field must be within %d-%d" % (label, low, high))
        values.update(range(start, end + 1, step))
    return values


def _value(text: str, names: Dict[str, int], label: str) -> int:
    if text in names:
        return names[text]
    if not text.isdigit():
        raise ScheduleError("Bad value '%s' in the %s field" % (text, label))
    return int(text)


def zone_for(tz: Optional[str]):
    """The tzinfo for an IANA name (``UTC`` when empty)."""
    if not tz or tz.upper() == "UTC":
        return UTC
    if ZoneInfo is None:  # pragma: no cover
        raise ScheduleError("Time zones need Python 3.9+; use UTC")
    try:
        return ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise ScheduleError("Unknown time zone '%s'" % tz)


def now_utc() -> datetime.datetime:
    return datetime.datetime.now(UTC)


def iso(when: Optional[datetime.datetime]) -> Optional[str]:
    return when.astimezone(UTC).isoformat(timespec="seconds") if when else None


def parse_iso(text: Optional[str]) -> Optional[datetime.datetime]:
    if not text:
        return None
    value = datetime.datetime.fromisoformat(text)
    return value if value.tzinfo else value.replace(tzinfo=UTC)


# ---- the store ---------------------------------------------------------------
class ScheduleStore:
    """Schedules, their run history, alert state, and user email addresses."""

    def __init__(self, db, verify_emails: bool = True):
        self._db = db
        self.verify_emails = verify_emails
        self._db.run([(sql, {}) for sql in _SCHEMA])
        for sql in _PROFILE_COLUMNS:
            try:
                self._db.run([(sql, {})])
            except Exception:  # noqa: BLE001 - the column already exists
                pass

    # schedules
    def list(self, owner: Optional[str] = None) -> List[Dict[str, Any]]:
        if owner is None:
            rows = self._db.query("SELECT * FROM cxd_schedules ORDER BY owner, name")
        else:
            rows = self._db.query("SELECT * FROM cxd_schedules WHERE owner = :o ORDER BY name",
                                  {"o": owner})
        return [_public(r) for r in rows]

    def get(self, schedule_id: str) -> Optional[Dict[str, Any]]:
        rows = self._db.query("SELECT * FROM cxd_schedules WHERE id = :i", {"i": schedule_id})
        return _public(rows[0]) if rows else None

    def save(self, owner: str, kind: str, name: str, cron: str, tz: str, config: Dict[str, Any],
             enabled: bool = True, schedule_id: Optional[str] = None,
             now: Optional[datetime.datetime] = None) -> Dict[str, Any]:
        """Create or update a schedule (validating kind, cron and time zone)."""
        if kind not in KINDS:
            raise ScheduleError("kind must be one of: " + ", ".join(KINDS))
        tz = tz or "UTC"
        now = now or now_utc()
        next_run = Cron(cron).next_after(now, tz)
        existing = self.get(schedule_id) if schedule_id else None
        if existing and existing["owner"] != owner:
            raise ScheduleError("That schedule belongs to someone else")
        params = {"i": schedule_id or secrets.token_hex(6), "o": owner, "k": kind,
                  "n": (name or kind).strip()[:120], "c": Cron(cron).expr, "z": tz,
                  "cfg": json.dumps(config or {}), "e": 1 if enabled else 0,
                  "nr": iso(next_run) if enabled else None, "t": iso(now)}
        if existing:
            self._db.run([(
                "UPDATE cxd_schedules SET kind = :k, name = :n, cron = :c, tz = :z,"
                " config = :cfg, enabled = :e, next_run = :nr, updated_at = :t WHERE id = :i",
                params)])
        else:
            self._db.run([(
                "INSERT INTO cxd_schedules (id, owner, kind, name, cron, tz, config, enabled,"
                " next_run, created_at, updated_at)"
                " VALUES (:i, :o, :k, :n, :c, :z, :cfg, :e, :nr, :t, :t)", params)])
        return self.get(params["i"])

    def delete(self, schedule_id: str) -> bool:
        if not self.get(schedule_id):
            return False
        self._db.run([
            ("DELETE FROM cxd_schedules WHERE id = :i", {"i": schedule_id}),
            ("DELETE FROM cxd_schedule_runs WHERE schedule_id = :i", {"i": schedule_id}),
            ("DELETE FROM cxd_alert_state WHERE schedule_id = :i", {"i": schedule_id}),
        ])
        return True

    def forget_user(self, username: str) -> None:
        for s in self.list(username):
            self.delete(s["id"])
        self._db.run([("DELETE FROM cxd_profiles WHERE username = :u", {"u": username}),
                      ("DELETE FROM cxd_email_log WHERE username = :u", {"u": username})])

    def due(self, now: datetime.datetime) -> List[Dict[str, Any]]:
        rows = self._db.query(
            "SELECT * FROM cxd_schedules WHERE enabled = 1 AND next_run IS NOT NULL"
            " AND next_run <= :now ORDER BY next_run", {"now": iso(now)})
        return [_public(r) for r in rows]

    def claim(self, schedule: Dict[str, Any], now: datetime.datetime) -> bool:
        """Move a due schedule's next_run forward; True for the one caller that wins."""
        following = Cron(schedule["cron"]).next_after(now, schedule["tz"])
        return self._db.execute(
            "UPDATE cxd_schedules SET next_run = :new WHERE id = :i AND next_run = :old",
            {"new": iso(following), "i": schedule["id"], "old": schedule["next_run"]}) == 1

    def record_run(self, schedule_id: str, started: datetime.datetime,
                   finished: datetime.datetime, status: str, message: str,
                   detail: Optional[Dict[str, Any]] = None, trigger: str = "schedule",
                   keep: int = 50) -> Dict[str, Any]:
        run = {"id": secrets.token_hex(8), "schedule_id": schedule_id, "started": iso(started),
               "finished": iso(finished), "status": status, "message": (message or "")[:500],
               "detail": json.dumps(detail or {}), "cause": trigger}
        self._db.run([
            ("INSERT INTO cxd_schedule_runs (id, schedule_id, started, finished, status,"
             " message, detail, cause) VALUES (:id, :schedule_id, :started, :finished,"
             " :status, :message, :detail, :cause)", run),
            ("UPDATE cxd_schedules SET last_run = :started, last_status = :status,"
             " last_message = :message WHERE id = :schedule_id", run),
        ])
        # Keep the newest runs only.
        old = self._db.query(
            "SELECT id FROM cxd_schedule_runs WHERE schedule_id = :i ORDER BY started DESC",
            {"i": schedule_id})[keep:]
        if old:
            self._db.run([("DELETE FROM cxd_schedule_runs WHERE id = :r", {"r": r["id"]})
                          for r in old])
        return dict(run, detail=detail or {})

    def runs(self, schedule_id: str, limit: int = 20) -> List[Dict[str, Any]]:
        rows = self._db.query(
            "SELECT * FROM cxd_schedule_runs WHERE schedule_id = :i ORDER BY started DESC",
            {"i": schedule_id})[:max(1, min(int(limit), 50))]
        return [dict(r, detail=_json(r.get("detail"), {})) for r in rows]

    # alert state (edge-triggered per recipient)
    def alert_active(self, schedule_id: str, recipient: str) -> bool:
        rows = self._db.query("SELECT active FROM cxd_alert_state WHERE schedule_id = :i"
                              " AND recipient = :r", {"i": schedule_id, "r": recipient})
        return bool(rows and rows[0]["active"])

    def set_alert_active(self, schedule_id: str, recipient: str, active: bool) -> None:
        self._db.run([(
            "INSERT INTO cxd_alert_state (schedule_id, recipient, active) VALUES (:i, :r, :a)"
            " ON CONFLICT (schedule_id, recipient) DO UPDATE SET active = excluded.active",
            {"i": schedule_id, "r": recipient, "a": 1 if active else 0})])

    # profiles (the addresses alerts and subscriptions go to)
    def profile(self, username: str) -> Dict[str, Any]:
        rows = self._db.query("SELECT email, verified FROM cxd_profiles WHERE username = :u",
                              {"u": username})
        email = rows[0]["email"] if rows and rows[0]["email"] else None
        return {"email": email, "verified": bool(email and rows[0]["verified"])}

    def email_of(self, username: str) -> Optional[str]:
        """The address to send to: set, and verified unless verification is off."""
        p = self.profile(username)
        if p["email"] and (p["verified"] or not self.verify_emails):
            return p["email"]
        return None

    def profiles(self) -> Dict[str, Dict[str, Any]]:
        return {r["username"]: {"email": r["email"], "verified": bool(r["verified"])}
                for r in self._db.query("SELECT username, email, verified FROM cxd_profiles")
                if r["email"]}

    def emails(self) -> Dict[str, str]:
        return {u: p["email"] for u, p in self.profiles().items()}

    def set_email(self, username: str, email: Optional[str], verified: bool = False
                  ) -> Optional[str]:
        """Set (or clear) an address. An unverified one gets a fresh confirmation token."""
        email = (email or "").strip()
        if email and (len(email) > 254 or "@" not in email or " " in email
                      or email.startswith("@") or email.endswith("@")):
            raise ScheduleError("That does not look like an email address")
        current = self.profile(username)
        if email and email == current["email"] and current["verified"]:
            return email                      # unchanged and already confirmed
        self._db.run([(
            "INSERT INTO cxd_profiles (username, email, verified, token, token_sent)"
            " VALUES (:u, :e, :v, :t, NULL) ON CONFLICT (username) DO UPDATE SET"
            " email = excluded.email, verified = excluded.verified, token = excluded.token,"
            " token_sent = NULL",
            {"u": username, "e": email or None, "v": 1 if (email and verified) else 0,
             "t": None if (not email or verified) else secrets.token_urlsafe(24)})])
        return email or None

    def confirmation_token(self, username: str, now: datetime.datetime) -> Optional[str]:
        """The token to email for confirming the user's address, at most once every
        ten minutes; None when there is nothing to confirm or it is too soon."""
        rows = self._db.query("SELECT email, verified, token, token_sent FROM cxd_profiles"
                              " WHERE username = :u", {"u": username})
        if not rows or not rows[0]["email"] or rows[0]["verified"] or not rows[0]["token"]:
            return None
        last = parse_iso(rows[0]["token_sent"])
        if last and (now - last).total_seconds() < RESEND_SECONDS:
            return None
        self._db.run([("UPDATE cxd_profiles SET token_sent = :t WHERE username = :u",
                       {"t": iso(now), "u": username})])
        return rows[0]["token"]

    def verify_token(self, token: str) -> Optional[str]:
        """Confirm the address a token was sent to; returns its user (None if unknown)."""
        if not token:
            return None
        rows = self._db.query("SELECT username FROM cxd_profiles WHERE token = :t",
                              {"t": token})
        if not rows:
            return None
        self._db.run([("UPDATE cxd_profiles SET verified = 1, token = NULL WHERE token = :t",
                       {"t": token})])
        return rows[0]["username"]

    def allow_send(self, username: str, cap: int, now: Optional[datetime.datetime] = None
                   ) -> bool:
        """Count one email to ``username`` today; False once the daily cap is reached."""
        if cap <= 0:
            return True
        day = (now or now_utc()).strftime("%Y-%m-%d")
        rows = self._db.query("SELECT sent FROM cxd_email_log WHERE username = :u AND day = :d",
                              {"u": username, "d": day})
        sent = rows[0]["sent"] if rows else 0
        if sent >= cap:
            return False
        self._db.run([(
            "INSERT INTO cxd_email_log (username, day, sent) VALUES (:u, :d, 1)"
            " ON CONFLICT (username, day) DO UPDATE SET sent = cxd_email_log.sent + 1",
            {"u": username, "d": day})])
        return True


def _public(row: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(row)
    out["config"] = _json(row.get("config"), {})
    out["enabled"] = bool(row.get("enabled"))
    try:
        out["description"] = Cron(row["cron"]).describe()
    except ScheduleError:
        out["description"] = row.get("cron")
    return out


def _json(text: Optional[str], default: Any) -> Any:
    try:
        return json.loads(text) if text else default
    except ValueError:
        return default


# ---- the runner --------------------------------------------------------------
class Scheduler:
    """Runs due schedules through ``run_job(schedule, trigger) -> (status, message, detail)``."""

    def __init__(self, store: ScheduleStore, run_job: Callable[..., Any], tick: float = 30.0):
        self.store = store
        self._run_job = run_job
        self.tick = max(1.0, float(tick))
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def run_now(self, schedule: Dict[str, Any], trigger: str = "manual") -> Dict[str, Any]:
        """Run one schedule immediately and record the run."""
        started = now_utc()
        try:
            status, message, detail = self._run_job(schedule, trigger)
        except Exception as exc:  # noqa: BLE001 - a failing job is recorded, never raised
            status, message, detail = "error", "%s: %s" % (type(exc).__name__, exc), {}
            print("[scheduler] job %s failed:\n%s" % (schedule.get("id"), traceback.format_exc()),
                  flush=True)
        return self.store.record_run(schedule["id"], started, now_utc(), status, message,
                                     detail, trigger)

    def run_due(self, now: Optional[datetime.datetime] = None) -> List[Dict[str, Any]]:
        """Run every due schedule this process manages to claim."""
        now = now or now_utc()
        done = []
        for schedule in self.store.due(now):
            if self.store.claim(schedule, now):
                done.append(self.run_now(schedule, "schedule"))
        return done

    def start(self) -> None:
        if self.running:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="cxd-scheduler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_due()
            except Exception:  # noqa: BLE001 - the loop must survive a bad tick
                print("[scheduler] tick failed:\n" + traceback.format_exc(), flush=True)
            self._stop.wait(self.tick)
