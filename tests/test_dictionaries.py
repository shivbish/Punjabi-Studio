"""API tests for the multi-dictionary service. Run with ``pytest`` (needs fastapi and httpx).

Every test runs twice: against the local-folder backend and against an
in-memory fake of Cloudflare R2.
"""
import json

import pytest
from fastapi.testclient import TestClient

import app as studio
from fake_s3 import FakeS3
from storage import ClientError, Store


@pytest.fixture(params=["local", "r2"])
def client(request, tmp_path, monkeypatch):
    s3 = FakeS3() if request.param == "r2" else None
    store = Store(tmp_path, tmp_path / "dictionary.json", s3=s3, bucket="bucket" if s3 else None)
    monkeypatch.setattr(studio, "store", store)
    monkeypatch.setattr(studio, "_locks", {})
    monkeypatch.setattr(studio, "_meta_cache", {})
    monkeypatch.setattr(studio, "_migrated", False)
    return TestClient(studio.app)


def create(client, name="My Dictionary"):
    response = client.post("/api/dictionaries", json={"name": name})
    assert response.status_code == 201
    return response.json()


def put_legacy(data):
    body = json.dumps(data).encode("utf-8")
    if studio.store.uses_r2:
        studio.store.s3.put_object(Bucket="bucket", Key="dictionary.json", Body=body)
    else:
        studio.store.legacy_file.write_bytes(body)


def backups(dict_id):
    if studio.store.uses_r2:
        return [k for k in studio.store.s3.objects if k.startswith(f"dictionaries/.trash/{dict_id}-")]
    return list(studio.store.trash_dir.glob(f"{dict_id}-*.json"))


def test_create_list_rename_and_delete(client):
    created = create(client)
    assert created["id"] == "my-dictionary"
    assert created["name"] == "My Dictionary"
    assert created["count"] == 0
    assert created["revision"] == 1

    listed = client.get("/api/dictionaries").json()["dictionaries"]
    assert [item["id"] for item in listed] == ["my-dictionary"]

    renamed = client.patch("/api/dictionaries/my-dictionary", json={"name": "Punjabi Words"})
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "Punjabi Words"
    # the cached listing must notice the rename
    assert client.get("/api/dictionaries").json()["dictionaries"][0]["name"] == "Punjabi Words"

    assert client.delete("/api/dictionaries/my-dictionary").status_code == 200
    assert client.get("/api/dictionaries/my-dictionary").status_code == 404
    assert len(backups("my-dictionary")) == 1
    assert client.get("/api/dictionaries").json()["dictionaries"] == []


def test_duplicate_names_get_unique_ids(client):
    assert create(client, "Words")["id"] == "words"
    assert create(client, "Words")["id"] == "words-2"


def test_replace_entries_and_revision_conflict(client):
    created = create(client)
    dict_id = created["id"]
    entries = [{"key": "ਪੰਜਾਬ", "type": "string", "value": "Punjab"}]

    saved = client.put(f"/api/dictionaries/{dict_id}", json={"entries": entries, "revision": created["revision"]})
    assert saved.status_code == 200
    assert saved.json()["count"] == 1
    assert saved.json()["revision"] == created["revision"] + 1

    doc = client.get(f"/api/dictionaries/{dict_id}").json()
    assert doc["entries"] == entries
    assert doc["revision"] == saved.json()["revision"]

    stale = client.put(f"/api/dictionaries/{dict_id}", json={"entries": [], "revision": created["revision"]})
    assert stale.status_code == 409
    assert stale.json()["detail"]["current"]["revision"] == saved.json()["revision"]

    # the cached list shows the new count
    assert client.get("/api/dictionaries").json()["dictionaries"][0]["count"] == 1


def test_put_requires_revision(client):
    created = create(client)
    assert client.put(f"/api/dictionaries/{created['id']}", json={"entries": []}).status_code == 428


def test_duplicate_key_is_rejected(client):
    created = create(client)
    response = client.put(
        f"/api/dictionaries/{created['id']}",
        json={
            "entries": [
                {"key": "ਪੰਜਾਬ", "type": "string", "value": "Punjab"},
                {"key": "ਪੰਜਾਬ", "type": "string", "value": "Punjab2"},
            ],
            "revision": created["revision"],
        },
    )
    assert response.status_code == 422
    assert "Duplicate key" in response.json()["detail"]


def test_non_finite_numbers_are_rejected(client):
    created = create(client)
    response = client.put(
        f"/api/dictionaries/{created['id']}",
        content='{"entries":[{"key":"a","type":"number","value":NaN}],"revision":1}',
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422


def test_unknown_and_invalid_ids(client):
    assert client.get("/api/dictionaries/missing").status_code == 404
    assert client.get("/api/dictionaries/Bad_ID").status_code == 404
    assert client.get("/api/dictionaries/missing/revision").status_code == 404


def test_revision_endpoint_tracks_saves(client):
    created = create(client)
    url = f"/api/dictionaries/{created['id']}"
    assert client.get(f"{url}/revision").json() == {"revision": 1}
    client.put(url, json={"entries": [], "revision": 1})
    assert client.get(f"{url}/revision").json() == {"revision": 2}


def test_a_damaged_file_is_never_overwritten(client):
    studio.store.write("my-dictionary", b"{this is not json")

    assert client.get("/api/dictionaries/my-dictionary").status_code == 500
    assert client.get("/api/dictionaries").json()["dictionaries"] == []

    # Creating a dictionary with the same name must pick a new id, not clobber the file.
    assert create(client, "My Dictionary")["id"] == "my-dictionary-2"
    assert studio.store.load("my-dictionary") == b"{this is not json"


def test_listing_only_rereads_changed_dictionaries(client):
    if not studio.store.uses_r2:
        pytest.skip("counts R2 requests")
    for name in ["One", "Two", "Three"]:
        create(client, name)
    client.get("/api/dictionaries")                 # warms the cache
    studio.store.s3.calls.clear()
    client.get("/api/dictionaries")
    assert studio.store.s3.calls.get("get_object", 0) == 0
    assert studio.store.s3.calls.get("list_objects_v2") == 1


def test_storage_outage_is_a_503_not_an_empty_list(client, monkeypatch):
    def boom():
        raise ClientError({"Error": {"Code": "InternalError"}}, "ListObjectsV2")

    monkeypatch.setattr(studio.store, "list_stamps", boom)
    response = client.get("/api/dictionaries")
    assert response.status_code == 503
    assert "unavailable" in response.json()["detail"]


def test_oversized_dictionary_upload_is_rejected(client, monkeypatch):
    created = create(client)
    monkeypatch.setattr(studio, "MAX_STORE_BYTES", 100)
    entries = [{"key": f"k{n}", "type": "string", "value": "v" * 20} for n in range(20)]
    response = client.put(f"/api/dictionaries/{created['id']}", json={"entries": entries, "revision": 1})
    assert response.status_code == 413


def test_map_endpoint_returns_mapping_and_stats(client):
    native = "1\n00:00:01,000 --> 00:00:02,000\nਘਰ ਦਿਲ\n"
    roman = "1\n00:00:01,000 --> 00:00:02,000\nghar dil\n"
    response = client.post(
        "/api/map",
        files={"native_file": ("n.srt", native.encode()), "roman_file": ("r.srt", roman.encode())},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mapping"] == {"ਘਰ": "ghar", "ਦਿਲ": "dil"}
    assert body["count"] == 2
    assert body["stats"]["cues_paired"] == 1

    wrong = client.post(
        "/api/map",
        files={"native_file": ("n.txt", native.encode()), "roman_file": ("r.srt", roman.encode())},
    )
    assert wrong.status_code == 400


def test_map_endpoint_rejects_oversized_files(client, monkeypatch):
    monkeypatch.setattr(studio, "MAX_FILE_BYTES", 5)
    response = client.post(
        "/api/map",
        files={"native_file": ("n.srt", b"x" * 50), "roman_file": ("r.srt", b"x" * 50)},
    )
    assert response.status_code == 413


def test_responses_are_gzipped_and_static_files_revalidate(client):
    created = create(client)
    entries = [{"key": f"k{n}", "type": "string", "value": f"v{n}"} for n in range(200)]
    client.put(f"/api/dictionaries/{created['id']}", json={"entries": entries, "revision": 1})
    response = client.get(f"/api/dictionaries/{created['id']}", headers={"Accept-Encoding": "gzip"})
    assert response.headers.get("content-encoding") == "gzip"
    assert client.get("/static/style.css").headers["cache-control"] == "no-cache"
    assert client.get("/").headers["cache-control"] == "no-cache"


def test_legacy_store_is_migrated(client):
    put_legacy({
        "entries": [{"key": "ਪੰਜਾਬ", "type": "string", "value": "Punjab"}],
        "savedAt": "2026-01-01T00:00:00+00:00",
    })
    listed = client.get("/api/dictionaries").json()["dictionaries"]
    assert [item["id"] for item in listed] == ["default"]
    assert listed[0]["count"] == 1
    assert client.get("/api/dictionaries/default").json()["entries"][0]["value"] == "Punjab"


def test_legacy_import_is_retried_after_a_storage_error(client, monkeypatch):
    put_legacy({"entries": [{"key": "ਸਤ", "type": "string", "value": "Sat"}]})
    real = studio.store.has_marker
    calls = {"n": 0}

    def flaky():
        calls["n"] += 1
        if calls["n"] == 1:
            raise ClientError({"Error": {"Code": "InternalError"}}, "HeadObject")
        return real()

    monkeypatch.setattr(studio.store, "has_marker", flaky)
    assert client.get("/api/dictionaries").status_code == 503
    listed = client.get("/api/dictionaries").json()["dictionaries"]
    assert [item["id"] for item in listed] == ["default"]


def test_legacy_store_is_not_reimported_after_deleting_everything(client, monkeypatch):
    put_legacy({"entries": [{"key": "ਸਤ", "type": "string", "value": "Sat"}]})
    assert [i["id"] for i in client.get("/api/dictionaries").json()["dictionaries"]] == ["default"]

    assert client.delete("/api/dictionaries/default").status_code == 200
    monkeypatch.setattr(studio, "_migrated", False)
    assert client.get("/api/dictionaries").json()["dictionaries"] == []


def test_legacy_routes_alias_the_default_dictionary(client):
    assert create(client, "Main")["id"] == "main"
    saved = client.put("/api/dictionary", json={"entries": [{"key": "ਸਤ", "type": "string", "value": "Sat"}]})
    assert saved.status_code == 200
    assert saved.json()["count"] == 1

    doc = client.get("/api/dictionaries/default")
    assert doc.status_code == 200
    assert doc.json()["entries"][0]["key"] == "ਸਤ"
