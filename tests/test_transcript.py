import unittest

from transcript import build_transcript


class TranscriptTests(unittest.TestCase):
    def test_annotates_fillers_repeats_and_quiet_time_in_order(self):
        words = [
            {"text": "Um,", "start": 0.2, "end": 0.55},
            {"text": "I", "start": 0.56, "end": 0.7},
            {"text": "I", "start": 0.73, "end": 0.82},
            {"text": "walked.", "start": 1.68, "end": 2.15},
        ]

        transcript = build_transcript(words, [(0.15, 0.85), (1.65, 2.2)])

        self.assertEqual([item["kind"] for item in transcript], ["filler", "repeat", "word", "pause", "word"])
        self.assertEqual(transcript[3]["duration"], 0.8)
        self.assertEqual([item["text"] for item in transcript if item["kind"] != "pause"], [word["text"] for word in words])

    def test_skips_edges_and_quiet_time_under_the_threshold(self):
        words = [
            {"text": "Well,", "start": 1.0, "end": 1.2},
            {"text": "maybe.", "start": 1.53, "end": 2.0},
        ]

        transcript = build_transcript(words, [(0.9, 1.21), (1.52, 2.1)])

        self.assertEqual([item["kind"] for item in transcript], ["word", "word"])
        self.assertEqual(build_transcript([], []), [])

    def test_reports_no_silence_during_untranscribed_speech(self):
        words = [
            {"text": "It", "start": 0.0, "end": 0.2},
            {"text": "was.", "start": 1.6, "end": 2.0},
        ]

        transcript = build_transcript(words, [(0.0, 2.0)])

        self.assertEqual([item["kind"] for item in transcript], ["word", "word"])


if __name__ == "__main__":
    unittest.main()
