"""SRT parsing and native -> Roman word mapping (framework independent).

Pairs words cue by cue: when a cue in the native-script file and the matching
cue in the Roman file contain the same number of words, the words are zipped
together. Cues whose word counts differ are skipped, because the alignment
cannot be trusted.
"""
import re

# Characters stripped from subtitle text before splitting into words:
# music note, brackets, danda marks, digits, colon, comma, hyphen, '>'
NOISE_RE = re.compile(r"[♪\[\]॥।\d:,\->]")
# Keep word characters, whitespace, the Gurmukhi block, apostrophes and hyphens
CLEAN_RE = re.compile(r"[^\w\s\u0A00-\u0A7F'-]", flags=re.UNICODE)


def decode_srt(raw: bytes) -> str:
    """Decode uploaded bytes (handles a UTF-8 BOM) and normalise line endings."""
    return raw.decode("utf-8-sig", errors="ignore").replace("\r\n", "\n")


def parse_srt_content(content: str) -> dict[int, str]:
    """Parse SRT text and return {block_index: subtitle_text}."""
    entries: dict[int, str] = {}
    for block in content.strip().split("\n\n"):
        lines = [ln.strip() for ln in block.strip().split("\n") if ln.strip()]
        if len(lines) >= 3:
            try:
                idx = int(lines[0])
            except ValueError:
                continue
            # lines[1] is the timestamp line, so it is skipped
            entries[idx] = " ".join(lines[2:])
    return entries


def clean_word(word: str) -> str:
    """Remove special characters and lowercase the word."""
    return CLEAN_RE.sub("", word).strip().lower()


def _words(text: str) -> list[str]:
    text = NOISE_RE.sub("", text)
    return [w for w in (clean_word(x) for x in text.split()) if w]


def map_words(roman_content: str, native_content: str) -> dict[str, str]:
    """Map native words to Roman words where both cues have the same word count.

    The first Roman spelling seen for a native word wins, so a later cue can
    never overwrite an established pair.
    """
    roman = parse_srt_content(roman_content)
    native = parse_srt_content(native_content)

    mapping: dict[str, str] = {}
    for idx in sorted(set(roman) & set(native)):
        r_words = _words(roman[idx])
        n_words = _words(native[idx])
        if len(r_words) == len(n_words):
            for nw, rw in zip(n_words, r_words):
                if nw and rw and nw not in mapping:
                    mapping[nw] = rw
    return mapping
