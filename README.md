# Punjabi Studio

One project for the two dictionary tools:

- **Map subtitles** — upload a native-script `.srt` and its Roman `.srt`, and pair the words cue by cue (from FastWordMapper).
- **Dictionary** — add, edit, search, deduplicate and export those pairs (from the Dictionary Editor / `JSON_BuilderV8.html`).

Both live in one FastAPI app, one page, two tabs, and share a single dictionary that is saved on the server, so words mapped from subtitles go straight into the editor.

## Requirements

- Python 3.10 or newer.
- A modern browser (the page uses ES modules and downloads files client-side).

## Quick start (Windows PowerShell)

```powershell
cd D:\Shivam\Opencode\PunjabiStudio
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app:app --reload
```

Open <http://127.0.0.1:8000>.

If you already have FastAPI and Uvicorn installed globally, `python -m uvicorn app:app --reload` is enough.

## Workflow

1. **Map subtitles** — choose both `.srt` files and press *Generate mapping*. Words are paired only when the two matching cues contain the same number of words; mismatched cues are skipped.
2. Check the searchable table or the raw JSON.
3. **Add to dictionary** — reviews how many words are new and which are skipped (duplicate key or duplicate Roman value), then adds them.
4. **Dictionary** — fix spellings, add words by hand, search, find hidden duplicate keys, and export.

The dictionary is saved automatically about a second after each change and restored the next time the page is opened.

## Project layout

```
PunjabiStudio/
├── app.py              FastAPI app: mapper endpoint + dictionary store
├── mapper.py           SRT parsing and native -> Roman word pairing
├── test_mapper.py      Tests for the mapper (no extra dependencies)
├── requirements.txt
├── dictionary.json     Created at runtime: the saved dictionary
├── README.md
└── static/
    ├── index.html      One page with the two tabs
    ├── style.css       Shared light/dark theme
    ├── app.js          Tab switching + the SRT mapper tab
    ├── dictionary.js   Dictionary editor, autosave and merge logic
    ├── export.js       JSON/Excel/Word/CSV/TSV/TXT/MD/HTML/XML export
    └── ui.js           Toast, confirmation modal, file helpers
```

## API

| Method   | Path               | Purpose |
| -------- | ------------------ | ------- |
| `GET`    | `/api/health`      | Liveness check: `{"status": "ok", "app": "Punjabi Studio", "version": "1.0.0"}`. |
| `POST`   | `/api/map`         | Multipart form with `native_file` and `roman_file` (`.srt`, max 10 MB each). Returns `{count, mapping}`. |
| `GET`    | `/api/dictionary`  | Returns `{entries, savedAt}`. |
| `PUT`    | `/api/dictionary`  | Replaces the dictionary with `{entries: [{key, type, value}]}`. |
| `DELETE` | `/api/dictionary`  | Deletes the saved dictionary file. |

`type` is one of `string`, `number`, `boolean`, `null`, `json`. Keys are normalised to Unicode NFC and must be unique; a duplicate key is rejected with `422`.

## Notes

- The dictionary lives in `dictionary.json` next to `app.py`. It is written atomically (`dictionary.tmp` then rename), so a crash cannot leave a half-written file.
- The editor also blocks duplicate Roman values, matching the original dictionary builder.
- Maximum sizes: 10 MB per subtitle file, 200,000 dictionary entries, 50 MB save request.
- Long lists render 1000 rows at a time. Use the search box to narrow a list, or **Show more** under the table to reveal the next 1000.
- Exports are generated in the browser: `.xlsx` and `.docx` are built by a small dependency-free ZIP writer, so no Office libraries are needed.

## Tests

```powershell
python test_mapper.py
```

or, with pytest installed:

```powershell
pytest
```

## Where this came from

- `../FastWordMapper/` — `main.py` and `mapper.py` became `app.py` and `mapper.py`; the upload page became the *Map subtitles* tab.
- `../JSON_BuilderV8.html` — the dictionary editor became the *Dictionary* tab, with its entry model, duplicate rules, import/merge review and all nine export formats kept. Browser-only `localStorage` autosave was replaced by the server-side `dictionary.json` store so both tabs and every browser share one list.

The original folders are untouched.
