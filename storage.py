"""Where dictionary documents live: a local folder or a Cloudflare R2 bucket.

This module knows nothing about FastAPI. Every method either returns a value
or raises (``ClientError``/``BotoCoreError`` for R2, ``OSError`` for disk), so
callers never mistake "storage is down" for "no such dictionary".
"""
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

try:
    from botocore.exceptions import BotoCoreError, ClientError
except ImportError:  # boto3 is only needed when R2 is configured
    class BotoCoreError(Exception):
        pass

    class ClientError(Exception):
        def __init__(self, error_response, operation_name):
            super().__init__(f"{operation_name}: {error_response}")
            self.response = error_response
            self.operation_name = operation_name

log = logging.getLogger("punjabi_studio.storage")

MIGRATION_MARKER = ".legacy-migrated"
_MISSING_CODES = {"NoSuchKey", "404", "NotFound"}


def _is_missing(exc: ClientError) -> bool:
    return exc.response.get("Error", {}).get("Code", "") in _MISSING_CODES


def _clean_etag(value) -> str:
    return str(value or "").strip('"')


class Store:
    """Reads and writes one JSON document per dictionary id."""

    def __init__(
        self,
        data_dir,
        legacy_file,
        s3=None,
        bucket=None,
        prefix="dictionaries",
        legacy_key="dictionary.json",
    ):
        self.data_dir = Path(data_dir)
        self.dict_dir = self.data_dir / "dictionaries"
        self.trash_dir = self.dict_dir / ".trash"
        self.legacy_file = Path(legacy_file)
        self.s3 = s3
        self.bucket = bucket
        self.prefix = prefix.strip("/") or "dictionaries"
        self.legacy_key = legacy_key

    @classmethod
    def from_env(cls, data_dir, legacy_file):
        """Use R2 when R2_ACCOUNT_ID and R2_BUCKET_NAME are set, else local files."""
        account = os.getenv("R2_ACCOUNT_ID")
        bucket = os.getenv("R2_BUCKET_NAME")
        prefix = os.getenv("R2_PREFIX") or "dictionaries"
        legacy_key = os.getenv("R2_OBJECT_KEY", "dictionary.json")
        if not (account and bucket):
            return cls(data_dir, legacy_file, prefix=prefix, legacy_key=legacy_key)

        import boto3
        from botocore.config import Config

        s3 = boto3.client(
            service_name="s3",
            endpoint_url=f"https://{account}.r2.cloudflarestorage.com",
            aws_access_key_id=os.getenv("R2_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("R2_SECRET_ACCESS_KEY"),
            region_name="auto",
            # Fail fast instead of hanging the UI for minutes on a bad network.
            config=Config(
                connect_timeout=5,
                read_timeout=30,
                retries={"max_attempts": 3, "mode": "standard"},
                max_pool_connections=20,
            ),
        )
        return cls(data_dir, legacy_file, s3=s3, bucket=bucket, prefix=prefix, legacy_key=legacy_key)

    @property
    def uses_r2(self) -> bool:
        return self.s3 is not None

    # -- keys and paths ----------------------------------------------------
    def _key(self, dict_id: str) -> str:
        return f"{self.prefix}/{dict_id}.json"

    def _path(self, dict_id: str) -> Path:
        return self.dict_dir / f"{dict_id}.json"

    @staticmethod
    def _file_stamp(stat) -> str:
        return f"{stat.st_mtime_ns}-{stat.st_size}-{stat.st_ino}"

    # -- documents ---------------------------------------------------------
    def load(self, dict_id: str) -> bytes | None:
        """Return the stored bytes, or None when the dictionary does not exist."""
        if self.s3:
            try:
                return self.s3.get_object(Bucket=self.bucket, Key=self._key(dict_id))["Body"].read()
            except ClientError as exc:
                if _is_missing(exc):
                    return None
                raise
        try:
            return self._path(dict_id).read_bytes()
        except FileNotFoundError:
            return None

    def write(self, dict_id: str, body: bytes) -> None:
        if self.s3:
            self.s3.put_object(
                Bucket=self.bucket,
                Key=self._key(dict_id),
                Body=body,
                ContentType="application/json",
            )
            return
        self.dict_dir.mkdir(parents=True, exist_ok=True)
        path = self._path(dict_id)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(body)
        os.replace(tmp, path)  # atomic: readers never see a half-written file

    def delete(self, dict_id: str) -> None:
        if self.s3:
            self.s3.delete_object(Bucket=self.bucket, Key=self._key(dict_id))
            return
        self._path(dict_id).unlink(missing_ok=True)

    def stamp(self, dict_id: str) -> str | None:
        """A cheap change token (changes whenever the document is rewritten).

        None means the dictionary does not exist. No document body is read.
        """
        if self.s3:
            try:
                head = self.s3.head_object(Bucket=self.bucket, Key=self._key(dict_id))
            except ClientError as exc:
                if _is_missing(exc):
                    return None
                raise
            return _clean_etag(head.get("ETag")) or f"{head.get('LastModified')}-{head.get('ContentLength')}"
        try:
            return self._file_stamp(self._path(dict_id).stat())
        except FileNotFoundError:
            return None

    def list_stamps(self) -> dict[str, str]:
        """Return {dictionary id: change token} for every stored dictionary."""
        stamps: dict[str, str] = {}
        if self.s3:
            token = None
            while True:
                kwargs = {"Bucket": self.bucket, "Prefix": f"{self.prefix}/"}
                if token:
                    kwargs["ContinuationToken"] = token
                response = self.s3.list_objects_v2(**kwargs)
                for item in response.get("Contents", []):
                    name = item["Key"][len(self.prefix) + 1:]
                    if "/" in name or not name.endswith(".json"):
                        continue  # skips .trash/ backups and the migration marker
                    stamps[name[:-5]] = (
                        _clean_etag(item.get("ETag"))
                        or f"{item.get('LastModified')}-{item.get('Size')}"
                    )
                if not response.get("IsTruncated"):
                    break
                token = response.get("NextContinuationToken")
            return stamps
        if self.dict_dir.is_dir():
            for path in self.dict_dir.glob("*.json"):
                try:
                    stamps[path.stem] = self._file_stamp(path.stat())
                except FileNotFoundError:
                    continue  # deleted while listing
        return stamps

    # -- backups of deleted dictionaries ----------------------------------
    def save_backup(self, dict_id: str, body: bytes, keep: int) -> None:
        """Keep a copy of a dictionary that is about to be deleted.

        Raises when the copy cannot be saved, so the caller does not delete a
        dictionary it could not back up. Pruning old backups is best-effort.
        """
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        name = f"{dict_id}-{stamp}.json"
        if self.s3:
            prefix = f"{self.prefix}/.trash/"
            self.s3.put_object(
                Bucket=self.bucket, Key=prefix + name, Body=body, ContentType="application/json"
            )
            try:
                response = self.s3.list_objects_v2(Bucket=self.bucket, Prefix=prefix)
                backups = sorted(
                    response.get("Contents", []), key=lambda item: item["LastModified"], reverse=True
                )
                for old in backups[keep:]:
                    self.s3.delete_object(Bucket=self.bucket, Key=old["Key"])
            except (ClientError, BotoCoreError):
                log.warning("Could not prune old dictionary backups", exc_info=True)
            return
        self.trash_dir.mkdir(parents=True, exist_ok=True)
        (self.trash_dir / name).write_bytes(body)
        try:
            backups = sorted(
                self.trash_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True
            )
            for old in backups[keep:]:
                old.unlink(missing_ok=True)
        except OSError:
            log.warning("Could not prune old dictionary backups", exc_info=True)

    # -- one-time import of the original single dictionary -----------------
    def has_marker(self) -> bool:
        if self.s3:
            try:
                self.s3.head_object(Bucket=self.bucket, Key=f"{self.prefix}/{MIGRATION_MARKER}")
                return True
            except ClientError as exc:
                if _is_missing(exc):
                    return False
                raise
        return (self.data_dir / MIGRATION_MARKER).exists()

    def write_marker(self) -> None:
        """Best effort: if this fails the import is simply re-checked later."""
        try:
            if self.s3:
                self.s3.put_object(
                    Bucket=self.bucket,
                    Key=f"{self.prefix}/{MIGRATION_MARKER}",
                    Body=b"legacy dictionary imported\n",
                )
            else:
                self.data_dir.mkdir(parents=True, exist_ok=True)
                (self.data_dir / MIGRATION_MARKER).write_text("legacy dictionary imported\n", encoding="utf-8")
        except (ClientError, BotoCoreError, OSError):
            log.warning("Could not write the legacy-migration marker", exc_info=True)

    def read_legacy(self) -> bytes | None:
        """Return the original single-dictionary file, or None when there is none."""
        if self.s3:
            try:
                return self.s3.get_object(Bucket=self.bucket, Key=self.legacy_key)["Body"].read()
            except ClientError as exc:
                if _is_missing(exc):
                    return None
                raise
        try:
            return self.legacy_file.read_bytes()
        except FileNotFoundError:
            return None
