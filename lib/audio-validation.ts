import { normalizeAudioMimeType } from './device';

export function assertLiveMicrophoneStream(stream: MediaStream) {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('No microphone audio track was provided by this browser.');
  if (track.readyState !== 'live') throw new Error('The microphone audio track is not live.');
  if (!track.enabled) throw new Error('The microphone audio track is disabled.');
  // Do not reject solely because track.muted is temporarily true. Safari/iOS
  // can report short mute transitions while the input route is being prepared.
  return track;
}

export async function waitForMicrophoneUnmuted(track: MediaStreamTrack, timeoutMs = 3000) {
  if (!track.muted) return true;
  return new Promise<boolean>((resolve) => {
    let finished = false;
    const finish = (value: boolean) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer);
      track.removeEventListener('unmute', handleUnmute);
      resolve(value);
    };
    const handleUnmute = () => finish(true);
    const timer = window.setTimeout(() => finish(!track.muted), timeoutMs);
    track.addEventListener('unmute', handleUnmute, { once: true });
  });
}

export async function waitForAudibleInput(stream: MediaStream, timeoutMs = 4000, threshold = 0.0015, strict = true) {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return true;
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
      if (rms >= threshold) return true;
      await new Promise((resolve) => setTimeout(resolve, 90));
    }
    if (!strict) return false;
    throw new Error('No live microphone input was detected. Speak or make a small sound near the device, check microphone permission, then retry.');
  } finally {
    await context.close().catch(() => undefined);
  }
}

function normalizedPlayableBlob(blob: Blob) {
  const filename = blob instanceof File ? blob.name : '';
  const mimeType = normalizeAudioMimeType(blob.type, filename);
  return blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
}

export async function validatePlayableAudio(blob: Blob, timeoutMs = 9000) {
  if (blob.size < 1024) throw new Error('The recording is too small to contain usable lecture audio.');
  const playableBlob = normalizedPlayableBlob(blob);
  const url = URL.createObjectURL(playableBlob);
  try {
    const audio = new Audio();
    audio.preload = 'metadata';
    const result = await new Promise<{ duration?: number; mimeType: string }>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('The saved recording could not be reloaded for playback.')), timeoutMs);
      const finish = () => {
        window.clearTimeout(timer);
        const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : undefined;
        resolve({ duration, mimeType: playableBlob.type });
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

/** Decode only short test recordings and verify they contain actual signal.
 * This is intentionally used for the microphone test, not long lectures. */
export async function validateAudibleSample(blob: Blob, minimumRms = 0.0008) {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return { audible: true, rms: undefined as number | undefined, peak: undefined as number | undefined };
  const playableBlob = normalizedPlayableBlob(blob);
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await playableBlob.arrayBuffer());
    if (!decoded.length || !decoded.numberOfChannels) throw new Error('The saved microphone sample contains no decodable audio frames.');
    const channel = decoded.getChannelData(0);
    const stride = Math.max(1, Math.floor(channel.length / 160_000));
    let sumSquares = 0;
    let peak = 0;
    let count = 0;
    for (let index = 0; index < channel.length; index += stride) {
      const value = channel[index] || 0;
      sumSquares += value * value;
      peak = Math.max(peak, Math.abs(value));
      count += 1;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, count));
    return { audible: rms >= minimumRms || peak >= minimumRms * 5, rms, peak };
  } finally {
    await context.close().catch(() => undefined);
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
