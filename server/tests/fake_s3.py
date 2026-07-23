"""An in-memory fake of the small slice of the boto3 S3 client that
``S3ObjectStore`` uses — enough to run the shared conformance suite (and the
multi-store app tests) without boto3 or a live bucket.
"""

import io


class _NoSuchKey(Exception):
    def __init__(self):
        super().__init__("NoSuchKey")
        self.response = {"Error": {"Code": "NoSuchKey"}}


class FakeS3Client:
    """Minimal S3 client: put/get/list/delete + presigned URL, per bucket."""

    def __init__(self):
        self._buckets = {}  # bucket -> {key: bytes}

    def put_object(self, Bucket, Key, Body, **kwargs):
        self._buckets.setdefault(Bucket, {})[Key] = bytes(Body)
        return {}

    def get_object(self, Bucket, Key, **kwargs):
        objs = self._buckets.get(Bucket, {})
        if Key not in objs:
            raise _NoSuchKey()
        return {"Body": io.BytesIO(objs[Key])}

    def delete_object(self, Bucket, Key, **kwargs):
        self._buckets.get(Bucket, {}).pop(Key, None)
        return {}

    def list_objects_v2(self, Bucket, Prefix="", ContinuationToken=None, **kwargs):
        objs = self._buckets.get(Bucket, {})
        contents = [{"Key": k} for k in sorted(objs) if k.startswith(Prefix)]
        return {"Contents": contents, "IsTruncated": False}

    def generate_presigned_url(self, ClientMethod, Params=None, ExpiresIn=3600, **kwargs):
        params = Params or {}
        return "https://s3.fake/%s/%s?exp=%s" % (
            params.get("Bucket"), params.get("Key"), ExpiresIn
        )
