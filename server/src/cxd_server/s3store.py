"""S3 / S3-compatible object storage backend (``s3://bucket/prefix``).

Phase 5.2 of the dashboards storage program. Implements the same
:class:`~cxd_server.objectstore.ObjectStore` contract as the local ``file://``
backend, so it drops into the shared conformance suite unchanged and is
interchangeable with every other backend.

The heavy ``boto3`` dependency is an **optional extra** and imported lazily: a
caller may also inject any S3-compatible client (MinIO, Cloudflare R2, GCS
interop) via ``client=`` — the store only uses a small slice of the boto3 S3 API
(``put_object`` / ``get_object`` / ``list_objects_v2`` / ``delete_object`` /
``generate_presigned_url``), which keeps it unit-testable without a live bucket.

Layout mirrors the file backend: one JSON envelope per object at
``<prefix>/<sha256(owner)>/<sha256(id)>.json`` (owner + id + meta + base64 blob).
Hashing the owner into the key prefix makes owner isolation a key-prefix boundary
and neutralizes path/charset issues. :meth:`url_for` returns a short-lived
presigned GET URL so a browser can fetch a dataset directly.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import List, Optional

from .objectstore import ObjectStore, Record, Summary

_DEFAULT_SIGNED_TTL = 3600  # seconds


class S3ObjectStore(ObjectStore):
    """Owner-isolated store backed by an S3 (or S3-compatible) bucket."""

    def __init__(self, bucket: str, prefix: str = "", client=None,
                 signed_ttl: int = _DEFAULT_SIGNED_TTL):
        if not bucket:
            raise ValueError("bucket is required")
        self._bucket = bucket
        self._prefix = prefix.strip("/")
        self._signed_ttl = signed_ttl
        self._client = client or _default_client()

    def _owner_prefix(self, owner: str) -> str:
        parts = [p for p in (self._prefix, _hash(owner)) if p]
        return "/".join(parts) + "/"

    def _key(self, owner: str, id: str) -> str:
        return self._owner_prefix(owner) + _hash(id) + ".json"

    def put(self, owner: str, id: str, blob: bytes, meta: Optional[dict] = None) -> Record:
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
        self._client.put_object(
            Bucket=self._bucket,
            Key=self._key(owner, id),
            Body=json.dumps(envelope).encode("utf-8"),
            ContentType="application/json",
        )
        return Record(owner=owner, id=id, blob=bytes(blob), meta=meta)

    def get(self, owner: str, id: str) -> Optional[Record]:
        envelope = self._read(self._key(owner, id))
        if not envelope or envelope.get("owner") != owner or envelope.get("id") != id:
            return None
        return Record(
            owner=owner,
            id=id,
            blob=base64.b64decode(envelope.get("blob", "")),
            meta=envelope.get("meta") or {},
        )

    def list(self, owner: str) -> List[Summary]:
        summaries = []
        for key in self._list_keys(self._owner_prefix(owner)):
            envelope = self._read(key)
            if envelope and envelope.get("owner") == owner:
                summaries.append(Summary(id=envelope["id"], meta=envelope.get("meta") or {}))
        summaries.sort(key=lambda s: s.meta.get("updated_at") or "", reverse=True)
        return summaries

    def delete(self, owner: str, id: str) -> None:
        key = self._key(owner, id)
        envelope = self._read(key)
        if envelope and envelope.get("owner") == owner and envelope.get("id") == id:
            self._client.delete_object(Bucket=self._bucket, Key=key)

    def url_for(self, owner: str, id: str) -> Optional[str]:
        if self.get(owner, id) is None:
            return None
        return self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": self._key(owner, id)},
            ExpiresIn=self._signed_ttl,
        )

    # ---- helpers ----
    def _read(self, key: str) -> Optional[dict]:
        try:
            resp = self._client.get_object(Bucket=self._bucket, Key=key)
        except Exception as exc:  # noqa: BLE001 — normalize "missing key" to None
            if _is_not_found(exc):
                return None
            raise
        body = resp["Body"].read()
        if isinstance(body, (bytes, bytearray)):
            body = body.decode("utf-8")
        try:
            return json.loads(body)
        except ValueError:
            return None

    def _list_keys(self, prefix: str) -> List[str]:
        keys = []
        token = None
        while True:
            kwargs = {"Bucket": self._bucket, "Prefix": prefix}
            if token:
                kwargs["ContinuationToken"] = token
            resp = self._client.list_objects_v2(**kwargs)
            for obj in resp.get("Contents", []) or []:
                if obj.get("Key", "").endswith(".json"):
                    keys.append(obj["Key"])
            if resp.get("IsTruncated") and resp.get("NextContinuationToken"):
                token = resp["NextContinuationToken"]
            else:
                break
        return keys


def store_from_uri(bucket: str, prefix: str, client=None) -> S3ObjectStore:
    """Build an :class:`S3ObjectStore` from parsed URI parts (used by ``open_store``)."""
    return S3ObjectStore(bucket=bucket, prefix=prefix, client=client)


def _default_client():
    try:
        import boto3  # noqa: WPS433 — optional extra, imported on demand
    except ImportError as exc:  # pragma: no cover - env-dependent
        raise RuntimeError(
            "the 's3' backend requires boto3 (install the 's3' extra: pip install "
            "'canvasxpress-dashboards-server[s3]')"
        ) from exc
    return boto3.client("s3")


def _is_not_found(exc: Exception) -> bool:
    """Detect a boto3/S3-compatible 'no such key' error without importing botocore."""
    if type(exc).__name__ in ("NoSuchKey", "NotFound", "404"):
        return True
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        code = str(response.get("Error", {}).get("Code", ""))
        return code in ("NoSuchKey", "NoSuchBucket", "404", "NotFound")
    return False


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
