"""SRT parsing and native -> Roman word mapping (framework independent).

Pairs words cue by cue: when a cue in the native-script file and the matching
cue in the Roman file contain the same number of words, the words are zipped
together. Cues whose word counts differ are skipped, because the alignment
cannot be trusted.
"""
import codecs
import re

# Formatting markup that must go before words are split: HTML-style tags such
# as <i>word</i> or <font color="#fff">, and ASS/SSA overrides such as {\an8}.
# Without this, "<i>ghar</i>" would turn into the bogus word "ighari".
TAG_RE = re.compile(r"</?[A-Za-z][^>]*>|\{\\[^}]*\}")
# Characters stripped from subtitle text before splitting into words:
# music note, brackets, danda marks, digits, colon, comma, hyphen, '>'
NOISE_RE = re.compile(r"[♪\[\]॥।\d:,\->]")
# A blank line (possibly containing spaces) separates two subtitle blocks.
BLOCK_SPLIT_RE = re.compile(r"\n\s*\n")
# Keep word characters, whitespace, the Indic/Arabic script blocks below,
# apostrophes and hyphens.
CLEAN_RE = re.compile(
    r"[^\w\s"
    r"\u0900-\u097F"  # Devanagari (Hindi, Marathi, Nepali)
    r"\u0A00-\u0A7F"  # Gurmukhi (Punjabi)
    r"\u0980-\u09FF"  # Bengali / Assamese
    r"\u0B80-\u0BFF"  # Tamil
    r"\u0C00-\u0C7F"  # Telugu
    r"\u0C80-\u0CFF"  # Kannada
    r"\u0D00-\u0D7F"  # Malayalam
    r"\u0A80-\u0AFF"  # Gujarati
    r"\u0B00-\u0B7F"  # Odia
    r"\u0600-\u06FF"  # Arabic / Urdu / Persian
    r"'-]",
    flags=re.UNICODE,
)


def decode_srt(raw: bytes) -> str:
    """Decode uploaded bytes and normalise line endings.

    Handles UTF-8 (with or without BOM) and UTF-16 files, which Windows
    subtitle tools often produce. Undecodable bytes are dropped.
    """
    if raw.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        text = raw.decode("utf-16", errors="ignore")
    else:
        text = raw.decode("utf-8-sig", errors="ignore")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def parse_srt_content(content: str) -> dict[int, str]:
    """Parse SRT text and return {block_index: subtitle_text}."""
    entries: dict[int, str] = {}
    for block in BLOCK_SPLIT_RE.split(content.strip()):
        lines = [ln.strip() for ln in block.strip().split("\n") if ln.strip()]
        # index line, timestamp line ("00:00:01,000 --> 00:00:02,000"), text...
        if len(lines) >= 3 and "-->" in lines[1]:
            try:
                idx = int(lines[0])
            except ValueError:
                continue
            entries[idx] = " ".join(lines[2:])
    return entries


def clean_word(word: str) -> str:
    """Remove special characters and lowercase the word."""
    return CLEAN_RE.sub("", word).strip().lower()


def _words(text: str) -> list[str]:
    text = NOISE_RE.sub("", TAG_RE.sub(" ", text))
    return [w for w in (clean_word(x) for x in text.split()) if w]


def map_words_with_stats(
    roman_content: str, native_content: str
) -> tuple[dict[str, str], dict[str, int]]:
    """Map native words to Roman words and report how the cues lined up.

    The first Roman spelling seen for a native word wins, so a later cue can
    never overwrite an established pair.

    Stats:
        cues_in_both   cue numbers present in both files
        cues_paired    cues whose word counts matched (words were mapped)
        cues_skipped   cues present in both files but with different word counts
        cues_unmatched cue numbers present in only one of the two files
    """
    roman = parse_srt_content(roman_content)
    native = parse_srt_content(native_content)
    both = sorted(set(roman) & set(native))

    stats = {
        "cues_in_both": len(both),
        "cues_paired": 0,
        "cues_skipped": 0,
        "cues_unmatched": len(set(roman) ^ set(native)),
    }
    mapping: dict[str, str] = {}
    for idx in both:
        r_words = _words(roman[idx])
        n_words = _words(native[idx])
        if not r_words and not n_words:
            continue  # nothing but music notes / markup
        if len(r_words) != len(n_words):
            stats["cues_skipped"] += 1
            continue
        stats["cues_paired"] += 1
        for nw, rw in zip(n_words, r_words):
            if nw not in mapping:
                mapping[nw] = rw
    return mapping, stats


def map_words(roman_content: str, native_content: str) -> dict[str, str]:
    """Map native words to Roman words where both cues have the same word count."""
    return map_words_with_stats(roman_content, native_content)[0]
