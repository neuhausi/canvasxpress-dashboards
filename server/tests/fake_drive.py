"""In-memory fake of the small Drive v3 slice ``GDriveObjectStore`` uses — enough
to run the shared conformance suite (and the gdrive app tests) without
googleapiclient or a live Google account.

``FakeDrive`` is the shared backing store (folders + files); ``FakeDriveClient``
wraps it per owner. A single shared ``FakeDrive`` across owners exercises real
owner isolation (each owner gets a distinct folder under the root).
"""

from cxd_server.gdrivestore import DriveClient


class FakeDrive:
    """Shared in-memory Drive: folders and files keyed by generated ids."""

    def __init__(self):
        self._folders = {}  # id -> {name, parent}
        self._files = {}    # id -> {name, parent, data}
        self._seq = 0

    def _id(self, prefix):
        self._seq += 1
        return "%s%d" % (prefix, self._seq)


class FakeDriveClient(DriveClient):
    """A DriveClient over a shared :class:`FakeDrive`."""

    def __init__(self, drive):
        self._d = drive

    def find_folder(self, name, parent_id):
        for fid, f in self._d._folders.items():
            if f["name"] == name and f["parent"] == parent_id:
                return fid
        return None

    def create_folder(self, name, parent_id):
        fid = self._d._id("folder-")
        self._d._folders[fid] = {"name": name, "parent": parent_id}
        return fid

    def find_file(self, name, parent_id):
        for fid, f in self._d._files.items():
            if f["name"] == name and f["parent"] == parent_id:
                return fid
        return None

    def create_file(self, name, parent_id, data):
        fid = self._d._id("file-")
        self._d._files[fid] = {"name": name, "parent": parent_id, "data": bytes(data)}
        return fid

    def update_file(self, file_id, data):
        self._d._files[file_id]["data"] = bytes(data)

    def download(self, file_id):
        return self._d._files[file_id]["data"]

    def list_files(self, parent_id):
        return [(fid, f["name"]) for fid, f in self._d._files.items() if f["parent"] == parent_id]

    def delete(self, file_id):
        self._d._files.pop(file_id, None)

    def web_view_link(self, file_id):
        return "https://drive.google.com/file/d/%s/view" % file_id
