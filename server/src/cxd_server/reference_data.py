"""Install and verify the large reference databases (``cxd-reference-data``).

The science dashboards read read-only SQLite reference databases (GENCODE 93 MB,
GTEx 4.1 GB, and CCLE / TCGA / WikiPathways) from ``CXD_SQLITE_DIR``. These files
are far too large to ship in the wheel, and a pharma install is frequently
**air-gapped**, so this CLI supports the offline path first:

    cxd-reference-data status              # what is installed in CXD_SQLITE_DIR
    cxd-reference-data verify gencode      # a dropped file is readable + well-formed
    cxd-reference-data fetch gencode       # download it (only on a box with egress)

**Air-gapped (the common case):** an admin copies ``<db>.sqlite`` into
``CXD_SQLITE_DIR`` by hand (USB, approved transfer), runs ``verify`` to prove the
file is intact, then sets ``CXD_REFERENCE_SOURCES=on`` and restarts. No network.

**Egress available:** ``fetch`` downloads ``<db>.sqlite`` (and, when present, its
``.sha256`` sidecar) from ``CXD_REFERENCE_DATA_BASE_URL`` — host-agnostic: the
operator points it at wherever the artifacts are published (a release, object
storage, canvasxpress.org). Streamed to a temp file, checksum-verified, then
moved into place, so an interrupted download never leaves a half-written db.

Only GENCODE/GTEx (open-access, redistributable) are published by default; see the
reference-data distribution plan for TCGA/CCLE licensing.
"""

import argparse
import hashlib
import os
import sqlite3
import sys
import tempfile

from . import reference_services as _svc

# A representative subset of each database's tables — enough for `verify` to
# catch a truncated, empty, or wrong-schema drop without asserting the full schema.
KNOWN_TABLES = {
    "gencode": ("genome", "gwas"),
    "gtex": ("expression", "samples", "json"),
    "tcga": ("sample", "rnaseq", "mutation", "gene"),
    "ccle": ("rnaseq", "cnv", "mutation", "gene"),
    "wp": ("pathway", "members", "gene"),
}

# Databases whose prebuilt artifacts are openly redistributable, so `fetch`
# offers them by default. (TCGA/CCLE: verify tiers before publishing — see plan.)
REDISTRIBUTABLE = ("gencode", "gtex", "wp")

_CHUNK = 1 << 20  # 1 MiB streaming reads


def sha256_file(path):
    """Hex SHA-256 of a file, read in streaming chunks (handles multi-GB files)."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def tables_in(path):
    """The table names in a SQLite file, opened strictly read-only.

    :raises sqlite3.DatabaseError: When the file is not a valid SQLite database.
    """
    con = sqlite3.connect("file:%s?mode=ro" % path, uri=True)
    try:
        return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        con.close()


def verify(db):
    """Check reference database ``db`` is present and well-formed.

    :param db: One of :data:`cxd_server.reference_services.REFERENCE_DBS`.
    :returns: ``(ok, detail)`` — ``ok`` True when the file exists, opens, and
        holds every table in :data:`KNOWN_TABLES`; ``detail`` explains a failure
        (missing file, unreadable, or the missing tables).
    """
    if db not in _svc.REFERENCE_DBS:
        return False, "unknown database %r (known: %s)" % (db, ", ".join(_svc.REFERENCE_DBS))
    path = _svc.db_path(db)
    if not os.path.isfile(path):
        return False, "not installed: %s" % path
    try:
        present = tables_in(path)
    except sqlite3.DatabaseError as exc:
        return False, "not a valid SQLite database (%s): %s" % (exc, path)
    missing = [t for t in KNOWN_TABLES.get(db, ()) if t not in present]
    if missing:
        return False, "missing expected tables: %s" % ", ".join(missing)
    return True, path


def status(dir_path=None):
    """Installed-state of every reference database in the data directory.

    :param dir_path: The data directory (defaults to ``CXD_SQLITE_DIR``).
    :returns: A list of ``{db, path, present, bytes, ok, detail}`` dicts.
    """
    rows = []
    for db in _svc.REFERENCE_DBS:
        path = _svc.db_path(db)
        present = os.path.isfile(path)
        ok, detail = (verify(db) if present else (False, "not installed"))
        rows.append({"db": db, "path": path, "present": present,
                     "bytes": os.path.getsize(path) if present else 0,
                     "ok": ok, "detail": detail})
    return rows


def _human(n):
    """A byte count as a short human string (e.g. ``4.1 GB``)."""
    size = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return ("%d %s" % (size, unit)) if unit == "B" else ("%.1f %s" % (size, unit))
        size /= 1024


def base_url(env=None):
    """The configured artifact base URL (``CXD_REFERENCE_DATA_BASE_URL``), or None."""
    env = os.environ if env is None else env
    url = (env.get("CXD_REFERENCE_DATA_BASE_URL") or "").strip()
    return url.rstrip("/") or None


def fetch(db, dest_dir=None, url_base=None, progress=None):
    """Download ``<db>.sqlite`` into the data directory, verifying its checksum.

    Only for a host WITH network egress; an air-gapped install uses a manual drop
    + :func:`verify` instead. The file is streamed to a temp file in the same
    directory, checked against the ``<db>.sqlite.sha256`` sidecar when the server
    publishes one, then atomically moved into place.

    :param db: The database to fetch (must be redistributable or explicitly known).
    :param dest_dir: Target directory (defaults to ``CXD_SQLITE_DIR``).
    :param url_base: Artifact base URL (defaults to ``CXD_REFERENCE_DATA_BASE_URL``).
    :param progress: Optional ``callback(got_bytes, total_bytes_or_None)``.
    :returns: The installed path.
    :raises ValueError: Unknown db, no base URL, or a checksum mismatch.
    """
    from urllib.request import urlopen

    if db not in _svc.REFERENCE_DBS:
        raise ValueError("unknown database %r" % db)
    url_base = url_base or base_url()
    if not url_base:
        raise ValueError("no artifact source: set CXD_REFERENCE_DATA_BASE_URL (or pass --url-base)")
    dest_dir = dest_dir or _svc.SQLITE_DIR
    os.makedirs(dest_dir, exist_ok=True)
    final = os.path.join(dest_dir, db + ".sqlite")
    src = "%s/%s.sqlite" % (url_base, db)

    expected = _try_read_sha(url_base, db)
    digest = hashlib.sha256()
    fd, tmp = tempfile.mkstemp(prefix="." + db + ".", suffix=".part", dir=dest_dir)
    try:
        with os.fdopen(fd, "wb") as out, urlopen(src) as resp:  # noqa: S310 - operator-set URL
            total = resp.length if getattr(resp, "length", None) else None
            got = 0
            for block in iter(lambda: resp.read(_CHUNK), b""):
                out.write(block)
                digest.update(block)
                got += len(block)
                if progress:
                    progress(got, total)
        if expected and digest.hexdigest() != expected:
            raise ValueError("checksum mismatch for %s (expected %s, got %s)"
                             % (db, expected, digest.hexdigest()))
        os.replace(tmp, final)
        return final
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _try_read_sha(url_base, db):
    """The published hex SHA-256 for ``<db>.sqlite`` (the ``.sha256`` sidecar), or
    None when the server publishes none. A sidecar may be ``<hash>`` or
    ``<hash>  <filename>`` (the ``sha256sum`` format)."""
    from urllib.error import URLError
    from urllib.request import urlopen

    try:
        with urlopen("%s/%s.sqlite.sha256" % (url_base, db)) as resp:  # noqa: S310
            text = resp.read(200).decode("utf-8", "replace").strip()
    except (URLError, OSError):
        return None
    token = text.split()[0] if text else ""
    return token.lower() if len(token) == 64 and all(c in "0123456789abcdef" for c in token.lower()) else None


def main(argv=None):
    """CLI entry point for ``cxd-reference-data`` (status / verify / fetch)."""
    parser = argparse.ArgumentParser(
        prog="cxd-reference-data",
        description="Install and verify the reference databases the science dashboards read "
                    "(from CXD_SQLITE_DIR). Air-gapped: drop <db>.sqlite in, then `verify`.")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("status", help="show which reference databases are installed")
    v = sub.add_parser("verify", help="check a dropped-in database is readable + well-formed")
    v.add_argument("db", help="database name (or 'all')")
    f = sub.add_parser("fetch", help="download a database (needs egress + CXD_REFERENCE_DATA_BASE_URL)")
    f.add_argument("db", help="database name")
    f.add_argument("--url-base", default=None, help="artifact base URL (else CXD_REFERENCE_DATA_BASE_URL)")
    f.add_argument("--dir", default=None, help="target directory (else CXD_SQLITE_DIR)")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    if args.cmd == "status":
        print("Reference databases in %s:\n" % _svc.SQLITE_DIR)
        for row in status():
            mark = "ok " if row["ok"] else ("!! " if row["present"] else "-- ")
            size = _human(row["bytes"]) if row["present"] else ""
            print("  %s %-8s %-10s %s" % (mark, row["db"], size, "" if row["ok"] else row["detail"]))
        return 0

    if args.cmd == "verify":
        targets = _svc.REFERENCE_DBS if args.db == "all" else (args.db,)
        bad = 0
        for db in targets:
            ok, detail = verify(db)
            print("  %s %-8s %s" % ("ok " if ok else "!! ", db, "" if ok else detail))
            bad += 0 if ok else 1
        return 1 if bad else 0

    if args.cmd == "fetch":
        # On a terminal, animate one line with \r. When output is redirected (a
        # log, CI, a tool capturing stdout), that would emit thousands of lines
        # for a multi-GB file, so print a milestone only every ~10% instead.
        tty = sys.stderr.isatty()
        last = [-1]

        def show(got, total):
            if tty:
                if total:
                    sys.stderr.write("\r  %s: %5.1f%%  (%s / %s)"
                                     % (args.db, 100.0 * got / total, _human(got), _human(total)))
                else:
                    sys.stderr.write("\r  %s: %s" % (args.db, _human(got)))
                return
            step = int(got * 10 / total) if total else -1
            if step != last[0]:
                last[0] = step
                pct = ("%d%%" % (step * 10)) if total else _human(got)
                sys.stderr.write("  %s: %s (%s)\n" % (args.db, pct, _human(got)))
        try:
            path = fetch(args.db, dest_dir=args.dir, url_base=args.url_base, progress=show)
        except ValueError as exc:
            sys.stderr.write("\n  error: %s\n" % exc)
            return 1
        sys.stderr.write("\n")
        print("  installed %s" % path)
        ok, detail = verify(args.db)
        print("  %s %s" % ("ok" if ok else "!! " + detail, args.db))
        return 0 if ok else 1

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
