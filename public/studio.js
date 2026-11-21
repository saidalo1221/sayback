import { prompts } from './practice.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const canvas = $('waveform');
const paint = canvas.getContext('2d');
const maxBytes = 60 * 1024 * 1024;
const maxRecordingMs = 14 * 60 * 1000 + 58 * 1000;
const promptIndexes = {1: 0, 2: 0, 3: 0};

let mode = 'idle';
let capture = null;
let source = null;
let transcript = null;
let editedText = null;
let bars = null;
let playbackReady = false;
let playbackFailed = false;

const modes = {
  idle: ['Ready to record', 'MIC INPUT', 'Start recording', 'microphone'],
  requesting: ['Waiting for mic', 'MIC INPUT', 'Starting…', 'microphone'],
  recording: ['Recording', 'LIVE INPUT', 'Stop & transcribe', 'stop'],
  finishing: ['Saving recording', 'MIC INPUT', 'Finishing…', 'stop'],
  processing: ['Transcribing', 'WHISPER', 'Start recording', 'microphone'],
  ready: ['Audio ready', 'PLAYBACK', 'New recording', 'microphone'],
};

function clock(seconds) {
  const total = Math.max(0, Math.floor(seconds) || 0);
  return [Math.floor(total / 60), total % 60].map((part) => String(part).padStart(2, '0')).join(':');
}

function pauseLength(duration) {
  return `${Number(duration.toFixed(2))}s`;
}

function announce(message) {
  $('announcement').textContent = message;
}

function errorMessage(message = '') {
  $('recorder-error').textContent = message;
  $('recorder-error').hidden = !message;
  $('upload-note').hidden = !!message;
}

function acceptsAudio() {
  return mode === 'idle' || mode === 'ready';
}

function setMode(next) {
  mode = next;
  const [label, caption, button, icon] = modes[mode];
  $('recording-display').dataset.mode = mode;
  $('recording-label').textContent = label;
  $('recording-caption').textContent = caption;
  $('record').querySelector('span').textContent = button;
  $('record').querySelector('i').className = `ph ph-${icon}`;
  $('record').disabled = !acceptsAudio() && mode !== 'recording';
  $('upload').disabled = !acceptsAudio();
  $('sample').disabled = !acceptsAudio();
  $('audio-controls').hidden = !source || ['requesting', 'recording', 'finishing'].includes(mode);
  const canExport = Boolean(transcript) && acceptsAudio();
  for (const control of ['edit-open', 'copy-text', 'download-text', 'copy-feedback']) $(control).disabled = !canExport;
  drawWave();
}

const idleBars = Array.from({length: 100}, (_, index) => {
  const t = index / 99;
  const group = 0.22 + 0.43 * Math.exp(-((t - 0.3) ** 2) / 0.010) + 0.69 * Math.exp(-((t - 0.64) ** 2) / 0.028);
  const rhythm = 0.23 + 0.50 * Math.abs(Math.sin(index * 0.48 + 0.9)) + 0.24 * Math.abs(Math.sin(index * 2.7));
  return Math.min(1, Math.sin(Math.PI * t) ** 0.72 * group * rhythm);
});

function drawWave(levels = null) {
  if (!paint || !canvas.width || !canvas.height) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  paint.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  paint.clearRect(0, 0, width, height);
  const placeholder = !levels && !bars;
  const values = levels ?? bars ?? idleBars;
  const margin = 18;
  const count = Math.min(values.length, Math.floor((width - margin * 2) / 4));
  const step = (width - margin * 2) / count;
  const middle = height * 0.5;
  const tint = paint.createLinearGradient(0, 0, width, 0);
  tint.addColorStop(0, '#89a0fc');
  tint.addColorStop(0.5, '#c9d7ff');
  tint.addColorStop(1, '#adc3ff');
  const duration = audioDuration();
  const progress = !placeholder && !levels && duration ? audio.currentTime / duration : 0;
  for (let index = 0; index < count; index++) {
    const value = values[Math.floor(index / count * values.length)];
    const barHeight = Math.max(2, value * Math.min(height * 0.48, 105));
    const barWidth = Math.min(2.7, step * 0.58);
    const x = margin + (index + 0.5) * step;
    paint.beginPath();
    paint.roundRect(x - barWidth / 2, middle - barHeight / 2, barWidth, barHeight, 2);
    const played = index / count < progress;
    paint.globalAlpha = played ? 1 : (placeholder ? 0.29 + 0.62 * value : 0.68);
    paint.fillStyle = played ? '#fff' : tint;
    paint.fill();
  }
  paint.globalAlpha = 1;
}

new ResizeObserver(() => {
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * scale);
  canvas.height = Math.round(canvas.clientHeight * scale);
  drawWave(capture?.levels);
}).observe(canvas);

function tickRecording(session, now) {
  if (capture !== session || mode !== 'recording') return;
  if (now - session.lastFrame > 40) {
    $('recording-time').textContent = clock((now - session.started) / 1000);
    if (session.analyser) {
      session.analyser.getByteTimeDomainData(session.samples);
      let energy = 0;
      for (const sample of session.samples) energy += ((sample - 128) / 128) ** 2;
      session.levels.shift();
      session.levels.push(Math.min(1, Math.sqrt(energy / session.samples.length) * 5));
    }
    drawWave(session.levels);
    session.lastFrame = now;
  }
  session.frame = requestAnimationFrame((time) => tickRecording(session, time));
}

function connectMeter(session) {
  try {
    session.context = new AudioContext();
    session.analyser = session.context.createAnalyser();
    session.analyser.fftSize = 512;
    session.samples = new Uint8Array(session.analyser.fftSize);
    session.context.createMediaStreamSource(session.stream).connect(session.analyser);
    session.context.resume().catch(() => {});
  } catch {
    session.analyser = null;
  }
}

function releaseCapture(session) {
  clearTimeout(session.limit);
  cancelAnimationFrame(session.frame);
  session.stream.getTracks().forEach((track) => track.stop());
  session.context?.close().catch(() => {});
  if (capture === session) capture = null;
}

function restoreRecorder() {
  $('recording-time').textContent = clock(audioDuration());
  setMode(source ? 'ready' : 'idle');
}

function finishCapture(session) {
  if (capture !== session) return;
  releaseCapture(session);
  if (session.failed || !session.chunks.length) {
    restoreRecorder();
    errorMessage('This recording did not save. Try your microphone again or upload an audio file.');
    return;
  }
  const type = session.recorder.mimeType.split(';')[0] || session.chunks[0].type || 'audio/webm';
  const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  const blob = new Blob(session.chunks, {type});
  submitAudio(blob, `ielts-recording.${extension}`, session.prompt, 'recording', (performance.now() - session.started) / 1000);
}

async function startCapture() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    errorMessage('Microphone recording is unavailable in this browser. You can still upload an audio file.');
    return;
  }
  errorMessage();
  audio.pause();
  const prompt = selectedPrompt();
  setMode('requesting');
  let stream;
  let session;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false},
    });
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? {mimeType} : undefined);
    session = {stream, recorder, prompt, chunks: [], levels: Array(100).fill(0), lastFrame: 0};
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) session.chunks.push(event.data); });
    recorder.addEventListener('error', () => { session.failed = true; });
    recorder.addEventListener('stop', () => finishCapture(session), {once: true});
    connectMeter(session);
    recorder.start(250);
    session.started = performance.now();
    capture = session;
    session.limit = setTimeout(() => {
      announce('Recording limit reached. Transcribing your audio.');
      stopCapture();
    }, maxRecordingMs);
    $('recording-time').textContent = '00:00';
    setMode('recording');
    announce('Recording started.');
    session.frame = requestAnimationFrame((time) => tickRecording(session, time));
  } catch (error) {
    if (session) releaseCapture(session);
    else stream?.getTracks().forEach((track) => track.stop());
    restoreRecorder();
    const messages = {
      NotAllowedError: 'Microphone access was denied. Allow it in your browser, or upload a voice message.',
      NotFoundError: 'No microphone was found. Connect one, or upload a voice message.',
      NotReadableError: 'The microphone is busy or unavailable. Check your microphone and try again.',
    };
    errorMessage(messages[error.name] ?? 'The microphone could not start. Try again or upload a voice message.');
  }
}

function stopCapture() {
  if (!capture || capture.recorder.state === 'inactive') return;
  setMode('finishing');
  capture.recorder.stop();
}

function audioDuration() {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
  return transcript?.duration ?? source?.duration ?? 0;
}

function updatePlayback() {
  const duration = audioDuration();
  if (source && !capture) $('recording-time').textContent = clock(duration);
  $('playback-time').textContent = clock(audio.currentTime);
  $('seek').max = duration;
  $('seek').value = audio.currentTime;
  $('seek').disabled = !playbackReady || !duration;
  $('play-button').disabled = !playbackReady;
  const action = audio.paused ? 'Play' : 'Pause';
  $('play-button').setAttribute('aria-label', `${action} audio`);
  $('play-button').title = playbackFailed ? 'Download the audio to hear it in another player' : `${action} audio`;
  $('play-button').querySelector('i').className = `ph ph-${action.toLowerCase()}`;
  for (const button of $('transcript-content').querySelectorAll('button[data-seek]')) button.disabled = !playbackReady;
  if (!capture) drawWave();
}

for (const event of ['durationchange', 'timeupdate', 'play', 'pause', 'ended']) audio.addEventListener(event, updatePlayback);
audio.addEventListener('loadedmetadata', () => { playbackReady = true; updatePlayback(); });
audio.addEventListener('error', () => {
  if (!audio.error) return;
  playbackReady = false;
  playbackFailed = true;
  updatePlayback();
  if (source) errorMessage('This browser could not play the original file. You can still download it.');
});

function playAt(time) {
  if (!playbackReady) return;
  if (time !== undefined) audio.currentTime = Math.max(0, time);
  const active = source;
  audio.play().catch((error) => {
    if (source === active && error.name !== 'AbortError') {
      errorMessage('Playback could not start. Try playing or downloading the audio again.');
    }
  });
}

function setSource(blob, name, prompt, kind, duration) {
  const previous = source;
  audio.pause();
  transcript = null;
  editedText = null;
  bars = null;
  playbackReady = false;
  playbackFailed = false;
  source = {blob, name, prompt, kind, duration, url: URL.createObjectURL(blob)};
  $('upload-note').textContent = kind === 'recording' ? 'Microphone recording' : name;
  audio.src = source.url;
  audio.load();
  if (previous) URL.revokeObjectURL(previous.url);
  $('transcript-content').replaceChildren();
  updatePlayback();
}

function showTranscript(view) {
  $('transcript-surface').dataset.mode = view;
  $('transcript-empty').hidden = view !== 'empty';
  $('transcript-status').hidden = !['loading', 'error'].includes(view);
  $('transcript-content').hidden = view !== 'result';
  $('edit-open').hidden = view !== 'result';
  $('retry').hidden = view !== 'error' || !source;
  $('status-icon').querySelector('i').className = `ph ph-${view === 'error' ? 'warning-circle' : 'circle-notch'}`;
}

function loadingText(stage) {
  const messages = {
    loading: ['Getting Whisper ready…', 'The first model download can take a few minutes.'],
    transcribing: ['Transcribing your audio…', 'Whisper is listening for words and hesitations.'],
    decoding: ['Reading your audio…', 'Checking for speech and quiet sections.'],
  };
  const [title, description] = messages[stage] ?? ['Preparing your audio…', 'The recording stays on this device.'];
  $('status-title').textContent = title;
  $('status-description').textContent = description;
}

async function transcribeSource() {
  const active = source;
  setMode('processing');
  loadingText();
  showTranscript('loading');
  const polling = setInterval(async () => {
    try {
      const response = await fetch('/api/status');
      const {stage} = await response.json();
      if (mode === 'processing' && source === active) loadingText(stage);
    } catch { /* The transcription request handles a connection failure. */ }
  }, 900);
  try {
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: {'Content-Type': 'application/octet-stream'},
      body: active.blob,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The recording could not be transcribed.');
    transcript = data;
    bars = data.waveform;
    renderTranscript();
    showTranscript('result');
    announce('Transcript ready. You can listen back, edit, or export it.');
  } catch (error) {
    transcript = null;
    $('status-title').textContent = 'Transcription unavailable';
    $('status-description').textContent = error instanceof TypeError
      ? 'The local studio lost its connection. Make sure Sayback is running, then retry.'
      : error.message;
    showTranscript('error');
  } finally {
    clearInterval(polling);
    setMode('ready');
    updatePlayback();
  }
}

function submitAudio(blob, name, prompt = null, kind = 'upload', duration = 0) {
  if (!blob.size || blob.size > maxBytes) {
    restoreRecorder();
    errorMessage(blob.size ? 'Choose an audio file under 60 MB.' : 'This file is empty. Choose another audio file.');
    return;
  }
  errorMessage();
  setSource(blob, name, prompt, kind, duration);
  transcribeSource();
}

function transcriptRows() {
  const rows = [];
  let row;
  for (const item of transcript.items) {
    const previous = row?.items.at(-1);
    if (!row || (item.kind !== 'pause' && (item.start - row.start >= 13 || (previous?.kind === 'pause' && previous.duration >= 1.1)))) {
      row = {start: item.start, items: []};
      rows.push(row);
    }
    row.items.push(item);
  }
  return rows;
}

function timestampButton(time, className, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.dataset.seek = time;
  button.disabled = !playbackReady;
  button.setAttribute('aria-label', label);
  return button;
}

function renderTranscript() {
  const surface = $('transcript-content');
  surface.replaceChildren();
  if (editedText !== null) {
    const text = document.createElement('p');
    text.className = 'edited-transcript';
    text.textContent = editedText;
    surface.append(text);
    return;
  }

  for (const row of transcriptRows()) {
    const line = document.createElement('div');
    const body = document.createElement('p');
    line.className = 'transcript-row';
    const stamp = timestampButton(row.start, 'timestamp', `Play from ${clock(row.start)}`);
    stamp.textContent = clock(row.start);
    for (const [index, item] of row.items.entries()) {
      if (index) body.append(' ');
      if (item.kind === 'word') {
        body.append(item.text);
        continue;
      }
      const label = item.kind === 'pause' ? `Pause of ${pauseLength(item.duration)}` : item.text;
      const marker = timestampButton(item.start, `marker ${item.kind}`, `Listen at ${clock(item.start)}. ${label}`);
      if (item.kind === 'pause') {
        const icon = document.createElement('i');
        icon.className = 'ph ph-pause';
        icon.setAttribute('aria-hidden', 'true');
        marker.append(icon, pauseLength(item.duration));
      } else {
        marker.textContent = item.text;
      }
      body.append(marker);
    }
    line.append(stamp, body);
    surface.append(line);
  }
  surface.scrollTop = 0;
}

function whisperText() {
  return transcriptRows().map((row) => {
    const line = row.items.map((item) => item.kind === 'pause' ? `[pause ${pauseLength(item.duration)}]` : item.text).join(' ');
    return `[${clock(row.start)}] ${line}`;
  }).join('\n');
}

function transcriptText() {
  return editedText ?? whisperText();
}

function feedbackText() {
  const title = source.kind === 'sample' ? 'IELTS Speaking practice — sample answer' : 'IELTS Speaking practice';
  const context = source.prompt ? `${source.prompt.part}\nPrompt: ${source.prompt.text}\n` : '';
  return `${title}\n${context}Recording length: ${clock(transcript.duration)}\n\n`
    + 'Please give me IELTS Speaking feedback on this answer. Cover fluency and coherence, lexical resource, and grammatical range and accuracy. '
    + 'Use examples from my answer, distinguish natural pauses from disruptive hesitation, and finish with one short practice drill. '
    + 'Estimate a band only for the criteria you can assess. If you can listen to the audio, also assess pronunciation. If you only have the transcript, leave pronunciation unscored. '
    + 'The transcript may contain recognition errors. Bracketed pauses give estimated quiet durations.\n\nTranscript\n'
    + transcriptText() + '\n';
}

async function copy(value, button) {
  const text = button.querySelector('span');
  try {
    await navigator.clipboard.writeText(value);
    const previousTimer = Number(button.dataset.timer);
    if (previousTimer) clearTimeout(previousTimer);
    text.textContent = 'Copied';
    announce('Copied to your clipboard.');
    button.dataset.timer = setTimeout(() => { text.textContent = button.dataset.label; }, 1600);
  } catch {
    announce('Clipboard access failed. You can download the transcript or select and copy it from the editor.');
    text.textContent = 'Copy failed';
    clearTimeout(Number(button.dataset.timer));
    button.dataset.timer = setTimeout(() => { text.textContent = button.dataset.label; }, 2200);
  }
}

function download(url, name) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
}

function selectedPrompt() {
  const part = $('part').value;
  return {part: `Part ${part}`, text: prompts[part][promptIndexes[part]]};
}

function showPrompt() {
  $('prompt').textContent = selectedPrompt().text;
}

$('record').addEventListener('click', () => {
  if (mode === 'recording') stopCapture();
  else if (acceptsAudio()) startCapture();
});
$('upload').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file && acceptsAudio()) submitAudio(file, file.name);
  event.target.value = '';
});

function hasFiles(event) {
  return Array.from(event.dataTransfer.types).includes('Files');
}

const dropTarget = $('recorder-panel');
dropTarget.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = acceptsAudio() ? 'copy' : 'none';
  dropTarget.classList.toggle('dragging', acceptsAudio());
});
dropTarget.addEventListener('dragleave', (event) => {
  if (!dropTarget.contains(event.relatedTarget)) dropTarget.classList.remove('dragging');
});
document.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault(); });
document.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dropTarget.classList.remove('dragging');
  const file = event.dataTransfer.files[0];
  if (file && acceptsAudio() && dropTarget.contains(event.target)) submitAudio(file, file.name);
});

$('sample').addEventListener('click', async () => {
  if (!acceptsAudio()) return;
  errorMessage();
  setMode('processing');
  loadingText();
  showTranscript('loading');
  try {
    const response = await fetch('/assets/sample.wav');
    if (!response.ok) throw new Error('Sample unavailable');
    const blob = await response.blob();
    submitAudio(blob, 'sayback-sample.wav', {part: 'Part 1', text: prompts[1][0]}, 'sample');
  } catch {
    setMode('idle');
    showTranscript('empty');
    errorMessage('The sample could not be loaded. Try again, record, or upload a voice message.');
  }
});
$('retry').addEventListener('click', () => { if (source && acceptsAudio()) transcribeSource(); });
$('play-button').addEventListener('click', () => { if (audio.paused) playAt(); else audio.pause(); });
$('seek').addEventListener('input', (event) => { audio.currentTime = Number(event.target.value); });
$('download-audio').addEventListener('click', () => { if (source) download(source.url, source.name); });
$('transcript-content').addEventListener('click', (event) => {
  const control = event.target.closest('button[data-seek]');
  if (control) playAt(Number(control.dataset.seek));
});

$('help-open').addEventListener('click', () => $('help-dialog').showModal());
$('edit-open').addEventListener('click', () => {
  $('edit-text').value = transcriptText();
  $('edit-dialog').showModal();
  $('edit-text').focus();
});
$('edit-close').addEventListener('click', () => $('edit-dialog').close());
$('edit-reset').addEventListener('click', () => { $('edit-text').value = whisperText(); });
$('edit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('edit-text').value.trim();
  if (!text) { $('edit-text').focus(); return; }
  editedText = text === whisperText() ? null : text;
  $('edit-dialog').close();
  renderTranscript();
  announce('Transcript updated.');
});

$('part').addEventListener('change', showPrompt);
$('next-prompt').addEventListener('click', () => {
  const part = $('part').value;
  promptIndexes[part] = (promptIndexes[part] + 1) % prompts[part].length;
  showPrompt();
});

for (const [id, getText] of [['copy-text', transcriptText], ['copy-feedback', feedbackText]]) {
  const button = $(id);
  button.dataset.label = button.querySelector('span').textContent;
  button.addEventListener('click', () => copy(getText(), button));
}
$('download-text').addEventListener('click', () => {
  const file = new Blob([feedbackText()], {type: 'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(file);
  const name = source.name.replace(/\.[^.]+$/, '');
  download(url, `${name || 'ielts-practice'}-transcript.txt`);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
});

showPrompt();
setMode('idle');
