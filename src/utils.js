export function formatDuration(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function normalizeFilename(value, fallback = "lecture") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return normalized || fallback;
}

export function getPreferredMimeType(MediaRecorderClass = globalThis.MediaRecorder) {
  if (!MediaRecorderClass?.isTypeSupported) return "";

  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];

  return candidates.find((type) => MediaRecorderClass.isTypeSupported(type)) || "";
}

export function recordingSupport(env = globalThis) {
  return {
    mediaDevices: Boolean(env.navigator?.mediaDevices?.getUserMedia),
    mediaRecorder: Boolean(env.MediaRecorder),
  };
}
