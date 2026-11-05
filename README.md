# Punjabi Studio

Build a Punjabi word dictionary from subtitle pairs (native-script `.srt` + Roman `.srt`),
then edit it and export it as JSON, Excel, Word, CSV and more. Several people can edit the same
dictionary at once; edits are merged automatically.

## Run

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn app:app --reload                      # http://127.0.0.1:8000
```

Run **one** worker process (the default). Saves are serialised with in-process locks.

### Where dictionaries are stored

* **Local files** (default): `data/dictionaries/<id>.json`.
* **Cloudflare R2**: copy `.env.example` to `.env` and fill in `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Check the connection with `python scripts/check_r2.py`.

Deleting a dictionary keeps a backup (last 20) in `.trash/`, locally or in the bucket.

## Tests

```bash
pip install -r requirements-dev.txt
pytest                      # mapper, storage (local + fake R2), upload limits, HTTP API
node --test tests/js/*.test.mjs   # editor logic, export files, save/sync/conflict flows
```

## Layout

| File | Purpose |
| --- | --- |
| `app.py` | FastAPI routes, validation, caching, error handling |
| `storage.py` | Local-folder / R2 storage (no web framework) |
| `mapper.py` | SRT parsing and native → Roman word pairing |
| `limits.py` | Request-body size limits, also for chunked uploads |
| `static/dictionary.js` | Editor: autosave, merge, background sync |
| `static/logic.js` | Pure editor logic (duplicate index, merge) — unit-tested |
| `static/dictionaries.js` | Dictionary picker (create, rename, delete, share link) |
| `static/export.js` | Dependency-free JSON / xlsx / docx / csv / … builders |

## Known limits

* Every save uploads the whole dictionary (up to 200,000 entries / 50 MB). The editor waits longer
  between saves for big dictionaries. A per-entry (delta) API would be the next step if that becomes slow.
* Conflict handling is "your edits + theirs, saved word wins on a true clash". It is safe for a
  handful of editors, not meant for dozens at once.
