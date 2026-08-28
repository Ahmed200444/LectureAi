export function assertLiveMicrophoneStream(stream: MediaStream) {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('No microphone audio track was provided by this browser.');
  if (track.readyState !== 'live') throw new Error('The microphone audio track is not live.');
  if (!track.enabled) throw new Error('The microphone audio track is disabled.');
  if (track.muted) throw new Error('The microphone is muted. Check microphone permission and input settings, then retry.');
  return track;
}

export async function waitForAudibleInput(stream: MediaStream, timeoutMs = 4000, threshold = 0.0015) {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  try {
    await context.resume().catch(() => undefined);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length);
      if (rms >= threshold) return;
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    throw new Error('No live microphone input was detected. Speak or make a small sound near the device, check microphone permission, then retry.');
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function validatePlayableAudio(blob: Blob, timeoutMs = 9000) {
  if (blob.size < 1024) throw new Error('The recording is too small to contain usable lecture audio.');
  const url = URL.createObjectURL(blob);
  try {
    const audio = new Audio();
    audio.preload = 'metadata';
    const result = await new Promise<{ duration?: number }>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('The saved recording could not be reloaded for playback.')), timeoutMs);
      const finish = () => {
        window.clearTimeout(timer);
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined;
        resolve({ duration });
      };
      audio.addEventListener('loadedmetadata', finish, { once: true });
      audio.addEventListener('canplay', finish, { once: true });
      audio.addEventListener('error', () => {
        window.clearTimeout(timer);
        reject(new Error('The saved recording format could not be decoded on this device.'));
      }, { once: true });
      audio.src = url;
      audio.load();
    });
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function microphonePermissionState() {
  try {
    if (!navigator.permissions?.query) return 'unknown';
    const state = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return state.state;
  } catch {
    return 'unknown';
  }
}
