import io
import os
import threading
from pathlib import Path

import av
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.utils import download_model
from faster_whisper.vad import VadOptions, get_speech_timestamps
from huggingface_hub.errors import LocalEntryNotFoundError

from transcript import MIN_PAUSE_SECONDS, build_transcript


SAMPLE_RATE = 16_000
MAX_SECONDS = 15 * 60
MAX_BYTES = 60 * 1024 * 1024
MODEL_NAME = "small.en"
VERBATIM_PROMPT = "Um, well, I, I think it was, uh, Tuesday. Erm, we went on Thurs- Thursday, I mean Friday. Hmm, let me think."


class AudioError(ValueError):
    pass


def decode_audio(source):
    pcm = io.BytesIO()
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)

    def append_frames(frames):
        for frame in frames:
            pcm.write(frame.to_ndarray().tobytes())
            if pcm.tell() > MAX_SECONDS * SAMPLE_RATE * 2:
                raise AudioError("Choose an audio file under 15 minutes, or split it into shorter recordings.")

    try:
        with av.open(source, mode="r") as container:
            if not container.streams.audio:
                raise AudioError("This file does not contain an audio track.")
            for frame in container.decode(audio=0):
                append_frames(resampler.resample(frame))
            append_frames(resampler.resample(None))
    except av.FFmpegError as error:
        raise AudioError("This audio could not be read. Try an MP3, M4A, WAV, WebM, or OGG file.") from error

    audio = np.frombuffer(pcm.getbuffer(), dtype=np.int16).astype(np.float32) / 32768
    if audio.size < SAMPLE_RATE // 5:
        raise AudioError("This recording is too short. Try recording a complete sentence.")
    return audio


def waveform(audio):
    count = 100
    window = audio.size // count
    frames = audio[:window * count].reshape(count, window)
    peaks = np.sqrt(np.mean(frames * frames, axis=1))
    ceiling = max(0.01, float(np.quantile(peaks, 0.92)))
    return np.clip(peaks / ceiling, 0, 1).round(3).tolist()


class Transcriber:
    def __init__(self):
        self.job = threading.Lock()
        self.model = None
        self.stage = "idle"

    def load_model(self):
        if self.model is None:
            self.stage = "loading"
            try:
                model_path = download_model(MODEL_NAME, local_files_only=True)
            except LocalEntryNotFoundError:
                model_path = None
            required = ("model.bin", "config.json", "tokenizer.json", "vocabulary.txt")
            if not model_path or not all((Path(model_path) / name).is_file() for name in required):
                model_path = download_model(MODEL_NAME)
            self.model = WhisperModel(
                model_path, device="cpu", compute_type="int8",
                cpu_threads=min(4, max(1, (os.cpu_count() or 2) // 2)),
            )
        return self.model

    def transcribe(self, source):
        self.stage = "decoding"
        audio = decode_audio(source)
        speech = get_speech_timestamps(audio, VadOptions(
            threshold=0.32, min_speech_duration_ms=80,
            min_silence_duration_ms=300, speech_pad_ms=0,
        ))
        if not speech:
            raise AudioError("No clear speech was detected. Try speaking closer to the microphone or choose another file.")

        model = self.load_model()
        self.stage = "transcribing"
        segments, _ = model.transcribe(
            audio, language="en", beam_size=5, word_timestamps=True,
            initial_prompt=VERBATIM_PROMPT, condition_on_previous_text=False,
            vad_filter=False,
        )

        words = []
        for segment in segments:
            if segment.words:
                words.extend(
                    {"text": word.word.strip(), "start": word.start, "end": word.end}
                    for word in segment.words if word.word.strip()
                )
            elif segment.text.strip():
                words.append({"text": segment.text.strip(), "start": segment.start, "end": segment.end})

        if not words:
            raise AudioError("Whisper could not make out any words. The audio is still available for replay.")

        intervals = [(part["start"] / SAMPLE_RATE, part["end"] / SAMPLE_RATE) for part in speech]
        return {
            "items": build_transcript(words, intervals),
            "duration": round(audio.size / SAMPLE_RATE, 3),
            "waveform": waveform(audio),
            "pauseThreshold": MIN_PAUSE_SECONDS,
        }
