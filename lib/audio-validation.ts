import { detectDeviceKind, preferredRecordingMimeType } from './device.ts';

export function assertLiveMicrophoneStream(stream: MediaStream) {
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('No microphone audio track was provided by this browser.');
  if (track.readyState !== 'live') throw new Error('The microphone audio track is not live.');
  if (!track.enabled) throw new Error('The microphone audio track is disabled.');
  // Do not reject track.muted here. Safari/iOS can report a transient muted state
  // while permission/audio routing settles even though real microphone samples arrive.
  // Recorded probe data and the live analyser are the source of truth instead.
  return track;
}

export async function waitForAudibleInput(stream: MediaStream, timeoutMs = 4000, threshold = 0.0015): Promise<boolean | null> {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  const context = new AudioContextClass();
  try {
    await context.resume().catch(() => undefined);
    // Installed iOS PWAs can temporarily keep WebAudio suspended after a permission
    // transition. That must not be mistaken for a disabled microphone.
    if (context.state !== 'running') return null;
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

async function decodedSignalLevel(blob: Blob) {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('This browser cannot verify recorded microphone audio.');
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (!decoded.length || !decoded.numberOfChannels) return { rms: 0, peak: 0, selectedChannel: 0 };

    // Some iPhone/iPad recordings can expose a nearly silent channel beside the real
    // microphone channel. Validate the strongest encoded channel rather than assuming
    // channel 0 is the audible one.
    let strongest = { rms: 0, peak: 0, selectedChannel: 0 };
    for (let channelIndex = 0; channelIndex < decoded.numberOfChannels; channelIndex += 1) {
      const channel = decoded.getChannelData(channelIndex);
      const stride = Math.max(1, Math.floor(channel.length / 48_000));
      let sum = 0;
      let count = 0;
      let peak = 0;
      for (let index = 0; index < channel.length; index += stride) {
        const value = Math.abs(channel[index] || 0);
        peak = Math.max(peak, value);
        sum += value * value;
        count += 1;
      }
      const rms = count ? Math.sqrt(sum / count) : 0;
      if (rms > strongest.rms || (rms === strongest.rms && peak > strongest.peak)) {
        strongest = { rms, peak, selectedChannel: channelIndex };
      }
    }
    return strongest;
  } finally {
    await context.close().catch(() => undefined);
  }
}

/**
 * Proves that the exact live microphone stream can produce non-silent encoded audio.
 * This intentionally does not trust Safari's transient MediaStreamTrack.muted flag.
 */
export async function verifyMicrophoneCapture(stream: MediaStream, timeoutMs = 1800) {
  assertLiveMicrophoneStream(stream);
  if (typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record microphone audio.');

  const preferredMimeType = preferredRecordingMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = preferredMimeType
      ? new MediaRecorder(stream, { mimeType: preferredMimeType, audioBitsPerSecond: 192_000 })
      : new MediaRecorder(stream, { audioBitsPerSecond: 192_000 });
  } catch {
    recorder = new MediaRecorder(stream);
  }
  const chunks: Blob[] = [];
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => resolve(), { once: true });
    recorder.addEventListener('error', () => reject(new Error('The iPhone/iPad microphone probe could not be recorded.')), { once: true });
  });

  recorder.start(250);
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  if (recorder.state === 'recording') {
    recorder.requestData();
    recorder.stop();
  }
  await stopped;

  const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || 'audio/mp4' });
  if (blob.size < 700) {
    throw new Error('Microphone permission is on, but the device did not produce usable audio. Close and reopen LectureAI, check the microphone, then try again.');
  }

  try {
    const signal = await decodedSignalLevel(blob);
    // These thresholds reject digital silence while allowing quiet classrooms and distant speech.
    if (signal.peak < 0.0008 && signal.rms < 0.00015) {
      throw new Error('Microphone permission is on, but the captured sample is silent. Close and reopen LectureAI, check the microphone, then try again.');
    }
    return { blob, signal };
  } catch (error) {
    if (error instanceof Error && /captured sample is silent/i.test(error.message)) throw error;
    // If Safari cannot decode its own short probe, fall back to an independent analyser check.
    const audible = await waitForAudibleInput(stream, 2500, 0.0008);
    if (audible === true) return { blob, signal: undefined };
    throw new Error('LectureAI could not prove that real microphone audio is reaching the recorder. Close and reopen the app, then retry before starting the lecture.');
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
