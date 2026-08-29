import type { TranscriptionProgress } from './transcription.ts';

type WorkerMessage = {
  type: 'model-progress' | 'model-ready' | 'transcription-progress' | 'result' | 'error';
  id?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  model?: string;
  precision?: string;
  message?: string;
  payload?: unknown;
};

let sharedWorker: Worker | null = null;

function worker() {
  if (!sharedWorker) sharedWorker = new Worker(new URL('./phone-transcriber.worker.ts', import.meta.url), { type: 'module', name: 'lectureai-phone-transcriber' });
  return sharedWorker;
}

function resetWorker(instance: Worker) {
  if (sharedWorker === instance) {
    instance.terminate();
    sharedWorker = null;
  }
}

/**
 * Boost quiet/distant speech only in the disposable transcription copy.
 * The original recording Blob is never changed. Gain is capped to avoid turning
 * classroom noise into clipping when the professor is far from the device.
 */
function normalizeSpeechForTranscriptionInPlace(samples: Float32Array) {
  if (!samples.length) return { gain: 1, rms: 0, peak: 0 };
  const stride = Math.max(1, Math.floor(samples.length / 320_000));
  let sumSquares = 0;
  let peak = 0;
  let count = 0;
  for (let index = 0; index < samples.length; index += stride) {
    const value = Math.abs(samples[index] || 0);
    sumSquares += value * value;
    peak = Math.max(peak, value);
    count += 1;
  }
  const rms = count ? Math.sqrt(sumSquares / count) : 0;
  if (rms < 0.00005 || peak < 0.0001) return { gain: 1, rms, peak };

  // Aim around -22 dBFS RMS for speech, never boost more than 4x, and retain peak headroom.
  const targetRms = 0.08;
  const rmsGain = targetRms / Math.max(rms, 0.00005);
  const peakGain = 0.92 / Math.max(peak, 0.0001);
  const gain = Math.max(1, Math.min(4, rmsGain, peakGain));
  if (gain > 1.03) {
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.max(-0.98, Math.min(0.98, samples[index] * gain));
    }
  }
  return { gain, rms, peak };
}

async function decodeTo16Khz(blob: Blob) {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('This browser cannot decode the saved recording for on-device transcription.');

  let context: AudioContext;
  try {
    context = new AudioContextClass({ sampleRate: 16_000 });
  } catch {
    context = new AudioContextClass();
  }

  try {
    const encoded = await blob.arrayBuffer();
    if (!encoded.byteLength) throw new Error('The saved recording is empty.');
    const decoded = await context.decodeAudioData(encoded);
    if (!decoded.duration || !decoded.numberOfChannels) throw new Error('The browser decoded no usable audio channels.');

    let pcm: Float32Array;
    if (decoded.sampleRate === 16_000) {
      pcm = decoded.getChannelData(0);
    } else {
      const outputLength = Math.max(1, Math.ceil(decoded.duration * 16_000));
      const offline = new OfflineAudioContext(1, outputLength, 16_000);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      pcm = rendered.getChannelData(0);
    }

    const signal = normalizeSpeechForTranscriptionInPlace(pcm);
    if (signal.peak < 0.0001) throw new Error('The saved recording decoded as silence. Keep the original recording and check microphone playback before retrying.');
    return { pcm, signal };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Audio decoding failed.';
    throw new Error(`The saved recording could not be prepared for on-device transcription. ${message}`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function preparePhoneTranscriptionModel(onProgress: (update: TranscriptionProgress) => void) {
  const id = `prepare-${crypto.randomUUID()}`;
  return new Promise<{ model: string }>((resolve, reject) => {
    const instance = worker();
    const cleanUp = () => {
      instance.removeEventListener('message', listener);
      instance.removeEventListener('error', workerError);
      instance.removeEventListener('messageerror', messageError);
    };
    const fail = (message: string, reset = false) => {
      cleanUp();
      if (reset) resetWorker(instance);
      reject(new Error(message));
    };
    const workerError = () => fail('The phone model could not be prepared, usually because the browser ran low on memory. You can still record without the model and transcribe later on Windows.', true);
    const messageError = () => fail('The browser could not communicate with the on-device speech worker.', true);
    const listener = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'model-progress') {
        const downloaded = message.total ? ` · ${Math.round((message.loaded || 0) / 1024 / 1024)} of ${Math.round(message.total / 1024 / 1024)} MB` : '';
        onProgress({ progress: Math.max(5, Math.min(95, Math.round(message.progress || 0))), message: `Preparing multilingual Whisper for offline use${downloaded}…` });
      } else if (message.type === 'transcription-progress') {
        onProgress({ progress: message.progress || 20, message: message.message || 'Preparing the on-device speech model…' });
      } else if (message.type === 'model-ready') {
        onProgress({ progress: 96, message: `Model loaded: ${message.model || 'multilingual Whisper'}${message.precision ? ` (${message.precision})` : ''}…` });
      } else if (message.id === id && message.type === 'result') {
        cleanUp();
        const model = String((message.payload as { model?: unknown } | undefined)?.model || 'multilingual Whisper');
        onProgress({ progress: 100, message: `${model} is cached and ready on this device.` });
        resolve({ model });
      } else if (message.id === id && message.type === 'error') {
        fail(message.message || 'The on-device model could not be prepared.');
      }
    };
    instance.addEventListener('message', listener);
    instance.addEventListener('error', workerError);
    instance.addEventListener('messageerror', messageError);
    instance.postMessage({ id, mode: 'prepare' });
  });
}

export async function transcribeOnPhone(
  lectureId: string,
  audio: Blob,
  onProgress: (update: TranscriptionProgress) => void,
  onModelReady: () => void,
) {
  onProgress({ progress: 4, message: 'Decoding a private transcription copy at 16 kHz…' });
  if (audio.size > 250 * 1024 * 1024) {
    onProgress({ progress: 5, message: 'This is a large lecture. LectureAI will still try on-device transcription, but iOS/iPadOS memory may be the limiting factor; the original recording remains safe.' });
  }

  const { pcm, signal } = await decodeTo16Khz(audio);
  if (signal.gain > 1.03) {
    onProgress({ progress: 7, message: `Quiet/distant speech detected · applying ${signal.gain.toFixed(1)}× gain to the transcription copy only…` });
  } else {
    onProgress({ progress: 7, message: 'Speech level is suitable · original recording remains untouched…' });
  }

  const id = `${lectureId}-${crypto.randomUUID()}`;
  return new Promise<unknown>((resolve, reject) => {
    const instance = worker();
    const cleanUp = () => {
      instance.removeEventListener('message', listener);
      instance.removeEventListener('error', workerError);
      instance.removeEventListener('messageerror', messageError);
    };
    const fail = (message: string, reset = false) => {
      cleanUp();
      if (reset) resetWorker(instance);
      reject(new Error(message));
    };
    const workerError = () => fail('The on-device speech worker stopped unexpectedly, usually because iOS/iPadOS ran low on memory. Your original recording is still safe. Close other apps and retry, or use Maximum Accuracy on Windows for a long lecture.', true);
    const messageError = () => fail('The device could not pass decoded audio to the local speech worker. Your original recording is still safe.', true);
    const listener = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'model-progress') {
        const downloaded = message.total ? ` · ${Math.round((message.loaded || 0) / 1024 / 1024)} of ${Math.round(message.total / 1024 / 1024)} MB` : '';
        onProgress({ progress: Math.max(8, Math.min(65, Math.round((message.progress || 0) * .55) + 8)), message: `Downloading or loading the multilingual phone model${downloaded}…` });
      } else if (message.type === 'model-ready') {
        onModelReady();
        onProgress({ progress: 68, message: `Phone/iPad model ready (${message.model || 'multilingual Whisper'}${message.precision ? `, ${message.precision}` : ''}) · transcribing English, Egyptian Arabic, MSA, and mixed technical speech locally…` });
      } else if (message.type === 'transcription-progress') {
        onProgress({ progress: message.progress || 72, message: message.message || 'Transcribing on this device…' });
      } else if (message.id === id && message.type === 'result') {
        cleanUp();
        resolve(message.payload);
      } else if (message.id === id && message.type === 'error') {
        fail(`On-device transcription could not finish: ${message.message || 'unknown model error'}. Your original recording is still safe.`);
      }
    };
    instance.addEventListener('message', listener);
    instance.addEventListener('error', workerError);
    instance.addEventListener('messageerror', messageError);
    instance.postMessage({ id, mode: 'transcribe', audio: pcm }, [pcm.buffer]);
  });
}
