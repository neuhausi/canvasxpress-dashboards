"""Pluggable object storage behind one interface, resolved by URI scheme.

Phase 5.1 of the dashboards storage program (`docs/plans/dashboards/
dashboards-storage-plan.md`). Two logical stores — **datasets** and (later)
**dashboards** — share this shape; a backend is selected purely by the URI
scheme, so calling code never changes when the physical store does::

    store = open_store("file:///var/cxd/datasets")
    rec = store.put(owner, id, blob, meta)
    store.get(owner, id)
    store.list(owner)
    store.delete(owner, id)
    store.url_for(owner, id)       # signed/public URL when the backend supports one

Every store is **owner-scoped**: an owner can never read, list, or delete
another owner's objects. The shared conformance suite
(`tests/test_objectstore.py`) asserts this on every backend, so the backends are
interchangeable and provably isolated.

This module ships the zero-dependency local ``file://`` backend (default). Later
phases add ``s3://``, ``postgres://``, and ``gdrive://`` — each one class
implementing :class:`ObjectStore`, registered in :func:`open_store`.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from urllib.parse import urlparse, unquote


@dataclass
class Record:
    """A stored object: its opaque bytes plus metadata, scoped to an owner."""

    owner: str
    id: str
    blob: bytes
    meta: Dict = field(default_factory=dict)


@dataclass
class Summary:
    """A listing entry — metadata without the blob body."""

    id: str
    meta: Dict = field(default_factory=dict)


class ObjectStore:
    """Owner-isolated key/blob store. Backends implement every method."""

    def put(self, owner: str, id: str, blob: bytes, meta: Optional[Dict] = None) -> Record:
        """Create or overwrite ``id`` for ``owner``; return the stored record."""
        raise NotImplementedError

    def get(self, owner: str, id: str) -> Optional[Record]:
        """Return the owner's record for ``id``, or None (owner-scoped)."""
        raise NotImplementedError

    def list(self, owner: str) -> List[Summary]:
        """List the owner's objects as summaries (no blob bodies)."""
        raise NotImplementedError

    def delete(self, owner: str, id: str) -> None:
        """Delete the owner's object (no-op if absent)."""
        raise NotImplementedError

    def url_for(self, owner: str, id: str) -> Optional[str]:
        """A signed/public URL for the object, or None when unsupported."""
        return None


class FileObjectStore(ObjectStore):
    """Local-filesystem backend (``file://``).

    Objects live under ``<root>/<owner-hash>/<id-hash>.json`` as a small JSON
    envelope (``owner``, ``id``, ``meta``, base64 ``blob``). Owner and id are
    SHA-256 hashed for the on-disk names, which (a) makes owner isolation a
    directory boundary and (b) neutralizes path-traversal and charset issues —
    an ``id`` of ``../../etc/passwd`` is just another hash. The real owner/id are
    preserved inside the envelope, so :meth:`list` recovers them faithfully.
    Writes are atomic (temp file + ``os.replace``).
    """

    def __init__(self, root: str):
        self._root = os.path.abspath(root)
        self._lock = threading.Lock()
        os.makedirs(self._root, exist_ok=True)

    def _owner_dir(self, owner: str) -> str:
        return os.path.join(self._root, _hash(owner))

    def _path(self, owner: str, id: str) -> str:
        return os.path.join(self._owner_dir(owner), _hash(id) + ".json")

    def put(self, owner: str, id: str, blob: bytes, meta: Optional[Dict] = None) -> Record:
        if not owner:
            raise ValueError("owner is required")
        if not id:
            raise ValueError("id is required")
        if not isinstance(blob, (bytes, bytearray)):
            raise TypeError("blob must be bytes")
        meta = dict(meta or {})
        envelope = {
            "owner": owner,
            "id": id,
            "meta": meta,
            "blob": base64.b64encode(bytes(blob)).decode("ascii"),
        }
        path = self._path(owner, id)
        with self._lock:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            _atomic_write_json(path, envelope)
        return Record(owner=owner, id=id, blob=bytes(blob), meta=meta)

    def get(self, owner: str, id: str) -> Optional[Record]:
        path = self._path(owner, id)
        with self._lock:
            envelope = _read_json(path)
        # Guard against a hash collision leaking another owner's object.
        if not envelope or envelope.get("owner") != owner or envelope.get("id") != id:
            return None
        return Record(
            owner=owner,
            id=id,
            blob=base64.b64decode(envelope.get("blob", "")),
            meta=envelope.get("meta") or {},
        )

    def list(self, owner: str) -> List[Summary]:
        owner_dir = self._owner_dir(owner)
        summaries = []
        with self._lock:
            try:
                names = os.listdir(owner_dir)
            except FileNotFoundError:
                names = []
            for name in names:
                if not name.endswith(".json"):
                    continue
                envelope = _read_json(os.path.join(owner_dir, name))
                if envelope and envelope.get("owner") == owner:
                    summaries.append(Summary(id=envelope["id"], meta=envelope.get("meta") or {}))
        summaries.sort(key=lambda s: s.meta.get("updated_at") or "", reverse=True)
        return summaries

    def delete(self, owner: str, id: str) -> None:
        path = self._path(owner, id)
        with self._lock:
            # Only remove it if it truly belongs to this owner.
            envelope = _read_json(path)
            if envelope and envelope.get("owner") == owner and envelope.get("id") == id:
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass

    def url_for(self, owner: str, id: str) -> Optional[str]:
        # The local backend serves objects through the app, not a direct URL.
        return None


def open_store(uri: str, s3_client=None, drive_client_factory=None) -> ObjectStore:
    """Resolve a store URI to an :class:`ObjectStore` by scheme.

    Supported schemes: ``file://`` (local filesystem), ``s3://`` (S3 /
    S3-compatible), ``postgres://`` / ``postgresql://`` / ``sqlite://`` (SQL via
    SQLAlchemy), and ``gdrive://folderId`` (Google Drive).

    :param uri: A store URI, e.g. ``file:///var/cxd/datasets``,
        ``s3://bucket/prefix``, ``postgres://host/db?table=cxd_datasets``, or
        ``gdrive://folderId``.
    :param s3_client: Optional injected S3 client (for ``s3://``; tests/MinIO/R2).
    :param drive_client_factory: ``owner -> DriveClient`` factory for ``gdrive://``
        (resolves per-owner OAuth credentials; injectable for tests).
    :returns: A ready-to-use store.
    :raises ValueError: On an empty/malformed URI or unknown scheme.
    """
    if not uri or not isinstance(uri, str):
        raise ValueError("store URI is required")
    parsed = urlparse(uri)
    scheme = parsed.scheme or "file"
    if scheme == "file":
        return FileObjectStore(_file_path_from_uri(uri, parsed))
    if scheme == "s3":
        from .s3store import store_from_uri  # lazy: boto3 is an optional extra
        bucket = parsed.netloc
        if not bucket:
            raise ValueError("s3 URI must include a bucket, e.g. s3://bucket/prefix")
        return store_from_uri(bucket, (parsed.path or "").lstrip("/"), client=s3_client)
    if scheme in ("postgres", "postgresql", "sqlite"):
        from .sqlstore import store_from_uri as sql_store_from_uri  # lazy: SQLAlchemy extra
        return sql_store_from_uri(uri)
    if scheme == "gdrive":
        from .gdrivestore import store_from_uri as gdrive_store_from_uri  # lazy: gdrive extra
        folder_id = parsed.netloc or (parsed.path or "").lstrip("/")
        if not folder_id:
            raise ValueError("gdrive URI must include a folder id, e.g. gdrive://folderId")
        return gdrive_store_from_uri(folder_id, drive_client_factory)
    raise ValueError("unsupported store scheme '%s'" % scheme)


def _file_path_from_uri(uri: str, parsed) -> str:
    """Extract a local filesystem path from a ``file://`` URI (or a bare path)."""
    if not parsed.scheme:
        return uri  # bare path, e.g. "./cxd-datasets"
    # file:///abs/path -> netloc empty, path "/abs/path"
    # file://./rel or file:rel -> tolerate by joining netloc+path.
    path = unquote(parsed.path or "")
    if parsed.netloc and parsed.netloc not in ("", "localhost"):
        path = parsed.netloc + path
    return path or "."


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _atomic_write_json(path: str, obj: dict) -> None:
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(obj, fh)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise


def _read_json(path: str) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, ValueError):
        return None
