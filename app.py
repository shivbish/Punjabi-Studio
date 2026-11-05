"""Punjabi Studio: SRT word mapper + multi-dictionary editor.

Run from this folder:
    python -m uvicorn app:app --reload
Then open http://127.0.0.1:8000

Every dictionary is stored as its own JSON document. With R2 configured the
documents live under ``<R2_PREFIX>/<id>.json`` in the bucket; otherwise they
live in ``data/dictionaries/<id>.json`` next to this file (see storage.py).
The original single ``dictionary.json`` store is imported once as the
``default`` dictionary, and the old ``/api/dictionary`` routes keep working as
aliases.

Run ONE worker process. Writes are serialised with in-process locks, so the
revision check that protects against lost updates is only airtight inside a
single process.
"""
import json
import logging
import math
import re
import threading
import unicodedata
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

try:
    from dotenv import load_dotenv
    load_dotenv()  # Must run before the storage client is created
except ImportError:  # python-dotenv is optional at runtime
    pass

from limits import BodyLimitMiddleware
from mapper import decode_srt, map_words_with_stats
from storage import BotoCoreError, ClientError, Store

log = logging.getLogger("punjabi_studio")

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
LEGACY_STORE = BASE_DIR / "dictionary.json"

DEFAULT_ID = "default"
DEFAULT_NAME = "Main Dictionary"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

MAX_FILE_BYTES = 10 * 1024 * 1024      # 10 MB per subtitle file
MAX_ENTRIES = 200_000                  # dictionary entries
MAX_STORE_BYTES = 50 * 1024 * 1024     # 50 MB request body for the store
MAX_SMALL_BODY_BYTES = 64 * 1024       # create / rename requests
TRASH_KEEP = 20                        # deleted-dictionary backups to keep

store = Store.from_env(DATA_DIR, LEGACY_STORE)


class RevalidatingStaticFiles(StaticFiles):
    """Always revalidate, so a deploy is never masked by a stale cached script."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers.setdefault("Cache-Control", "no-cache")
        return response


def _body_limit(method: str, path: str) -> Optional[tuple[int, str]]:
    if method == "PUT" and (path == "/api/dictionary" or path.startswith("/api/dictionaries/")):
        return MAX_STORE_BYTES, "Dictionary is too large to save (50 MB limit)."
    if method == "POST" and path == "/api/map":
        return 2 * MAX_FILE_BYTES + 64 * 1024, "The subtitle files are larger than 10 MB each."
    if method in ("POST", "PATCH") and path.startswith("/api/dictionaries"):
        return MAX_SMALL_BODY_BYTES, "Request is too large."
    return None


app = FastAPI(title="Punjabi Studio", version="2.1.0")
app.mount("/static", RevalidatingStaticFiles(directory=STATIC_DIR), name="static")
app.add_middleware(BodyLimitMiddleware, limit_for=_body_limit)
app.add_middleware(GZipMiddleware, minimum_size=1024)  # dictionaries compress ~5x

# FastAPI runs sync routes in a thread pool, so writes must be serialised per
# dictionary. A short global lock guards the lock table itself.
_locks_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}
_create_lock = threading.Lock()
_migration_lock = threading.Lock()
_migrated = False

# {dictionary id: (storage change token, list metadata)}. Listing dictionaries
# only re-reads documents whose token changed, instead of downloading them all.
# The metadata is None for a damaged file, so it is not re-read (or re-logged)
# on every listing until it actually changes.
_meta_cache: dict[str, tuple[str, dict | None]] = {}


class StoredDocumentError(Exception):
    """A stored dictionary file exists but is not valid."""

    def __init__(self, dict_id: str):
        super().__init__(dict_id)
        self.dict_id = dict_id


@app.exception_handler(ClientError)
@app.exception_handler(BotoCoreError)
async def _storage_unavailable(request, exc):
    log.error("Storage error on %s %s: %s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=503,
        content={"detail": "Storage is temporarily unavailable. Please try again."},
    )


@app.exception_handler(StoredDocumentError)
async def _damaged_document(request, exc):
    log.error("Stored dictionary %r is not valid JSON", exc.dict_id)
    return JSONResponse(
        status_code=500,
        content={"detail": f'The saved file for "{exc.dict_id}" is damaged. It was left untouched.'},
    )


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _lock_for(dict_id: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(dict_id)
        if lock is None:
            lock = threading.Lock()
            _locks[dict_id] = lock
        return lock


# --------------------------------------------------------------------------
# Documents
# --------------------------------------------------------------------------
def _load_doc(dict_id: str) -> dict | None:
    """Return the dictionary, None if it does not exist, raise if it is damaged."""
    raw = store.load(dict_id)
    if raw is None:
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise StoredDocumentError(dict_id) from None
    if not isinstance(data, dict):
        raise StoredDocumentError(dict_id)

    entries = data.get("entries")
    created = data.get("createdAt") if isinstance(data.get("createdAt"), str) else _now()
    updated = data.get("updatedAt") if isinstance(data.get("updatedAt"), str) else created
    try:
        revision = int(data.get("revision") or 0)
    except (TypeError, ValueError):
        revision = 0
    return {
        "version": 2,
        "id": dict_id,
        "name": data.get("name") if isinstance(data.get("name"), str) and data["name"].strip() else dict_id,
        "description": data.get("description") if isinstance(data.get("description"), str) else "",
        "createdAt": created,
        "updatedAt": updated,
        "savedAt": data.get("savedAt") if isinstance(data.get("savedAt"), str) else updated,
        "revision": revision,
        "entries": entries if isinstance(entries, list) else [],
    }


def _write_doc(doc: dict) -> None:
    now = _now()
    doc["updatedAt"] = now
    doc["savedAt"] = now
    doc["version"] = 2
    body = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    store.write(doc["id"], body)
    _meta_cache.pop(doc["id"], None)


def _new_doc(dict_id: str, name: str, description: str = "") -> dict:
    now = _now()
    return {
        "version": 2,
        "id": dict_id,
        "name": name,
        "description": description,
        "createdAt": now,
        "updatedAt": now,
        "savedAt": now,
        "revision": 1,
        "entries": [],
    }


def _meta(doc: dict) -> dict:
    return {
        "id": doc["id"],
        "name": doc["name"],
        "description": doc.get("description", ""),
        "count": len(doc.get("entries") or []),
        "createdAt": doc["createdAt"],
        "updatedAt": doc["updatedAt"],
        "revision": doc["revision"],
    }


def _safe_load(dict_id: str) -> dict | None:
    try:
        return _load_doc(dict_id)
    except StoredDocumentError:
        log.error("Skipping damaged dictionary %r in the list", dict_id)
        return None


def _list_metas() -> list[dict]:
    """Metadata for every dictionary, re-reading only the ones that changed."""
    stamps = {i: s for i, s in store.list_stamps().items() if ID_RE.fullmatch(i)}
    metas: dict[str, dict] = {}
    stale: list[tuple[str, str]] = []
    for dict_id, stamp in stamps.items():
        cached = _meta_cache.get(dict_id)
        if cached and cached[0] == stamp:
            if cached[1] is not None:
                metas[dict_id] = cached[1]
        else:
            stale.append((dict_id, stamp))

    if stale:
        with ThreadPoolExecutor(max_workers=min(8, len(stale))) as pool:
            docs = pool.map(_safe_load, [dict_id for dict_id, _ in stale])
            for (dict_id, stamp), doc in zip(stale, docs):
                meta = _meta(doc) if doc is not None else None
                _meta_cache[dict_id] = (stamp, meta)
                if meta is not None:
                    metas[dict_id] = meta

    for dict_id in list(_meta_cache):
        if dict_id not in stamps:
            _meta_cache.pop(dict_id, None)
    return list(metas.values())


def _revision_of(dict_id: str) -> int | None:
    """The saved revision, without downloading the dictionary when unchanged."""
    stamp = store.stamp(dict_id)
    if stamp is None:
        return None
    cached = _meta_cache.get(dict_id)
    if cached and cached[0] == stamp and cached[1] is not None:
        return cached[1]["revision"]
    doc = _load_doc(dict_id)
    if doc is None:
        return None
    _meta_cache[dict_id] = (stamp, _meta(doc))
    return doc["revision"]


def _slugify(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")
    return (slug[:48].strip("-") or "dictionary")


def _require_id(dict_id: str) -> str:
    """Reject ids that could escape the storage folder."""
    if not ID_RE.fullmatch(dict_id or ""):
        raise HTTPException(404, "Dictionary not found.")
    return dict_id


def _backup_for_delete(doc: dict) -> None:
    """Keep a copy of a deleted dictionary so an accidental delete is recoverable."""
    body = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    store.save_backup(doc["id"], body, TRASH_KEEP)


# --------------------------------------------------------------------------
# One-time import of the original single-dictionary store
# --------------------------------------------------------------------------
def _migrate_legacy() -> None:
    if store.has_marker():
        return

    # If dictionaries already exist, the import has either happened or is not
    # needed. Mark it so deleting them later cannot resurrect the legacy file.
    if store.list_stamps():
        store.write_marker()
        return

    raw = store.read_legacy()
    if raw is None:
        return

    try:
        data = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        log.warning("The legacy dictionary file is not valid JSON; nothing was imported.")
        return
    if not isinstance(data, dict):
        return

    entries = data.get("entries") if isinstance(data.get("entries"), list) else []
    doc = _new_doc(DEFAULT_ID, DEFAULT_NAME, "Imported from the original single dictionary.")
    doc["entries"] = entries
    _write_doc(doc)
    store.write_marker()
    log.info("Imported legacy dictionary as %r (%s entries).", DEFAULT_ID, f"{len(entries):,}")


def _ensure_migrated() -> None:
    global _migrated
    if _migrated:
        return
    with _migration_lock:
        if _migrated:
            return
        try:
            _migrate_legacy()
        except (ClientError, BotoCoreError):
            # Storage trouble is transient. Fail this request (503) and retry on
            # the next one, so the legacy words are never skipped for good.
            raise
        except Exception:  # a bug here must not take the whole API down
            log.exception("Legacy import skipped")
        _migrated = True


# --------------------------------------------------------------------------
# Models and validation
# --------------------------------------------------------------------------
def _as_dict(model: BaseModel) -> dict:
    dump = getattr(model, "model_dump", None)
    return dump() if callable(dump) else model.dict()


class Entry(BaseModel):
    key: str = Field(min_length=1, max_length=5000)
    type: Literal["string", "number", "boolean", "null", "json"]
    value: Any


class DictionaryPayload(BaseModel):
    entries: list[Entry] = Field(default_factory=list)
    revision: Optional[int] = None


class CreateDictionary(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)


class UpdateDictionary(BaseModel):
    name: Optional[str] = Field(default=None, max_length=100)
    description: Optional[str] = Field(default=None, max_length=2000)


def _value_problem(entry: dict) -> str | None:
    kind, value = entry["type"], entry["value"]
    if kind == "string" and not isinstance(value, str):
        return "must be text"
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return "must be a number"
        if isinstance(value, float) and not math.isfinite(value):
            return "must be a finite number"
    if kind == "boolean" and not isinstance(value, bool):
        return "must be true or false"
    if kind == "null" and value is not None:
        return "must be null"
    if kind == "json" and not isinstance(value, (dict, list)):
        return "must be a JSON object or array"
    return None


def _normalize_entries(items: list[Entry]) -> list[dict]:
    if len(items) > MAX_ENTRIES:
        raise HTTPException(413, f"The dictionary can hold at most {MAX_ENTRIES:,} entries.")

    entries: list[dict] = []
    seen: set[str] = set()
    for item in items:
        entry = _as_dict(item)
        key = unicodedata.normalize("NFC", str(entry["key"])).strip()
        if not key:
            raise HTTPException(422, "Every entry needs a non-empty key.")
        problem = _value_problem({**entry, "key": key})
        if problem:
            raise HTTPException(422, f'The value for "{key}" {problem}.')
        if key in seen:
            raise HTTPException(422, f'Duplicate key "{key}".')
        seen.add(key)
        entries.append({"key": key, "type": entry["type"], "value": entry["value"]})
    return entries


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
def health():
    """Lightweight liveness check for uptime monitors and load balancers."""
    return {"status": "ok", "app": app.title, "version": app.version}


async def _read_srt(upload: UploadFile, label: str) -> str:
    if not (upload.filename or "").lower().endswith(".srt"):
        raise HTTPException(400, f"{label} must be a .srt file.")
    chunks: list[bytes] = []
    size = 0
    while chunk := await upload.read(1024 * 1024):
        size += len(chunk)
        if size > MAX_FILE_BYTES:
            raise HTTPException(413, f"{label} is larger than 10 MB.")
        chunks.append(chunk)
    return decode_srt(b"".join(chunks))


@app.post("/api/map")
async def create_mapping(
    native_file: UploadFile = File(...),
    roman_file: UploadFile = File(...),
):
    """Pair native and Roman subtitle words into a {native: roman} mapping."""
    native_text = await _read_srt(native_file, "Native words file")
    roman_text = await _read_srt(roman_file, "Roman words file")
    # Pure CPU work: keep it off the event loop so other requests stay responsive.
    mapping, stats = await run_in_threadpool(map_words_with_stats, roman_text, native_text)
    return {"count": len(mapping), "mapping": mapping, "stats": stats}


@app.get("/api/dictionaries")
def list_dictionaries():
    _ensure_migrated()
    dictionaries = _list_metas()
    dictionaries.sort(key=lambda item: (item["name"].casefold(), item["id"]))
    return {"dictionaries": dictionaries}


@app.post("/api/dictionaries", status_code=201)
def create_dictionary(payload: CreateDictionary):
    _ensure_migrated()
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, "The dictionary name cannot be empty.")

    with _create_lock:
        base = _slugify(name)
        candidate = base
        suffix = 2
        # Test for the file's existence, not for a readable document: a damaged
        # file must never be mistaken for a free id and overwritten.
        while store.stamp(candidate) is not None:
            candidate = f"{base}-{suffix}"
            suffix += 1
        doc = _new_doc(candidate, name, payload.description.strip())
        _write_doc(doc)
    return _meta(doc)


@app.get("/api/dictionaries/{dict_id}")
def get_dictionary(dict_id: str):
    _ensure_migrated()
    _require_id(dict_id)
    doc = _load_doc(dict_id)
    if doc is None:
        raise HTTPException(404, "Dictionary not found.")
    return doc


@app.get("/api/dictionaries/{dict_id}/revision")
def get_dictionary_revision(dict_id: str):
    """Tiny change check used by the editor's background sync."""
    _ensure_migrated()
    _require_id(dict_id)
    revision = _revision_of(dict_id)
    if revision is None:
        raise HTTPException(404, "Dictionary not found.")
    return {"revision": revision}


def _replace_entries(dict_id: str, payload: DictionaryPayload, require_revision: bool) -> dict:
    entries = _normalize_entries(payload.entries)
    with _lock_for(dict_id):
        doc = _load_doc(dict_id)
        if doc is None:
            raise HTTPException(404, "Dictionary not found.")
        if require_revision and payload.revision != doc["revision"]:
            raise HTTPException(
                409,
                detail={
                    "message": "The dictionary changed since it was loaded.",
                    "current": {"revision": doc["revision"], "savedAt": doc["savedAt"]},
                },
            )
        doc["entries"] = entries
        doc["revision"] = int(doc.get("revision") or 0) + 1
        _write_doc(doc)
    return {
        "count": len(entries),
        "savedAt": doc["savedAt"],
        "updatedAt": doc["updatedAt"],
        "revision": doc["revision"],
    }


@app.put("/api/dictionaries/{dict_id}")
def put_dictionary(dict_id: str, payload: DictionaryPayload):
    _ensure_migrated()
    _require_id(dict_id)
    if payload.revision is None:
        raise HTTPException(428, "A revision is required. Reload the dictionary and try again.")
    return _replace_entries(dict_id, payload, require_revision=True)


@app.patch("/api/dictionaries/{dict_id}")
def update_dictionary(dict_id: str, payload: UpdateDictionary):
    _ensure_migrated()
    _require_id(dict_id)
    with _lock_for(dict_id):
        doc = _load_doc(dict_id)
        if doc is None:
            raise HTTPException(404, "Dictionary not found.")
        if payload.name is not None:
            name = payload.name.strip()
            if not name:
                raise HTTPException(422, "The dictionary name cannot be empty.")
            doc["name"] = name
        if payload.description is not None:
            doc["description"] = payload.description.strip()
        _write_doc(doc)
    return _meta(doc)


@app.delete("/api/dictionaries/{dict_id}")
def delete_dictionary(dict_id: str):
    _ensure_migrated()
    _require_id(dict_id)
    with _lock_for(dict_id):
        doc = _load_doc(dict_id)
        if doc is None:
            raise HTTPException(404, "Dictionary not found.")
        _backup_for_delete(doc)  # raises (and keeps the dictionary) if the backup fails
        store.delete(dict_id)
        _meta_cache.pop(dict_id, None)
    return {"deleted": dict_id, "name": doc["name"]}


# --- Legacy single-dictionary routes (kept for old clients/bookmarks) ------
@app.get("/api/dictionary")
def get_legacy_dictionary():
    _ensure_migrated()
    doc = _load_doc(DEFAULT_ID)
    if doc is None:
        return {"id": DEFAULT_ID, "entries": [], "savedAt": None, "revision": 0}
    return {
        "id": doc["id"],
        "entries": doc["entries"],
        "savedAt": doc["savedAt"],
        "updatedAt": doc["updatedAt"],
        "revision": doc["revision"],
    }


@app.put("/api/dictionary")
def put_legacy_dictionary(payload: DictionaryPayload):
    _ensure_migrated()
    with _lock_for(DEFAULT_ID):
        if _load_doc(DEFAULT_ID) is None:
            _write_doc(_new_doc(DEFAULT_ID, DEFAULT_NAME))
    return _replace_entries(DEFAULT_ID, payload, require_revision=False)


@app.delete("/api/dictionary")
def clear_legacy_dictionary():
    _ensure_migrated()
    with _lock_for(DEFAULT_ID):
        doc = _load_doc(DEFAULT_ID)
        if doc is not None:
            _backup_for_delete(doc)
            store.delete(DEFAULT_ID)
            _meta_cache.pop(DEFAULT_ID, None)
    return {"count": 0, "savedAt": None}
