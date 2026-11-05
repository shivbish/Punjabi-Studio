"""Tests for SRT parsing and word mapping. Run with ``pytest`` (or ``python tests/test_mapper.py``)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from mapper import (  # noqa: E402
    clean_word, decode_srt, map_words, map_words_with_stats, parse_srt_content,
)


def make_srt(texts):
    """Build a small SRT file, one cue per text, numbered from 1."""
    blocks = []
    for index, text in enumerate(texts, start=1):
        blocks.append(f"{index}\n00:00:{index:02d},000 --> 00:00:{index:02d},500\n{text}")
    return "\n\n".join(blocks) + "\n"


def test_parse_srt_content():
    content = make_srt(["ਪਹਿਲਾ ਬਲਾਕ", "ਦੂਜਾ ਬਲਾਕ"])
    assert parse_srt_content(content) == {1: "ਪਹਿਲਾ ਬਲਾਕ", 2: "ਦੂਜਾ ਬਲਾਕ"}
    assert parse_srt_content("not an srt at all") == {}


def test_parse_srt_tolerates_blank_lines_with_spaces():
    content = "1\n00:00:01,000 --> 00:00:02,000\nghar\n  \n\n2\n00:00:02,000 --> 00:00:03,000\ndil\n"
    assert parse_srt_content(content) == {1: "ghar", 2: "dil"}


def test_parse_srt_ignores_blocks_without_a_timestamp():
    assert parse_srt_content("1\nhello\nworld\n") == {}


def test_decode_srt():
    raw = "\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\nਘਰ\r\n".encode("utf-8")
    assert decode_srt(raw) == "1\n00:00:01,000 --> 00:00:02,000\nਘਰ\n"


def test_decode_srt_utf16_and_lone_carriage_returns():
    text = "1\r\n00:00:01,000 --> 00:00:02,000\r\nਘਰ\r\n"
    assert decode_srt(text.encode("utf-16")) == "1\n00:00:01,000 --> 00:00:02,000\nਘਰ\n"
    assert decode_srt(b"1\r00:00:01,000 --> 00:00:02,000\rghar\r") == "1\n00:00:01,000 --> 00:00:02,000\nghar\n"


def test_clean_word():
    assert clean_word("Hello!") == "hello"
    assert clean_word("ਪੰਜਾਬੀ,") == "ਪੰਜਾਬੀ"
    assert clean_word("don't") == "don't"


def test_map_words_pairs_equal_cues():
    native = make_srt(["ਪੰਜਾਬੀ ਸੁੰਦਰ", "ਮੈਂ ਠੀਕ"])
    roman = make_srt(["punjabi sundar", "main thik"])
    assert map_words(roman, native) == {
        "ਪੰਜਾਬੀ": "punjabi",
        "ਸੁੰਦਰ": "sundar",
        "ਮੈਂ": "main",
        "ਠੀਕ": "thik",
    }


def test_map_words_skips_unequal_word_counts():
    native = make_srt(["ਪੰਜਾਬੀ ਸੁੰਦਰ"])
    roman = make_srt(["punjabi"])
    assert map_words(roman, native) == {}


def test_map_words_only_uses_cues_present_in_both_files():
    native = make_srt(["ਘਰ", "ਦਿਲ"])
    roman = "2\n00:00:02,000 --> 00:00:02,500\ndil\n"
    assert map_words(roman, native) == {"ਦਿਲ": "dil"}


def test_map_words_first_spelling_wins():
    native = make_srt(["ਪੰਜਾਬੀ ਘਰ", "ਪੰਜਾਬੀ ਦਿਲ"])
    roman = make_srt(["punjabi ghar", "Punjabi dil"])
    assert map_words(roman, native) == {
        "ਪੰਜਾਬੀ": "punjabi",
        "ਘਰ": "ghar",
        "ਦਿਲ": "dil",
    }


def test_map_words_strips_noise_and_lowercases_roman():
    native = make_srt(["ਘਰ ਦਿਲ"])
    roman = make_srt(["♪ Ghar, dil! 12:30"])
    assert map_words(roman, native) == {"ਘਰ": "ghar", "ਦਿਲ": "dil"}


def test_map_words_strips_html_and_ass_tags():
    # Without tag stripping "<i>ghar</i>" used to become the bogus word "ighari".
    native = make_srt(["<i>ਘਰ</i> {\\an8}ਦਿਲ"])
    roman = make_srt(['<font color="#fff">ghar</font> <i>dil</i>'])
    assert map_words(roman, native) == {"ਘਰ": "ghar", "ਦਿਲ": "dil"}


def test_map_words_empty_input():
    assert map_words("", "") == {}
    assert map_words(make_srt(["ghar"]), "") == {}


def test_map_words_with_stats_counts_every_kind_of_cue():
    native = make_srt(["ਪੰਜਾਬੀ ਸੁੰਦਰ", "ਘਰ", "♪"])
    roman = make_srt(["punjabi sundar", "ghar ghar", "♪", "only in roman file"])
    mapping, stats = map_words_with_stats(roman, native)
    assert mapping == {"ਪੰਜਾਬੀ": "punjabi", "ਸੁੰਦਰ": "sundar"}
    assert stats == {
        "cues_in_both": 3,
        "cues_paired": 1,
        "cues_skipped": 1,   # "ghar ghar" (2 words) vs "ਘਰ" (1 word)
        "cues_unmatched": 1,  # cue 4 exists in the Roman file only
    }


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("All checks passed")
