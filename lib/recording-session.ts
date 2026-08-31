let activeRecording = false;

const EVENT_NAME = 'lectureai-recording-session-change';

export function setRecordingSessionActive(active: boolean) {
  if (activeRecording === active) return;
  activeRecording = active;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { active } }));
  }
}

export function isRecordingSessionActive() {
  return activeRecording;
}

export function onRecordingSessionChange(listener: (active: boolean) => void) {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ active?: boolean }>).detail;
    listener(Boolean(detail?.active));
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
