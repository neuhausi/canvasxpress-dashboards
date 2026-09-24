"""What scheduled jobs do: refresh a dataset, check an alert, email a dashboard.

Every job runs with the rights of the people involved, never more:

* a **refresh** writes only its owner's dataset;
* an **alert** is evaluated separately for each recipient, on the rows and
  columns that recipient may see (their access plus the dataset's row/column
  security). A recipient is emailed only when *their* view crosses the
  threshold, so an alert never reveals a value the rules hide from them;
* a **subscription** is sent only to recipients who can open the dashboard,
  and its snapshot is rendered as that recipient.

Recipients are ``user:<name>`` or ``group:<name>``. They are emailed at the
address on their profile; people without one are skipped (and counted).
"""

from __future__ import annotations

import copy
import datetime
import html
import ipaddress
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

from .datasets import reshape_to_cx
from .scheduler import Cron, ScheduleError

AGGREGATES = ("mean", "sum", "min", "max", "count")
OPERATORS = {">": "above", ">=": "at or above", "<": "below", "<=": "at or below",
             "==": "equal to", "!=": "not equal to"}
FORMATS = ("csv", "json", "cx")


# ---- URL origins -------------------------------------------------------------------
def _check_host(url: str, allow_private: bool) -> None:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ScheduleError("Only http(s) URLs can be refreshed")
    if allow_private:
        return
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or None)
    except socket.gaierror:
        raise ScheduleError("Cannot resolve %s" % parts.hostname)
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
                or ip.is_multicast or ip.is_unspecified):
            raise ScheduleError("%s is a private or local address; the server will not fetch it"
                                % parts.hostname)


class _CheckedRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, allow_private: bool):
        self.allow_private = allow_private

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_host(newurl, self.allow_private)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_url(url: str, fmt: Optional[str] = None, allow_private: bool = False,
              max_bytes: int = 50 * 1024 * 1024, timeout: float = 60.0) -> Any:
    """Download a CSV/JSON dataset and reshape it like an upload.

    Private and local addresses (and redirects to them) are refused unless
    ``allow_private``, so a schedule cannot be used to reach internal services.
    """
    _check_host(url, allow_private)
    fmt = fmt or ("csv" if urllib.parse.urlsplit(url).path.lower().endswith((".csv", ".tsv"))
                  else "json")
    opener = urllib.request.build_opener(_CheckedRedirects(allow_private))
    request = urllib.request.Request(url, headers={"User-Agent": "cxd-server scheduled refresh"})
    try:
        with opener.open(request, timeout=timeout) as resp:
            body = resp.read(max_bytes + 1)
    except urllib.error.HTTPError as exc:
        raise ScheduleError("The URL answered HTTP %d" % exc.code)
    except (urllib.error.URLError, OSError) as exc:
        raise ScheduleError("Could not fetch the URL: %s" % getattr(exc, "reason", exc))
    if len(body) > max_bytes:
        raise ScheduleError("The download is larger than %d MB" % (max_bytes // (1024 * 1024)))
    text = body.decode("utf-8-sig", errors="replace")
    if fmt == "csv" and urllib.parse.urlsplit(url).path.lower().endswith(".tsv"):
        text = text.replace("\t", ",")
    try:
        return reshape_to_cx(fmt, text)
    except ValueError as exc:
        raise ScheduleError("The download is not valid %s: %s" % (fmt.upper(), exc))


# ---- alert values ----------------------------------------------------------------
def measure_value(data: Any, measure: Optional[str], aggregate: str,
                  where: Optional[Dict[str, str]] = None) -> Tuple[Optional[float], int]:
    """``(value, rows)``: the aggregate of a column over the rows matching ``where``.

    Works on a 2D table (header + records) and on CanvasXpress data (records are
    samples; ``where`` tests sample annotations). ``value`` is None when the
    column is missing or has no numbers (``count`` counts matching rows).
    """
    where = where or {}
    numbers: List[float] = []
    if isinstance(data, list) and data and isinstance(data[0], list):
        header = [str(h) for h in data[0]]
        rows = data[1:]
        for field, wanted in where.items():
            if field not in header:
                rows = []
                break
            col = header.index(field)
            rows = [r for r in rows if col < len(r) and str(r[col]) == str(wanted)]
        if aggregate == "count":
            return float(len(rows)), len(rows)
        if measure not in header:
            return None, len(rows)
        col = header.index(measure)
        numbers = [_num(r[col]) for r in rows if col < len(r)]
        count = len(rows)
    elif isinstance(data, dict) and isinstance(data.get("y"), dict):
        y, x = data["y"], data.get("x") or {}
        smps = y.get("smps") or []
        keep = list(range(len(smps)))
        for field, wanted in where.items():
            values = x.get(field)
            if not isinstance(values, list) or len(values) != len(smps):
                keep = []
                break
            keep = [i for i in keep if str(values[i]) == str(wanted)]
        if aggregate == "count":
            return float(len(keep)), len(keep)
        vars_ = y.get("vars") or []
        if measure not in vars_:
            return None, len(keep)
        row = (y.get("data") or [])[vars_.index(measure)]
        numbers = [_num(row[i]) for i in keep if i < len(row)]
        count = len(keep)
    else:
        return None, 0
    numbers = [n for n in numbers if n is not None]
    if not numbers:
        return None, count
    if aggregate == "sum":
        return sum(numbers), count
    if aggregate == "min":
        return min(numbers), count
    if aggregate == "max":
        return max(numbers), count
    return sum(numbers) / len(numbers), count


def _num(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def compare(value: float, op: str, threshold: float) -> bool:
    return {">": value > threshold, ">=": value >= threshold, "<": value < threshold,
            "<=": value <= threshold, "==": value == threshold,
            "!=": value != threshold}[op]


def fmt_number(value: float) -> str:
    if value == int(value) and abs(value) < 1e15:
        return "{:,}".format(int(value))
    return "{:,.4g}".format(value) if abs(value) < 1e6 else "{:,.0f}".format(value)


# ---- the jobs ----------------------------------------------------------------------
class Jobs:
    """Validates schedule configs and runs them. ``ctx`` supplies the server's
    stores and checks (see :func:`cxd_server.app.create_dashboards_app`)."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.run_related = None     # set by the app: run another schedule now

    # -- recipients ------------------------------------------------------------------
    def recipients(self, principals: List[str]) -> List[str]:
        users = set(self.ctx.list_users())
        groups = {g["name"]: g["members"] for g in self.ctx.governance.list_groups()}
        out: List[str] = []
        for p in principals:
            names = [p[5:]] if p.startswith("user:") else groups.get(p[6:], []) \
                if p.startswith("group:") else []
            for name in names:
                if name in users and name not in out:
                    out.append(name)
        return out

    def _check_recipients(self, value: Any) -> List[str]:
        if not isinstance(value, list) or not value:
            raise ScheduleError("Add at least one recipient (a user or a group)")
        users = set(self.ctx.list_users())
        groups = set(self.ctx.governance.group_names())
        out = []
        for p in value:
            ok = isinstance(p, str) and ((p.startswith("user:") and p[5:] in users)
                                         or (p.startswith("group:") and p[6:] in groups))
            if not ok:
                raise ScheduleError("No such user or group: %s" % p)
            if p not in out:
                out.append(p)
        return out

    # -- validation -------------------------------------------------------------------
    def validate(self, owner: str, kind: str, config: Any) -> Dict[str, Any]:
        """Check a schedule's config for ``owner`` and return its clean form."""
        if not isinstance(config, dict):
            raise ScheduleError("config must be an object")
        ctx = self.ctx
        if kind == "refresh":
            dataset = _id(config.get("dataset"), "dataset")
            origin = config.get("origin")
            if not isinstance(origin, dict) or origin.get("kind") not in ("url", "connector"):
                raise ScheduleError("origin must be {kind: \"url\", url} or "
                                    "{kind: \"connector\", source}")
            if origin["kind"] == "url":
                url = str(origin.get("url") or "").strip()
                if not url.startswith(("http://", "https://")):
                    raise ScheduleError("The origin URL must start with http:// or https://")
                fmt = origin.get("format") or None
                if fmt is not None and fmt not in FORMATS:
                    raise ScheduleError("format must be csv, json or cx")
                clean_origin = {"kind": "url", "url": url, "format": fmt}
            else:
                if "connector" not in ctx.origin_fetchers:
                    raise ScheduleError("This server cannot refresh from database connectors")
                clean_origin = {"kind": "connector", "source": _id(origin.get("source"), "source")}
            return {"dataset": dataset, "store": config.get("store") or None,
                    "title": (config.get("title") or "").strip()[:200] or None,
                    "origin": clean_origin}
        if kind == "alert":
            dataset = _id(config.get("dataset"), "dataset")
            ds_owner = config.get("dataset_owner") or owner
            store = config.get("store") or None
            if not ctx.dataset_access(owner, ds_owner, store, dataset):
                raise ScheduleError("You cannot read that dataset")
            aggregate = config.get("aggregate") or "mean"
            if aggregate not in AGGREGATES:
                raise ScheduleError("aggregate must be one of: " + ", ".join(AGGREGATES))
            measure = config.get("measure")
            if aggregate != "count" and not (isinstance(measure, str) and measure):
                raise ScheduleError("Pick the column to measure")
            op = config.get("op") or ">"
            if op not in OPERATORS:
                raise ScheduleError("op must be one of: " + " ".join(OPERATORS))
            try:
                threshold = float(config.get("threshold"))
            except (TypeError, ValueError):
                raise ScheduleError("threshold must be a number")
            where = config.get("where") or {}
            if not isinstance(where, dict) or not all(isinstance(v, (str, int, float))
                                                      for v in where.values()):
                raise ScheduleError("where is {column: value}")
            return {"dataset": dataset, "dataset_owner": ds_owner, "store": store,
                    "measure": measure if aggregate != "count" else None,
                    "aggregate": aggregate, "where": {str(k): str(v) for k, v in where.items()},
                    "op": op, "threshold": threshold,
                    "recipients": self._check_recipients(config.get("recipients"))}
        if kind == "subscription":
            dashboard = _id(config.get("dashboard"), "dashboard")
            dash_owner = config.get("dashboard_owner") or owner
            if not ctx.dashboard_access(owner, dash_owner, dashboard):
                raise ScheduleError("You cannot open that dashboard")
            return {"dashboard": dashboard, "dashboard_owner": dash_owner,
                    "snapshot": config.get("snapshot") is not False,
                    "recipients": self._check_recipients(config.get("recipients"))}
        raise ScheduleError("Unknown kind '%s'" % kind)

    # -- running ---------------------------------------------------------------------
    def __call__(self, schedule: Dict[str, Any], cause: str = "schedule"):
        kind = schedule["kind"]
        runner = {"refresh": self.refresh, "alert": self.alert,
                  "subscription": self.subscription}[kind]
        status, message, detail = "error", "", {}
        try:
            status, message, detail = runner(schedule, cause)
        except ScheduleError as exc:
            message = str(exc)
        finally:
            # A manual run is audited by the request that started it.
            if cause != "manual":
                self.ctx.audit.record(
                    "schedule.run", actor=None, target=schedule["id"], owner=schedule["owner"],
                    status=500 if status == "error" else 200,
                    detail=dict(detail or {}, kind=kind, cause=cause, status=status))
        return status, message, detail

    def refresh(self, schedule, cause):
        ctx, owner, cfg = self.ctx, schedule["owner"], schedule["config"]
        origin = cfg["origin"]
        if origin["kind"] == "url":
            data = fetch_url(origin["url"], origin.get("format"), ctx.allow_private)
        else:
            fetcher = ctx.origin_fetchers.get("connector")
            if fetcher is None:
                raise ScheduleError("This server cannot refresh from database connectors")
            data = fetcher(owner, origin["source"])
        ds = ctx.dataset_store_for(cfg.get("store"))
        existing = next((d for d in ds.list(owner) if d["id"] == cfg["dataset"]), None) or {}
        summary = ds.create(owner, data, ctx.now_iso(),
                            title=existing.get("title") or cfg.get("title") or cfg["dataset"],
                            dataset_id=cfg["dataset"], config=existing.get("config"),
                            locked=bool(existing.get("locked")))
        # Alerts on this dataset are checked right away.
        checked = 0
        key = ctx.store_key(cfg.get("store"))
        for other in ctx.schedules.list():
            ocfg = other["config"]
            if (other["kind"] == "alert" and other["enabled"]
                    and ocfg.get("dataset") == cfg["dataset"]
                    and (ocfg.get("dataset_owner") or other["owner"]) == owner
                    and ctx.store_key(ocfg.get("store")) == key and self.run_related):
                self.run_related(other, "after refresh")
                checked += 1
        message = "Refreshed “%s”: %d rows × %d columns" % (
            summary.get("title"), summary.get("rows") or 0, summary.get("cols") or 0)
        if checked:
            message += "; checked %d alert%s" % (checked, "" if checked == 1 else "s")
        return "ok", message, {"rows": summary.get("rows"), "cols": summary.get("cols"),
                               "alerts": checked}

    def alert(self, schedule, cause):
        ctx, cfg, sid = self.ctx, schedule["config"], schedule["id"]
        ds_owner, store, dataset = cfg["dataset_owner"], cfg.get("store"), cfg["dataset"]
        ds = ctx.dataset_store_for(store)
        data = ds.get(ds_owner, dataset)
        if data is None:
            raise ScheduleError("The dataset “%s” no longer exists" % dataset)
        title = next((d.get("title") for d in ds.list(ds_owner) if d["id"] == dataset), dataset)
        counts = {"recipients": 0, "true": 0, "newly_true": 0, "emailed": 0, "no_email": 0,
                  "no_access": 0}
        outgoing, pending = [], []
        for user in self.recipients(cfg["recipients"]):
            counts["recipients"] += 1
            if not ctx.dataset_access(user, ds_owner, store, dataset):
                counts["no_access"] += 1
                continue
            view = ctx.secured(data, user, ds_owner, store, dataset)
            value, rows = measure_value(view, cfg.get("measure"), cfg["aggregate"],
                                        cfg.get("where"))
            now_true = value is not None and compare(value, cfg["op"], cfg["threshold"])
            was_true = ctx.schedules.alert_active(sid, user)
            if not now_true:
                if was_true:
                    ctx.schedules.set_alert_active(sid, user, False)
                continue
            counts["true"] += 1
            if was_true:
                continue            # already told; again only after it clears
            counts["newly_true"] += 1
            email = ctx.schedules.email_of(user)
            if not email:
                counts["no_email"] += 1
                continue
            if not ctx.schedules.allow_send(user, getattr(ctx, "email_cap", 0)):
                counts["capped"] = counts.get("capped", 0) + 1
                continue
            outgoing.append(self._alert_email(schedule, email, user, title, value))
            pending.append(user)
        if outgoing:
            if ctx.mailer is None:
                return ("warning", "The alert is true for %d people, but email is not configured "
                        "(CXD_SMTP_HOST)" % len(outgoing), counts)
            counts["emailed"] = ctx.mailer.send(outgoing)
            for user in pending:
                ctx.schedules.set_alert_active(sid, user, True)
        message = "Checked for %d %s: true for %d, %d emailed" % (
            counts["recipients"], "person" if counts["recipients"] == 1 else "people",
            counts["true"], counts["emailed"])
        if counts["no_email"]:
            message += ", %d without a confirmed email address" % counts["no_email"]
        if counts.get("capped"):
            message += ", %d over today's email limit" % counts["capped"]
        if counts["no_access"]:
            message += ", %d cannot read the dataset" % counts["no_access"]
        return "ok", message, counts

    def _alert_email(self, schedule, email, user, title, value):
        cfg = schedule["config"]
        what = ("The number of rows" if cfg["aggregate"] == "count"
                else "The %s of %s" % (cfg["aggregate"], cfg["measure"]))
        if cfg.get("where"):
            what += " where " + ", ".join("%s = %s" % kv for kv in cfg["where"].items())
        sentence = "%s is %s, %s %s." % (what, fmt_number(value), OPERATORS[cfg["op"]],
                                         fmt_number(cfg["threshold"]))
        link = self.ctx.app_link()
        subject = "Alert: %s" % schedule["name"]
        footer = ("You get this because %s added you to the alert “%s”. You are emailed again "
                  "only after the condition clears and becomes true again."
                  % (schedule["owner"], schedule["name"]))
        text = "%s\n\n%s\nDataset: %s\n%s\n%s" % (
            schedule["name"], sentence, title, ("Open: " + link + "\n") if link else "", footer)
        body = ("<p style='font-size:16px'><b>%s</b></p><p>%s</p><p>Dataset: %s</p>%s"
                "<p style='color:#777;font-size:12px'>%s</p>") % (
            html.escape(schedule["name"]), html.escape(sentence), html.escape(str(title)),
            "<p><a href='%s'>Open CanvasXpress Dashboards</a></p>" % html.escape(link)
            if link else "", html.escape(footer))
        return (email, subject, text, body, [])

    def subscription(self, schedule, cause):
        ctx, cfg = self.ctx, schedule["config"]
        owner, dashboard = cfg["dashboard_owner"], cfg["dashboard"]
        spec = ctx.dashboards.get_dashboard(owner, dashboard)
        if spec is None:
            raise ScheduleError("The dashboard “%s” no longer exists" % dashboard)
        title = spec.get("title") or dashboard
        link = ctx.dashboard_link(owner, dashboard)
        use_snapshot = cfg.get("snapshot", True) and ctx.snapshots is not None \
            and ctx.snapshots.available()
        counts = {"recipients": 0, "emailed": 0, "no_email": 0, "no_access": 0,
                  "snapshots": 0, "snapshot_errors": 0}
        outgoing, errors = [], []
        for user in self.recipients(cfg["recipients"]):
            counts["recipients"] += 1
            if not ctx.dashboard_access(user, owner, dashboard):
                counts["no_access"] += 1
                continue
            email = ctx.schedules.email_of(user)
            if not email:
                counts["no_email"] += 1
                continue
            if not ctx.schedules.allow_send(user, getattr(ctx, "email_cap", 0)):
                counts["capped"] = counts.get("capped", 0) + 1
                continue
            png = None
            if use_snapshot:
                try:
                    view = copy.deepcopy(spec)
                    if user != owner:
                        for source in (view.get("data") or {}).values():
                            if isinstance(source, dict) and source.get("kind") == "dataset" \
                                    and not source.get("owner"):
                                source["owner"] = owner
                    png = ctx.snapshots.render(view, user)
                    counts["snapshots"] += 1
                except Exception as exc:  # noqa: BLE001 - fall back to a link-only email
                    counts["snapshot_errors"] += 1
                    errors.append(str(exc)[:200])
            outgoing.append(self._subscription_email(schedule, email, title, link, png))
        if outgoing and ctx.mailer is None:
            return ("warning", "%d people to email, but email is not configured (CXD_SMTP_HOST)"
                    % len(outgoing), counts)
        if outgoing:
            counts["emailed"] = ctx.mailer.send(outgoing)
        message = "Sent “%s” to %d of %d %s" % (title, counts["emailed"], counts["recipients"],
                                               "person" if counts["recipients"] == 1 else "people")
        extras = []
        if counts["snapshots"]:
            extras.append("with a snapshot")
        elif cfg.get("snapshot", True):
            extras.append("link only (snapshots unavailable)" if not use_snapshot
                          else "link only (snapshot failed: %s)" % (errors[0] if errors else "?"))
        if counts["no_email"]:
            extras.append("%d without a confirmed email address" % counts["no_email"])
        if counts.get("capped"):
            extras.append("%d over today's email limit" % counts["capped"])
        if counts["no_access"]:
            extras.append("%d cannot open it" % counts["no_access"])
        if not link:
            extras.append("no link: set CXD_PUBLISH_BASE_URL")
        if extras:
            message += " (" + "; ".join(extras) + ")"
        return "ok", message, counts

    def _subscription_email(self, schedule, email, title, link, png):
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        subject = "%s · %s" % (title, stamp[:10])
        footer = "You get this because %s subscribed you (“%s”, %s)." % (
            schedule["owner"], schedule["name"], Cron(schedule["cron"]).describe())
        text = "%s, as of %s.\n\n%s\n%s" % (title, stamp, ("Open the live dashboard: " + link)
                                            if link else "", footer)
        image = ""
        if png:
            image = ("<p><img src='cid:snapshot' alt='%s' style='max-width:100%%;"
                     "border:1px solid #ddd;border-radius:8px'/></p>" % html.escape(title))
        body = ("<p style='font-size:16px'><b>%s</b>, as of %s.</p>%s%s"
                "<p style='color:#777;font-size:12px'>%s</p>") % (
            html.escape(title), stamp, image,
            "<p><a href='%s'>Open the live dashboard</a></p>" % html.escape(link) if link else "",
            html.escape(footer))
        attachments = [("dashboard.png", png, "image/png", "snapshot")] if png else []
        return (email, subject, text, body, attachments)


def _id(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise ScheduleError("Pick the %s" % what)
    return value.strip()
