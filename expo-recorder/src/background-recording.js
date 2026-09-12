// Pure foreground decision used by App.js and regression tests. UI may only show
// RECORDING after the native recorder reports isRecording=true.
export function foregroundRecorderDecision({ sessionActive, paused, statusAvailable, isRecording }) {
  if (!sessionActive) return 'idle';
  if (paused) return 'paused';
  if (!statusAvailable) return 'unconfirmed';
  return isRecording ? 'recording' : 'stopped';
}
