"""Tests for the storage layer against both backends (local folder and a fake R2)."""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from fake_s3 import FakeS3  # noqa: E402
from storage import ClientError, Store  # noqa: E402


def stores(tmp, page_size=1000):
    """Yield (label, store) for the local backend and the fake R2 backend."""
    yield "local", Store(tmp, Path(tmp) / "dictionary.json")
    yield "r2", Store(tmp, Path(tmp) / "dictionary.json", s3=FakeS3(page_size), bucket="bucket")


def expect_raises(exc_type, fn):
    try:
        fn()
    except exc_type:
        return
    raise AssertionError(f"{exc_type.__name__} was not raised")


def test_write_load_delete_and_missing():
    with tempfile.TemporaryDirectory() as tmp:
        for label, store in stores(tmp):
            assert store.load("a") is None, label
            store.write("a", b'{"x":1}')
            assert store.load("a") == b'{"x":1}', label
            store.delete("a")
            assert store.load("a") is None, label
            store.delete("a")  # deleting twice is harmless


def test_stamp_changes_on_rewrite_and_matches_the_listing():
    with tempfile.TemporaryDirectory() as tmp:
        for label, store in stores(tmp):
            assert store.stamp("a") is None, label
            store.write("a", b"one")
            first = store.stamp("a")
            assert first and store.list_stamps()["a"] == first, label
            store.write("a", b"two!")
            assert store.stamp("a") != first, label


def test_listing_skips_backups_markers_and_temp_files_and_follows_pages():
    with tempfile.TemporaryDirectory() as tmp:
        for label, store in stores(tmp, page_size=2):
            for name in ["a", "b", "c", "d", "e"]:
                store.write(name, name.encode())
            store.save_backup("a", b"old", keep=5)
            store.write_marker()
            assert sorted(store.list_stamps()) == ["a", "b", "c", "d", "e"], label


def test_backups_are_pruned_to_the_newest_few():
    with tempfile.TemporaryDirectory() as tmp:
        for label, store in stores(tmp):
            for number in range(4):
                store.save_backup("a", f"v{number}".encode(), keep=2)
            if store.uses_r2:
                kept = [k for k in store.s3.objects if "/.trash/" in k]
            else:
                kept = list(store.trash_dir.glob("*.json"))
            assert len(kept) == 2, label


def test_a_failed_backup_raises_so_the_caller_will_not_delete():
    class NoTrash(FakeS3):
        def put_object(self, Bucket, Key, Body, **kwargs):
            if "/.trash/" in Key:
                raise ClientError({"Error": {"Code": "InternalError"}}, "PutObject")
            return super().put_object(Bucket, Key, Body, **kwargs)

    with tempfile.TemporaryDirectory() as tmp:
        store = Store(tmp, Path(tmp) / "x.json", s3=NoTrash(), bucket="b")
        expect_raises(ClientError, lambda: store.save_backup("a", b"data", keep=2))


def test_a_failed_prune_does_not_fail_the_backup():
    class NoList(FakeS3):
        def list_objects_v2(self, **kwargs):
            raise ClientError({"Error": {"Code": "InternalError"}}, "ListObjectsV2")

    with tempfile.TemporaryDirectory() as tmp:
        store = Store(tmp, Path(tmp) / "x.json", s3=NoList(), bucket="b")
        store.save_backup("a", b"data", keep=2)
        assert any("/.trash/" in key for key in store.s3.objects)


def test_storage_errors_are_raised_not_reported_as_missing():
    class Broken(FakeS3):
        def get_object(self, Bucket, Key):
            raise ClientError({"Error": {"Code": "InternalError"}}, "GetObject")

        def head_object(self, Bucket, Key):
            raise ClientError({"Error": {"Code": "InternalError"}}, "HeadObject")

        def list_objects_v2(self, **kwargs):
            raise ClientError({"Error": {"Code": "InternalError"}}, "ListObjectsV2")

    with tempfile.TemporaryDirectory() as tmp:
        store = Store(tmp, Path(tmp) / "x.json", s3=Broken(), bucket="b")
        expect_raises(ClientError, lambda: store.load("a"))
        expect_raises(ClientError, lambda: store.stamp("a"))
        expect_raises(ClientError, store.list_stamps)
        expect_raises(ClientError, store.read_legacy)
        expect_raises(ClientError, store.has_marker)


def test_marker_and_legacy_file():
    with tempfile.TemporaryDirectory() as tmp:
        for label, store in stores(tmp):
            assert store.has_marker() is False, label
            assert store.read_legacy() is None, label
            store.write_marker()
            assert store.has_marker() is True, label
            if store.uses_r2:
                store.s3.put_object(Bucket="bucket", Key="dictionary.json", Body=b"legacy")
            else:
                store.legacy_file.write_bytes(b"legacy")
            assert store.read_legacy() == b"legacy", label


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("All checks passed")
