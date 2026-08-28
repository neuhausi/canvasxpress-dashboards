"""Register live database sources for the dashboards server — zero config.

    python examples/register_db_sources.py sources.json
    python examples/register_db_sources.py sources.json --user alice

This talks to the SAME `/connectors` store the running dashboards server uses
(``examples/.cxd-demo/connectors.db``, encrypted with the server's key), so a
source you register here immediately backs a ``kind:"connector"`` panel at
``/connectors/api/data?source=<name>``. The big database files stay wherever
they already live on the server — only their (encrypted) connection URL + SQL
are stored.

Config (JSON) — the ``user`` must be the dashboards login that will view the
sources (the app bridges the session: connectors user = dashboards user):

    {
      "user": "alice",
      "sources": [
        { "name": "sales",
          "path": "/srv/cxd-data/sales.sqlite",
          "sql":  "SELECT sample, revenue FROM sales
                   WHERE (:region IS NULL OR region = :region) ORDER BY sample" },
        { "name": "genes",
          "url":  "sqlite:///file:/srv/cxd-data/genes.sqlite?mode=ro&uri=true",
          "sql_file": "queries/genes.sql" }
      ]
    }

Declare ``:name`` bind parameters in the SQL and a dashboard control drives them
via ``"query": { "region": "$region" }`` — see docs/live-data-controls.md. No
server restart is needed; the change is live on the next request.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server", "src"))

# The same data dir + files serve.py uses for the mounted connectors store.
DATA_DIR = os.path.join(HERE, ".cxd-demo")
STORE_DB = os.path.join(DATA_DIR, "connectors.db")
KEY_FILE = os.path.join(DATA_DIR, "encryption.key")


def _load_env_file(path: str) -> None:
    """Load KEY=VALUE lines from a .env (already-set env wins), mirroring
    serve.py so ENCRYPTION_KEY set there is honored."""
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass


def _resolve_key() -> str:
    """The connectors store's Fernet key, resolved exactly as serve.py does:
    ENCRYPTION_KEY from env/.env if set, else the persisted key file."""
    _load_env_file(os.path.join(ROOT, ".env"))
    if os.environ.get("ENCRYPTION_KEY"):
        return os.environ["ENCRYPTION_KEY"]
    if os.path.isfile(KEY_FILE):
        with open(KEY_FILE, encoding="utf-8") as handle:
            return handle.read().strip()
    raise SystemExit(
        "No ENCRYPTION_KEY set and no %s found. Start the server once (it "
        "generates the key), or set ENCRYPTION_KEY in %s."
        % (KEY_FILE, os.path.join(ROOT, ".env"))
    )


def _sqlite_ro_url(path: str) -> str:
    return "sqlite:///file:" + os.path.abspath(path) + "?mode=ro&uri=true"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("config", help="Path to the JSON config file.")
    parser.add_argument("--user", help="Override the config's 'user'.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Validate and print, but write nothing.")
    args = parser.parse_args(argv)

    from cx_connectors.sources.sql import SqlSource, bind_param_names
    from cx_connectors.store import Store

    with open(args.config, encoding="utf-8") as handle:
        config = json.load(handle)
    config_dir = os.path.dirname(os.path.abspath(args.config))
    user = args.user or config.get("user")
    if not user:
        parser.error("no user: add 'user' to the config or pass --user")

    key = _resolve_key()
    store = Store(STORE_DB, key)

    tag = "[dry-run] " if args.dry_run else ""
    print("%sregistering %d source(s) for user %r into %s"
          % (tag, len(config.get("sources") or []), user, STORE_DB))

    for entry in config.get("sources") or []:
        name = entry.get("name")
        if not name:
            parser.error("every source needs a 'name'")
        if entry.get("url"):
            url = entry["url"]
        elif entry.get("path"):
            url = _sqlite_ro_url(entry["path"])
        else:
            parser.error("source %r needs 'url' or 'path'" % name)

        # A 'packed' source (CCLE/TCGA expression) carries a config, not SQL.
        if entry.get("kind") == "packed":
            cfg = entry.get("config")
            if not (isinstance(cfg, dict) and cfg.get("table") and cfg.get("value_col")
                    and cfg.get("template_key")):
                parser.error("packed source %r needs config with table/value_col/template_key" % name)
            print("  %-24s [packed] gene_param=%s" % (name, cfg.get("gene_param", "genes")))
            if not args.dry_run:
                store.save_source(user, name, url, "", kind="packed", config=cfg)
            continue

        if entry.get("sql"):
            sql = entry["sql"]
        elif entry.get("sql_file"):
            with open(os.path.join(config_dir, entry["sql_file"]), encoding="utf-8") as fh:
                sql = fh.read()
        else:
            parser.error("source %r needs 'sql', 'sql_file', or kind 'packed'" % name)

        SqlSource(url, sql)   # validates single read-only SELECT
        binds = bind_param_names(sql)
        print("  %-24s params=%s" % (name, binds or "(none)"))
        if not args.dry_run:
            store.save_source(user, name, url, sql)

    print("%sdone. Point a panel at /connectors/api/data?source=<name>." % tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
