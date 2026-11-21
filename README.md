# Sayback

Sayback is a local IELTS Speaking studio. Record with your microphone or upload a voice message. Review the timestamped transcript, mark any missed hesitations in the editor, and share the text in a regular ChatGPT chat.

## Start the app

On Windows with Python 3.12 installed, double-click **Start Sayback.cmd**. This installs the dependencies on the first run and opens [the studio](http://127.0.0.1:8765/). Keep the launcher open while you use the app.

To run from PowerShell:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py --open
```

The first transcription downloads the English Whisper `small.en` model (about 460 MB). You can download it ahead of time with `.\.venv\Scripts\python.exe app.py --prepare`. After that, transcription works offline. Recordings stay in the current browser tab and in memory during transcription. Download the transcript and audio before you close the tab if you want to keep them.

## Review and share

- Click **Start recording**, speak, then click **Stop & transcribe**. You can also upload or drop a voice message onto the recorder, or try the included synthetic sample. The limit is 15 minutes and 60 MB per file.
- Sayback highlights fillers and repetitions that Whisper transcribes. It also estimates pauses of at least 0.45 seconds from the audio between speech segments. It keeps the original audio so you can listen to a timestamp and edit missed fillers, false starts, or corrections. A pause can be natural, and Whisper can miss or mishear soft speech.
- **Copy for ChatGPT** and **Download .txt** include the transcript and an IELTS feedback request. Open your usual ChatGPT chat and paste the text or attach the `.txt` file. The original recording is available separately. Pronunciation and intonation require listening to the audio.

## Checks

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests
```
