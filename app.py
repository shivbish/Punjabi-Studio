"""Punjabi Studio: SRT word mapper + dictionary editor in one app.

Run from this folder:
    python -m uvicorn app:app --reload
Then open http://127.0.0.1:8000

The dictionary is stored next to this file as ``dictionary.json`` so the work
survives restarts and is shared by every browser that opens the app.
"""
import json
import os
import threading
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from mapper import decode_srt, map_words

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
STORE = BASE_DIR / "dictionary.json"

MAX_FILE_BYTES = 10 * 1024 * 1024      # 10 MB per subtitle file
MAX_ENTRIES = 200_000                  # dictionary entries
MAX_STORE_BYTES = 50 * 1024 * 1024     # 50 MB request body for the store

app = FastAPI(title="Punjabi Studio", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# Dictionary store
# --------------------------------------------------------------------------
def _load_store() -> tuple[list[dict], str | None]:
    """Return (entries, savedAt) from disk. A missing or broken file is empty."""
    try:
        data = json.loads(STORE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return [], None
    if not isinstance(data, dict):
        return [], None
    entries = data.get("entries")
    saved_at = data.get("savedAt")
    return (entries if isinstance(entries, list) else [],
            saved_at if isinstance(saved_at, str) else None)


def _write_store(entries: list[dict], saved_at: str) -> None:
    """Write atomically so a crash never leaves a half-written dictionary."""
    tmp = STORE.with_suffix(".tmp")
    payload = {"version": 1, "savedAt": saved_at, "entries": entries}
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, STORE)


def _as_dict(model: BaseModel) -> dict:
    dump = getattr(model, "model_dump", None)
    return dump() if callable(dump) else model.dict()


class Entry(BaseModel):
    key: str = Field(min_length=1, max_length=5000)
    type: Literal["string", "number", "boolean", "null", "json"]
    value: Any


class DictionaryPayload(BaseModel):
    entries: list[Entry] = Field(default_factory=list)


def _value_problem(entry: dict) -> str | None:
    kind, value = entry["type"], entry["value"]
    if kind == "string" and not isinstance(value, str):
        return "must be text"
    if kind == "number" and (isinstance(value, bool) or not isinstance(value, (int, float))):
        return "must be a number"
    if kind == "boolean" and not isinstance(value, bool):
        return "must be true or false"
    if kind == "null" and value is not None:
        return "must be null"
    if kind == "json" and not isinstance(value, (dict, list)):
        return "must be a JSON object or array"
    return None


@app.middleware("http")
async def _limit_store_body(request, call_next):
    if request.url.path == "/api/dictionary" and request.method == "PUT":
        length = request.headers.get("content-length")
        if length and length.isdigit() and int(length) > MAX_STORE_BYTES:
            return JSONResponse(status_code=413, content={"detail": "Dictionary is too large to save (50 MB limit)."})
    return await call_next(request)


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health():
    """Lightweight liveness check for uptime monitors and load balancers."""
    return {"status": "ok", "app": app.title, "version": app.version}


async def _read_srt(upload: UploadFile, label: str) -> str:
    if not (upload.filename or "").lower().endswith(".srt"):
        raise HTTPException(400, f"{label} must be a .srt file.")
    raw = await upload.read()
    if len(raw) > MAX_FILE_BYTES:
        raise HTTPException(413, f"{label} is larger than 10 MB.")
    return decode_srt(raw)


@app.post("/api/map")
async def create_mapping(
    native_file: UploadFile = File(...),
    roman_file: UploadFile = File(...),
):
    """Pair native and Roman subtitle words into a {native: roman} mapping."""
    native_text = await _read_srt(native_file, "Native words file")
    roman_text = await _read_srt(roman_file, "Roman words file")
    mapping = map_words(roman_text, native_text)
    return {"count": len(mapping), "mapping": mapping}


@app.get("/api/dictionary")
def get_dictionary():
    with _lock:
        entries, saved_at = _load_store()
    return {"entries": entries, "savedAt": saved_at}


@app.put("/api/dictionary")
def put_dictionary(payload: DictionaryPayload):
    if len(payload.entries) > MAX_ENTRIES:
        raise HTTPException(413, f"The dictionary can hold at most {MAX_ENTRIES:,} entries.")

    entries: list[dict] = []
    seen: set[str] = set()
    for item in payload.entries:
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

    saved_at = _now()
    with _lock:
        _write_store(entries, saved_at)
    return {"count": len(entries), "savedAt": saved_at}


@app.delete("/api/dictionary")
def clear_dictionary():
    with _lock:
        STORE.unlink(missing_ok=True)
    return {"count": 0, "savedAt": None}
