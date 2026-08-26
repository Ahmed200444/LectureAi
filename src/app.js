import { LectureRecorder } from "./recorder.js";
import { collectDiagnostics } from "./diagnostics.js";
import { clearWorkspace, loadWorkspace, saveWorkspace } from "./storage.js";
import { formatDuration, normalizeFilename, recordingSupport } from "./utils.js";

const $ = (selector) => document.querySelector(selector);

const elements = {
  title: $("#lecture-title"),
  notes: $("#notes"),
  saveState: $("#save-state"),
  requestMic: $("#request-mic"),
  start: $("#start-recording"),
  stop: $("#stop-recording"),
  status: $("#recording-status"),
  timer: $("#timer"),
  level: $("#mic-level"),
  audio: $("#recording-playback"),
  download: $("#download-recording"),
  clear: $("#clear-workspace"),
  diagnostics: $("#diagnostics"),
  refreshDiagnostics: $("#refresh-diagnostics"),
};

let timerId = null;
let recordingUrl = null;

const recorder = new LectureRecorder({
  onStateChange(state) {
    elements.status.textContent = stateLabel(state);
  },
  onLevel(level) {
    elements.level.value = level;
  },
});

function stateLabel(state) {
  const labels = {
    ready: "Microphone ready",
    recording: "Recording in progress",
    stopped: "Recording stopped",
  };
  return labels[state] || "Ready to check microphone";
}

function restoreWorkspace() {
  const workspace = loadWorkspace();
  elements.title.value = workspace.title;
  elements.notes.value = workspace.notes;
  elements.saveState.textContent = workspace.updatedAt
    ? `Saved locally ${new Date(workspace.updatedAt).toLocaleString()}`
    : "Not saved yet";
}

function persistWorkspace() {
  const value = saveWorkspace({
    title: elements.title.value,
    notes: elements.notes.value,
  });
  if (value?.updatedAt) {
    elements.saveState.textContent = `Saved locally ${new Date(value.updatedAt).toLocaleString()}`;
  }
}

function beginTimer() {
  const startedAt = Date.now();
  clearInterval(timerId);
  timerId = setInterval(() => {
    elements.timer.textContent = formatDuration((Date.now() - startedAt) / 1000);
  }, 250);
}

function endTimer() {
  clearInterval(timerId);
  timerId = null;
}

async function requestMicrophone() {
  elements.requestMic.disabled = true;
  elements.status.textContent = "Requesting microphone permission…";
  try {
    await recorder.requestMicrophone();
    elements.start.disabled = false;
    await renderDiagnostics();
  } catch (error) {
    elements.status.textContent = error?.message || "Microphone access failed.";
    elements.start.disabled = true;
  } finally {
    elements.requestMic.disabled = false;
  }
}

function startRecording() {
  try {
    recorder.start();
    elements.start.disabled = true;
    elements.stop.disabled = false;
    elements.download.hidden = true;
    elements.audio.hidden = true;
    elements.timer.textContent = "00:00";
    beginTimer();
  } catch (error) {
    elements.status.textContent = error?.message || "Recording could not start.";
  }
}

async function stopRecording() {
  elements.stop.disabled = true;
  endTimer();
  try {
    const blob = await recorder.stop();
    if (!blob) return;

    if (recordingUrl) URL.revokeObjectURL(recordingUrl);
    recordingUrl = URL.createObjectURL(blob);
    elements.audio.src = recordingUrl;
    elements.audio.hidden = false;

    const extension = blob.type.includes("mp4") ? "m4a" : "webm";
    const filename = `${normalizeFilename(elements.title.value)}-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.${extension}`;

    elements.download.href = recordingUrl;
    elements.download.download = filename;
    elements.download.hidden = false;
    elements.start.disabled = false;
  } catch (error) {
    elements.status.textContent = error?.message || "Recording could not be finalized.";
  }
}

async function renderDiagnostics() {
  const diagnostics = await collectDiagnostics();
  const rows = [
    ["Device", diagnostics.device],
    ["Secure context", diagnostics.secureContext ? "Yes" : "No"],
    ["Microphone API", diagnostics.mediaDevices ? "Available" : "Unavailable"],
    ["MediaRecorder", diagnostics.mediaRecorder ? "Available" : "Unavailable"],
    ["Microphone permission", diagnostics.microphonePermission],
    ["Detected microphones", diagnostics.microphones.length ? diagnostics.microphones.join(", ") : "Not labeled yet"],
    ["Network", diagnostics.online ? "Online" : "Offline"],
  ];

  elements.diagnostics.innerHTML = rows
    .map(([label, value]) => `<div class="diagnostic-row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`)
    .join("");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clearAll() {
  if (!confirm("Clear the locally saved title and notes? Your exported audio files are not affected.")) return;
  clearWorkspace();
  elements.title.value = "";
  elements.notes.value = "";
  elements.saveState.textContent = "Local workspace cleared";
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

function initialize() {
  restoreWorkspace();
  const support = recordingSupport();
  if (!support.mediaDevices || !support.mediaRecorder) {
    elements.status.textContent = "This browser does not support the complete recording workflow.";
  }

  elements.requestMic.addEventListener("click", requestMicrophone);
  elements.start.addEventListener("click", startRecording);
  elements.stop.addEventListener("click", stopRecording);
  elements.refreshDiagnostics.addEventListener("click", renderDiagnostics);
  elements.clear.addEventListener("click", clearAll);
  elements.title.addEventListener("input", persistWorkspace);
  elements.notes.addEventListener("input", persistWorkspace);
  window.addEventListener("beforeunload", () => recorder.stopStream());

  renderDiagnostics();
  registerServiceWorker();
}

initialize();
