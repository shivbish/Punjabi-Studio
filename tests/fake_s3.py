"""A tiny in-memory stand-in for the boto3 S3 client (only the calls Store makes)."""
import hashlib
import io
from datetime import datetime, timezone

from storage import ClientError


class FakeS3:
    def __init__(self, page_size=1000):
        self.objects = {}      # key -> (bytes, etag, last_modified)
        self.page_size = page_size
        self.calls = {}        # method name -> number of calls
        self._clock = 0

    def _count(self, name):
        self.calls[name] = self.calls.get(name, 0) + 1

    @staticmethod
    def _error(code, operation):
        return ClientError({"Error": {"Code": code}}, operation)

    def put_object(self, Bucket, Key, Body, **kwargs):
        self._count("put_object")
        data = bytes(Body)
        self._clock += 1
        stamp = datetime.fromtimestamp(self._clock, timezone.utc)
        self.objects[Key] = (data, hashlib.md5(data).hexdigest(), stamp)
        return {}

    def get_object(self, Bucket, Key):
        self._count("get_object")
        if Key not in self.objects:
            raise self._error("NoSuchKey", "GetObject")
        return {"Body": io.BytesIO(self.objects[Key][0])}

    def head_object(self, Bucket, Key):
        self._count("head_object")
        if Key not in self.objects:
            raise self._error("404", "HeadObject")
        data, etag, modified = self.objects[Key]
        return {"ETag": f'"{etag}"', "ContentLength": len(data), "LastModified": modified}

    def delete_object(self, Bucket, Key):
        self._count("delete_object")
        self.objects.pop(Key, None)
        return {}

    def list_objects_v2(self, Bucket, Prefix="", ContinuationToken=None):
        self._count("list_objects_v2")
        keys = sorted(key for key in self.objects if key.startswith(Prefix))
        start = int(ContinuationToken) if ContinuationToken else 0
        page = keys[start:start + self.page_size]
        truncated = start + self.page_size < len(keys)
        response = {
            "Contents": [
                {
                    "Key": key,
                    "ETag": f'"{self.objects[key][1]}"',
                    "Size": len(self.objects[key][0]),
                    "LastModified": self.objects[key][2],
                }
                for key in page
            ],
            "IsTruncated": truncated,
        }
        if truncated:
            response["NextContinuationToken"] = str(start + self.page_size)
        return response
