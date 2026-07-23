"""Google Drive object-storage backend (``gdrive://folderId``).

Phase 5.4 (final) of the dashboards storage program. Implements the same
:class:`~cxd_server.objectstore.ObjectStore` contract on Google Drive, so it
joins the shared conformance suite unchanged and is interchangeable with the
file/S3/SQL backends.

Design, reusing the ``canvasxpress-connectors`` Google model:

* Each **owner** gets their own Drive **folder** (``cxd-<owner-hash>``) under a
  configured root folder — owner isolation is a folder boundary, exactly as it is
  a directory boundary for ``file://`` and a key-prefix for ``s3://``.
* An object is one JSON-envelope file (``<id-hash>.json`` = owner + id + meta +
  base64 blob), so ids of any shape/charset are safe.
* :meth:`url_for` returns the file's Drive ``webViewLink``.

The Google API surface is behind a small :class:`DriveClient` protocol, so the
store logic is unit-tested with an in-memory fake and the heavy ``googleapiclient``
dependency (the ``gdrive`` extra) lives only in :class:`GoogleDriveClient`, imported
lazily. A ``client_factory(owner)`` returns the Drive client for an owner, which is
where a per-user-OAuth deployment resolves that user's credentials (from the
connectors :class:`TokenStore`); a single shared service Drive just returns one
client for every owner.
"""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Callable, List, Optional

from .objectstore import ObjectStore, Record, Summary

_FOLDER_MIME = "application/vnd.google-apps.folder"


class GDriveObjectStore(ObjectStore):
    """Owner-isolated store backed by Google Drive folders + JSON-envelope files."""

    def __init__(self, root_folder_id: str, client_factory: Callable[[str], "DriveClient"],
                 folder_prefix: str = "cxd"):
        if not root_folder_id:
            raise ValueError("root_folder_id is required (the gdrive:// folder)")
        self._root = root_folder_id
        self._client_factory = client_factory
        self._prefix = folder_prefix
        self._folder_cache = {}  # owner -> folder_id

    def _client(self, owner: str) -> "DriveClient":
        return self._client_factory(owner)

    def _owner_folder(self, owner: str, client: "DriveClient", create: bool) -> Optional[str]:
        if owner in self._folder_cache:
            return self._folder_cache[owner]
        name = self._prefix + "-" + _hash(owner)[:16]
        folder_id = client.find_folder(name, self._root)
        if folder_id is None and create:
            folder_id = client.create_folder(name, self._root)
        if folder_id is not None:
            self._folder_cache[owner] = folder_id
        return folder_id

    def put(self, owner: str, id: str, blob: bytes, meta: Optional[dict] = None) -> Record:
        if not owner:
            raise ValueError("owner is required")
        if not id:
            raise ValueError("id is required")
        if not isinstance(blob, (bytes, bytearray)):
            raise TypeError("blob must be bytes")
        meta = dict(meta or {})
        client = self._client(owner)
        folder = self._owner_folder(owner, client, create=True)
        payload = json.dumps({
            "owner": owner,
            "id": id,
            "meta": meta,
            "blob": base64.b64encode(bytes(blob)).decode("ascii"),
        }).encode("utf-8")
        name = _hash(id) + ".json"
        existing = client.find_file(name, folder)
        if existing:
            client.update_file(existing, payload)
        else:
            client.create_file(name, folder, payload)
        return Record(owner=owner, id=id, blob=bytes(blob), meta=meta)

    def get(self, owner: str, id: str) -> Optional[Record]:
        client = self._client(owner)
        folder = self._owner_folder(owner, client, create=False)
        if folder is None:
            return None
        file_id = client.find_file(_hash(id) + ".json", folder)
        if not file_id:
            return None
        envelope = _parse(client.download(file_id))
        if not envelope or envelope.get("owner") != owner or envelope.get("id") != id:
            return None
        return Record(
            owner=owner,
            id=id,
            blob=base64.b64decode(envelope.get("blob", "")),
            meta=envelope.get("meta") or {},
        )

    def list(self, owner: str) -> List[Summary]:
        client = self._client(owner)
        folder = self._owner_folder(owner, client, create=False)
        if folder is None:
            return []
        summaries = []
        for file_id, _name in client.list_files(folder):
            envelope = _parse(client.download(file_id))
            if envelope and envelope.get("owner") == owner:
                summaries.append(Summary(id=envelope["id"], meta=envelope.get("meta") or {}))
        summaries.sort(key=lambda s: s.meta.get("updated_at") or "", reverse=True)
        return summaries

    def delete(self, owner: str, id: str) -> None:
        client = self._client(owner)
        folder = self._owner_folder(owner, client, create=False)
        if folder is None:
            return
        file_id = client.find_file(_hash(id) + ".json", folder)
        if file_id:
            envelope = _parse(client.download(file_id))
            if envelope and envelope.get("owner") == owner and envelope.get("id") == id:
                client.delete(file_id)

    def url_for(self, owner: str, id: str) -> Optional[str]:
        client = self._client(owner)
        folder = self._owner_folder(owner, client, create=False)
        if folder is None:
            return None
        file_id = client.find_file(_hash(id) + ".json", folder)
        return client.web_view_link(file_id) if file_id else None


class DriveClient:
    """The slice of the Drive v3 API the store needs. Backends implement it."""

    def find_folder(self, name: str, parent_id: str) -> Optional[str]:
        raise NotImplementedError

    def create_folder(self, name: str, parent_id: str) -> str:
        raise NotImplementedError

    def find_file(self, name: str, parent_id: str) -> Optional[str]:
        raise NotImplementedError

    def create_file(self, name: str, parent_id: str, data: bytes) -> str:
        raise NotImplementedError

    def update_file(self, file_id: str, data: bytes) -> None:
        raise NotImplementedError

    def download(self, file_id: str) -> bytes:
        raise NotImplementedError

    def list_files(self, parent_id: str):
        raise NotImplementedError

    def delete(self, file_id: str) -> None:
        raise NotImplementedError

    def web_view_link(self, file_id: str) -> Optional[str]:
        raise NotImplementedError


def store_from_uri(folder_id: str, client_factory: Optional[Callable[[str], DriveClient]]) -> GDriveObjectStore:
    """Build a store from a ``gdrive://folderId`` URI (used by ``open_store``)."""
    if client_factory is None:
        raise RuntimeError(
            "the gdrive backend needs a Drive client factory (per-user OAuth "
            "credentials); pass drive_client_factory to open_store / the app"
        )
    return GDriveObjectStore(root_folder_id=folder_id, client_factory=client_factory)


class GoogleDriveClient(DriveClient):  # pragma: no cover - requires live Google APIs
    """Real :class:`DriveClient` over ``googleapiclient`` (the ``gdrive`` extra).

    Built from a ``google.oauth2`` Credentials object — e.g. one derived from the
    connectors :class:`TokenStore` refresh token with the ``drive.file`` scope.
    """

    def __init__(self, credentials, service=None):
        self._credentials = credentials
        self._service = service

    def _svc(self):
        if self._service is None:
            from googleapiclient.discovery import build
            self._service = build("drive", "v3", credentials=self._credentials,
                                  cache_discovery=False)
        return self._service

    def _media(self, data: bytes):
        from googleapiclient.http import MediaInMemoryUpload
        return MediaInMemoryUpload(data, mimetype="application/json", resumable=False)

    def _find(self, name: str, parent_id: str, folder: bool) -> Optional[str]:
        safe = name.replace("'", "\\'")
        q = "name = '%s' and '%s' in parents and trashed = false" % (safe, parent_id)
        if folder:
            q += " and mimeType = '%s'" % _FOLDER_MIME
        resp = self._svc().files().list(
            q=q, spaces="drive", fields="files(id)", pageSize=1
        ).execute()
        files = resp.get("files", [])
        return files[0]["id"] if files else None

    def find_folder(self, name, parent_id):
        return self._find(name, parent_id, folder=True)

    def create_folder(self, name, parent_id):
        body = {"name": name, "mimeType": _FOLDER_MIME, "parents": [parent_id]}
        return self._svc().files().create(body=body, fields="id").execute()["id"]

    def find_file(self, name, parent_id):
        return self._find(name, parent_id, folder=False)

    def create_file(self, name, parent_id, data):
        body = {"name": name, "parents": [parent_id]}
        return self._svc().files().create(
            body=body, media_body=self._media(data), fields="id"
        ).execute()["id"]

    def update_file(self, file_id, data):
        self._svc().files().update(fileId=file_id, media_body=self._media(data)).execute()

    def download(self, file_id):
        return self._svc().files().get_media(fileId=file_id).execute()

    def list_files(self, parent_id):
        out = []
        page = None
        while True:
            resp = self._svc().files().list(
                q="'%s' in parents and trashed = false" % parent_id,
                spaces="drive", fields="nextPageToken, files(id, name)", pageToken=page
            ).execute()
            for f in resp.get("files", []):
                if f.get("name", "").endswith(".json"):
                    out.append((f["id"], f["name"]))
            page = resp.get("nextPageToken")
            if not page:
                return out

    def delete(self, file_id):
        self._svc().files().delete(fileId=file_id).execute()

    def web_view_link(self, file_id):
        return self._svc().files().get(
            fileId=file_id, fields="webViewLink"
        ).execute().get("webViewLink")


#: OAuth scope needed to create/read the app's own files in a user's Drive.
DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"


def token_store_drive_factory(token_store, scopes=None):  # pragma: no cover - needs google libs
    """Build an ``owner -> GoogleDriveClient`` factory from a connectors TokenStore.

    Reuses the ``canvasxpress-connectors`` OAuth: each owner connects their Google
    account once (via the connectors Sheets/Drive OAuth flow), and their encrypted
    refresh token is looked up here to mint short-lived Drive credentials. The
    stored grant must include :data:`DRIVE_FILE_SCOPE`.

    :param token_store: A ``cx_connectors.store.TokenStore`` (or compatible).
    :param scopes: Override scopes (defaults to ``[DRIVE_FILE_SCOPE]``).
    :returns: A factory usable as ``drive_client_factory``.
    :raises PermissionError: If an owner has not connected their Google account.
    """
    scopes = scopes or [DRIVE_FILE_SCOPE]

    def factory(owner: str) -> "DriveClient":
        record = token_store.load(owner)
        if not record:
            raise PermissionError("owner '%s' has not connected a Google account" % owner)
        from google.oauth2.credentials import Credentials
        creds = Credentials(
            token=None,
            refresh_token=record["refresh_token"],
            token_uri=record["token_uri"],
            client_id=record["client_id"],
            client_secret=record["client_secret"],
            scopes=scopes,
        )
        return GoogleDriveClient(creds)

    return factory


def _parse(data) -> Optional[dict]:
    if isinstance(data, (bytes, bytearray)):
        data = bytes(data).decode("utf-8")
    try:
        return json.loads(data)
    except (ValueError, TypeError):
        return None


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
