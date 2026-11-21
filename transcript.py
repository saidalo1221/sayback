import re


MIN_PAUSE_SECONDS = 0.45
FILLER = re.compile(r"(?:u+m+|u+h+m*|e+r+m*|h+m{2,}|m{2,}|a+h+|e+h+)", re.IGNORECASE)
EDGE_PUNCTUATION = " .,!?;:…—–-‘’“”\"'()[]"


def build_transcript(words, speech_intervals):
    """Attach acoustic pauses to the word timeline and label audible disfluencies."""
    if not words:
        return []

    normalized = [word["text"].strip(EDGE_PUNCTUATION).casefold() for word in words]
    repeats = set()
    for index, word in enumerate(words):
        for width in range(min(4, (len(words) - index) // 2), 0, -1):
            boundary = index + width
            phrase = normalized[index:boundary]
            if all(phrase) and phrase == normalized[boundary:boundary + width]:
                if words[boundary]["start"] - words[boundary - 1]["end"] < 1.5:
                    repeats.update(range(index, boundary))
                    break

    gaps = iter(
        (left[1], right[0])
        for left, right in zip(speech_intervals, speech_intervals[1:])
        if right[0] - left[1] >= MIN_PAUSE_SECONDS
    )
    gap = next(gaps, None)
    items = []
    for index, word in enumerate(words):
        while gap and sum(gap) / 2 <= word["start"] + 0.08:
            start, end = gap
            if index and words[index - 1]["start"] < start and word["end"] >= end - 0.12:
                items.append({"kind": "pause", "start": round(start, 2), "duration": round(end - start, 2)})
            gap = next(gaps, None)

        kind = "word"
        if FILLER.fullmatch(normalized[index]):
            kind = "filler"
        elif index in repeats or re.fullmatch(r"[a-zA-Z]{1,5}-", word["text"]):
            kind = "repeat"
        items.append({**word, "kind": kind})
    return items
