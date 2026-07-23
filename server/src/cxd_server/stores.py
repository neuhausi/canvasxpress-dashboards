"""Named-store registry — the config surface behind the store picker (Phase 5.2).

An admin curates a small set of **named** stores (a display name + a physical
URI + which capability: ``dataset`` | ``dashboard``); the browser only ever sees
and picks those **names**, never a raw URI or credential (storage plan §1/§2).
Sources:

* ``CXD_STORES`` — path to a ``stores.json`` (``{"stores": [ {name, capability,
  uri, default?}, ... ]}``). When present it is authoritative.
* Otherwise the single ``CXD_DATASET_STORE`` / ``CXD_DASHBOARD_STORE`` env URIs
  (or the app's constructor overrides) synthesize one default ``local`` store per
  capability — so a zero-config deployment still exposes exactly one target.

The registry opens each physical store lazily (via :func:`open_store`) and caches
it, so an unused S3 store never forces a boto3 import. :meth:`named` returns only
``{name, capability, default}`` — deliberately no URIs.
"""

from __future__ import annotations

import json
import os
from typing import Dict, List, Optional

from .objectstore import ObjectStore, open_store

CAPABILITIES = ("dataset", "dashboard")
_DEFAULT_DATASET_URI = "file://" + os.path.abspath("cxd-datasets")
_DEFAULT_DASHBOARD_URI = "file://" + os.path.abspath("cxd-dashboards")


class StoreRegistry:
    """Resolves capability + optional name to a physical :class:`ObjectStore`."""

    def __init__(self, configs: List[dict], s3_client=None, drive_client_factory=None):
        self._s3_client = s3_client
        self._drive_client_factory = drive_client_factory
        self._by_key: Dict[tuple, dict] = {}
        self._defaults: Dict[str, str] = {}
        self._opened: Dict[tuple, ObjectStore] = {}
        for cfg in configs:
            self._add(cfg)

    def _add(self, cfg: dict) -> None:
        name = cfg.get("name")
        capability = cfg.get("capability")
        uri = cfg.get("uri")
        if not name or not uri:
            raise ValueError("each store needs a name and a uri")
        if capability not in CAPABILITIES:
            raise ValueError("store '%s' capability must be one of %s" % (name, CAPABILITIES))
        key = (capability, name)
        self._by_key[key] = {"name": name, "capability": capability, "uri": uri}
        # First store for a capability, or an explicit default, wins the default.
        if cfg.get("default") or capability not in self._defaults:
            self._defaults[capability] = name

    def named(self, capability: Optional[str] = None) -> List[dict]:
        """List configured stores as ``{name, capability, default}`` (no URIs)."""
        out = []
        for (cap, name), cfg in self._by_key.items():
            if capability and cap != capability:
                continue
            out.append({
                "name": name,
                "capability": cap,
                "default": self._defaults.get(cap) == name,
            })
        out.sort(key=lambda s: (s["capability"], not s["default"], s["name"]))
        return out

    def default_name(self, capability: str) -> Optional[str]:
        """The default store name for a capability, or None if none configured."""
        return self._defaults.get(capability)

    def has(self, capability: str, name: str) -> bool:
        """Whether a named store exists for a capability."""
        return (capability, name) in self._by_key

    def resolve(self, capability: str, name: Optional[str] = None) -> ObjectStore:
        """Return the physical store for ``capability`` (default when ``name`` is None).

        :raises KeyError: If the capability has no default, or ``name`` is unknown.
        """
        name = name or self._defaults.get(capability)
        if not name:
            raise KeyError("no %s store configured" % capability)
        key = (capability, name)
        cfg = self._by_key.get(key)
        if cfg is None:
            raise KeyError("no %s store named '%s'" % (capability, name))
        if key not in self._opened:
            self._opened[key] = open_store(
                cfg["uri"], s3_client=self._s3_client,
                drive_client_factory=self._drive_client_factory,
            )
        return self._opened[key]

    @classmethod
    def from_env(cls, dataset_uri: Optional[str] = None, dashboard_uri: Optional[str] = None,
                 stores_path: Optional[str] = None, environ: Optional[dict] = None,
                 s3_client=None, drive_client_factory=None) -> "StoreRegistry":
        """Build a registry from ``stores.json`` if present, else single env defaults."""
        environ = environ if environ is not None else os.environ
        stores_path = stores_path or environ.get("CXD_STORES")
        clients = {"s3_client": s3_client, "drive_client_factory": drive_client_factory}
        if stores_path and os.path.isfile(stores_path):
            with open(stores_path, "r", encoding="utf-8") as fh:
                doc = json.load(fh)
            configs = doc.get("stores") if isinstance(doc, dict) else doc
            if not configs:
                raise ValueError("stores.json has no 'stores' entries")
            return cls(list(configs), **clients)
        # Zero-config: one default store per capability from the single-URI envs.
        dataset_uri = dataset_uri or environ.get("CXD_DATASET_STORE") or _DEFAULT_DATASET_URI
        dashboard_uri = dashboard_uri or environ.get("CXD_DASHBOARD_STORE") or _DEFAULT_DASHBOARD_URI
        return cls([
            {"name": "local", "capability": "dataset", "uri": dataset_uri, "default": True},
            {"name": "local", "capability": "dashboard", "uri": dashboard_uri, "default": True},
        ], **clients)
