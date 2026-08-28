import { detectDeviceKind } from './device.ts';

export function assertLiveMicrophoneStream(stream: MediaStream) {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('No microphone audio track was provided by this browser.');
  if (track.readyState !== 'live') throw new Error('The microphone audio track is not live.');
  if (!track.enabled) throw new Error('The microphone audio track is disabled.');
  // Do not reject track.muted here. Safari/iOS can report a transient muted state
  // while permission/audio routing settles even though real microphone samples arrive.
  // The live analyser below is the source of truth for whether sound is present.
  return track;
}

export async function waitForAudibleInput(stream: MediaStream, timeoutMs = 4000, threshold = 0.0015) {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return false;
  const context = new AudioContextClass();
  try {
    await context.resume().catch(() => undefined);
    // Installed iOS PWAs can temporarily keep WebAudio suspended after a permission
    // transition. That must not be mistaken for a disabled microphone.
    if (context.state !== 'running') return false;
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length);
      if (rms >= threshold) return true;
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    return false;
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function validatePlayableAudio(blob: Blob, timeoutMs = 9000) {
  if (blob.size < 1024) throw new Error('The recording is too small to contain usable lecture audio.');
  const url = URL.createObjectURL(blob);
  const isWindowsImportedFile = typeof File !== 'undefined' && blob instanceof File && detectDeviceKind() === 'windows';
  try {
    const audio = new Audio();
    audio.preload = 'metadata';
    const result = await new Promise<{ duration?: number; browserDecoded: boolean }>((resolve, reject) => {
      const acceptWindowsHelperFallback = () => {
        // Chrome/Edge can reject a transferred iPhone container that FFmpeg can still
        // decode. On Windows imports, preserve the original file and let the local
        // helper perform the authoritative decode instead of blocking at browser level.
        if (isWindowsImportedFile) resolve({ duration: undefined, browserDecoded: false });
        else reject(new Error('The saved recording could not be reloaded for playback.'));
      };
      const timer = window.setTimeout(acceptWindowsHelperFallback, timeoutMs);
      const finish = () => {
        window.clearTimeout(timer);
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined;
        resolve({ duration, browserDecoded: true });
      };
      audio.addEventListener('loadedmetadata', finish, { once: true });
      audio.addEventListener('canplay', finish, { once: true });
      audio.addEventListener('error', () => {
        window.clearTimeout(timer);
        if (isWindowsImportedFile) resolve({ duration: undefined, browserDecoded: false });
        else reject(new Error('The saved recording format could not be decoded on this device.'));
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
