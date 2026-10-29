"""Run with:  python test_mapper.py   (or: pytest)"""
from mapper import clean_word, decode_srt, map_words, parse_srt_content


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


def test_decode_srt():
    raw = "\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\nਘਰ\r\n".encode("utf-8")
    assert decode_srt(raw) == "1\n00:00:01,000 --> 00:00:02,000\nਘਰ\n"


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


def test_map_words_empty_input():
    assert map_words("", "") == {}
    assert map_words(make_srt(["ghar"]), "") == {}


if __name__ == "__main__":
    test_parse_srt_content()
    test_decode_srt()
    test_clean_word()
    test_map_words_pairs_equal_cues()
    test_map_words_skips_unequal_word_counts()
    test_map_words_only_uses_cues_present_in_both_files()
    test_map_words_first_spelling_wins()
    test_map_words_strips_noise_and_lowercases_roman()
    test_map_words_empty_input()
    print("All checks passed")
