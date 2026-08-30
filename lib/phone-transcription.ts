import type { TranscriptionProgress } from './transcription.ts';
import type { TranscriptSegment } from './types.ts';
import { translateTranscriptView } from './translation.ts';

type WorkerMessage = {
  type: 'model-progress' | 'model-ready' | 'transcription-progress' | 'result' | 'error';
  id?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  model?: string;
  modelIndex?: number;
  precision?: string;
  message?: string;
  payload?: unknown;
};

type WorkerSegment = {
  start: number;
  end: number;
  text: string;
  confidence?: number;
  speaker?: string;
};

type WorkerPayload = {
  engine?: string;
  model?: string;
  modelIndex?: number;
  precision?: string;
  segments?: WorkerSegment[];
};

const SAMPLE_RATE = 16_000;
const WINDOW_SECONDS = 180;
const OVERLAP_SECONDS = 5;

let sharedWorker: Worker | null = null;
let preparedModel: { model: string } | null = null;
let preparationPromise: Promise<{ model: string }> | null = null;

function worker() {
  if (!sharedWorker) sharedWorker = new Worker(new URL('./phone-transcriber.worker.ts', import.meta.url), { type: 'module', name: 'lectureai-phone-transcriber' });
  return sharedWorker;
}

function resetWorker(instance: Worker) {
  if (sharedWorker === instance) {
    instance.terminate();
    sharedWorker = null;
    preparedModel = null;
    preparationPromise = null;
  }
}

function guessLanguage(text: string): TranscriptSegment['detectedLanguage'] {
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const english = (text.match(/[A-Za-z]/g) || []).length;
  if (arabic && english) return 'mixed';
  if (arabic) return 'ar';
  if (english) return 'en';
  return 'unknown';
}

function asTranscriptSegments(segments: WorkerSegment[], lectureId: string): TranscriptSegment[] {
  return segments.map((segment, index) => ({
    id: `${lectureId}-phone-source-${index + 1}`,
    lectureId,
    startTime: segment.start,
    endTime: segment.end,
    originalText: segment.text,
    editedText: segment.text,
    detectedLanguage: guessLanguage(segment.text),
    confidence: undefined,
    manuallyReviewed: false,
    speaker: segment.speaker || 'Professor',
  }));
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
    context = new AudioContextClass({ sampleRate: SAMPLE_RATE });
  } catch {
    context = new AudioContextClass();
  }

  try {
    const encoded = await blob.arrayBuffer();
    if (!encoded.byteLength) throw new Error('The saved recording is empty.');
    const decoded = await context.decodeAudioData(encoded);
    if (!decoded.duration || !decoded.numberOfChannels) throw new Error('The browser decoded no usable audio channels.');

    let pcm: Float32Array;
    if (decoded.sampleRate === SAMPLE_RATE && decoded.numberOfChannels === 1) {
      pcm = decoded.getChannelData(0);
    } else {
      // Always render to one 16 kHz channel so stereo imports are properly downmixed
      // instead of silently discarding every channel except channel 1.
      const outputLength = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
      const offline = new OfflineAudioContext(1, outputLength, SAMPLE_RATE);
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

function runWorkerChunk(
  id: string,
  audio: Float32Array,
  startModelIndex: number,
  onProgress: (update: TranscriptionProgress) => void,
  onModelReady: () => void,
) {
  return new Promise<WorkerPayload>((resolve, reject) => {
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
    const workerError = () => fail('The on-device speech worker stopped unexpectedly.', true);
    const messageError = () => fail('The device could not communicate with the on-device speech worker.', true);
    const listener = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'model-progress') {
        const downloaded = message.total ? ` · ${Math.round((message.loaded || 0) / 1024 / 1024)} of ${Math.round(message.total / 1024 / 1024)} MB` : '';
        onProgress({ progress: Math.max(8, Math.min(65, Math.round((message.progress || 0) * .55) + 8)), message: `Downloading or loading the multilingual model${downloaded}…` });
      } else if (message.type === 'model-ready') {
        onModelReady();
        onProgress({ progress: 68, message: `iPhone/iPad model ready (${message.model || 'multilingual Whisper'}${message.precision ? `, ${message.precision}` : ''})…` });
      } else if (message.type === 'transcription-progress') {
        onProgress({ progress: message.progress || 72, message: message.message || 'Transcribing on this device…' });
      } else if (message.id === id && message.type === 'result') {
        cleanUp();
        resolve((message.payload || {}) as WorkerPayload);
      } else if (message.id === id && message.type === 'error') {
        fail(message.message || 'On-device transcription failed.', true);
      }
    };
    instance.addEventListener('message', listener);
    instance.addEventListener('error', workerError);
    instance.addEventListener('messageerror', messageError);
    instance.postMessage({ id, mode: 'transcribe', audio, startModelIndex }, [audio.buffer]);
  });
}

async function transcribeWindowWithRecovery(
  lectureId: string,
  pcm: Float32Array,
  startSample: number,
  endSample: number,
  windowIndex: number,
  onProgress: (update: TranscriptionProgress) => void,
  onModelReady: () => void,
) {
  let lastError: Error | null = null;
  for (const startModelIndex of [0, 1, 2]) {
    const windowAudio = pcm.slice(startSample, endSample);
    try {
      return await runWorkerChunk(`${lectureId}-window-${windowIndex}-${startModelIndex}`, windowAudio, startModelIndex, onProgress, onModelReady);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('On-device transcription window failed.');
      if (startModelIndex < 2) {
        onProgress({ progress: 70, message: 'A transcription window was interrupted. Restarting the speech worker with a lighter model…' });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }
  throw lastError || new Error('This transcription window could not be processed on this device.');
}

function sameNearbyText(a: WorkerSegment | undefined, b: WorkerSegment) {
  if (!a) return false;
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '').trim();
  return normalize(a.text) === normalize(b.text) && b.start <= a.end + 4;
}

export async function preparePhoneTranscriptionModel(onProgress: (update: TranscriptionProgress) => void) {
  if (preparedModel) {
    onProgress({ progress: 100, message: `${preparedModel.model} is already loaded and ready on this device.` });
    return preparedModel;
  }
  if (preparationPromise) {
    onProgress({ progress: 12, message: 'The cached multilingual model is already warming up…' });
    return preparationPromise;
  }

  const id = `prepare-${crypto.randomUUID()}`;
  const task = new Promise<{ model: string }>((resolve, reject) => {
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
    const workerError = () => fail('The phone/iPad model could not be prepared, usually because the browser ran low on memory. You can still record without the model and retry preparation after closing other apps.', true);
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
        fail(message.message || 'The on-device model could not be prepared.', true);
      }
    };
    instance.addEventListener('message', listener);
    instance.addEventListener('error', workerError);
    instance.addEventListener('messageerror', messageError);
    instance.postMessage({ id, mode: 'prepare', startModelIndex: 0 });
  });

  preparationPromise = task.then((result) => {
    preparedModel = result;
    return result;
  }).catch((error) => {
    preparationPromise = null;
    throw error;
  });
  return preparationPromise;
}

export async function transcribeOnPhone(
  lectureId: string,
  audio: Blob,
  onProgress: (update: TranscriptionProgress) => void,
  onModelReady: () => void,
) {
  onProgress({ progress: 2, message: 'Starting the speech model and preparing audio in parallel…' });

  const warmup = preparePhoneTranscriptionModel(({ progress, message }) => {
    onProgress({ progress: Math.max(2, Math.min(35, Math.round(progress * 0.35))), message });
  }).catch(() => null);

  if (audio.size > 250 * 1024 * 1024) {
    onProgress({ progress: 5, message: 'This is a large lecture. LectureAI will process it in smaller windows to reduce iPhone/iPad memory pressure; the original recording remains safe.' });
  } else {
    onProgress({ progress: 4, message: 'Decoding a private transcription copy at 16 kHz while the model warms up…' });
  }

  const decodePromise = decodeTo16Khz(audio);
  const [{ pcm, signal }] = await Promise.all([decodePromise, warmup.then(() => undefined)]);

  if (signal.gain > 1.03) {
    onProgress({ progress: 36, message: `Quiet/distant speech detected · applying ${signal.gain.toFixed(1)}× gain to the transcription copy only…` });
  } else {
    onProgress({ progress: 36, message: 'Speech level is suitable · original recording remains untouched…' });
  }

  const windowSamples = WINDOW_SECONDS * SAMPLE_RATE;
  const overlapSamples = OVERLAP_SECONDS * SAMPLE_RATE;
  const stepSamples = windowSamples - overlapSamples;
  const starts: number[] = [];
  for (let start = 0; start < pcm.length; start += stepSamples) starts.push(start);

  const segments: WorkerSegment[] = [];
  let finalModel = preparedModel?.model || 'multilingual Whisper';
  let finalPrecision = '';
  let successfulWindows = 0;
  let failedWindows = 0;

  for (let index = 0; index < starts.length; index += 1) {
    const startSample = starts[index];
    const endSample = Math.min(pcm.length, startSample + windowSamples);
    const startSeconds = startSample / SAMPLE_RATE;
    const endSeconds = endSample / SAMPLE_RATE;
    onProgress({
      progress: Math.max(40, Math.round(70 + 23 * (index / Math.max(1, starts.length)))),
      message: `Transcribing lecture section ${index + 1} of ${starts.length} · ${Math.round(startSeconds)}–${Math.round(endSeconds)}s · auto-detecting English/Arabic…`,
    });

    try {
      const payload = await transcribeWindowWithRecovery(lectureId, pcm, startSample, endSample, index, onProgress, onModelReady);
      successfulWindows += 1;
      finalModel = payload.model || finalModel;
      finalPrecision = payload.precision || finalPrecision;
      const acceptAfter = index === 0 ? -Infinity : startSeconds + OVERLAP_SECONDS * 0.55;

      for (const raw of payload.segments || []) {
        const next: WorkerSegment = {
          start: Math.max(0, Number(raw.start) + startSeconds),
          end: Math.max(0, Number(raw.end) + startSeconds),
          text: String(raw.text || '').trim(),
          confidence: raw.confidence,
          speaker: raw.speaker || 'Professor',
        };
        if (!next.text || next.end < acceptAfter) continue;
        if (sameNearbyText(segments.at(-1), next)) continue;
        segments.push(next);
      }
    } catch {
      failedWindows += 1;
      const gapStart = index === 0 ? startSeconds : startSeconds + OVERLAP_SECONDS * 0.55;
      segments.push({
        start: gapStart,
        end: endSeconds,
        text: '[inaudible]',
        speaker: 'Professor',
      });
      onProgress({ progress: 75, message: 'One section could not be processed after automatic retries. LectureAI kept the rest of the transcript and marked this section for review.' });
    }

    if (endSample >= pcm.length) break;
  }

  if (!successfulWindows) {
    throw new Error('The iPhone/iPad could not process any transcription section after automatic Small, Base, and Tiny model retries. The original recording is still safe.');
  }

  const sourceSegments = asTranscriptSegments(segments, lectureId);
  let englishTranslation: TranscriptSegment[] = [];
  let arabicTranslation: TranscriptSegment[] = [];
  const translationWarnings: string[] = [];

  try {
    onProgress({ progress: 94, message: 'Original transcript ready · preparing the English view from detected speech…' });
    englishTranslation = await translateTranscriptView(sourceSegments, 'en', ({ message }) => {
      onProgress({ progress: 95, message: `${message} Original audio remains playable and unchanged.` });
    });
  } catch (error) {
    translationWarnings.push(`English translation: ${error instanceof Error ? error.message : 'unavailable'}`);
  }

  try {
    onProgress({ progress: 97, message: 'Preparing the Arabic view from detected speech…' });
    arabicTranslation = await translateTranscriptView(sourceSegments, 'ar', ({ message }) => {
      onProgress({ progress: 98, message: `${message} Original audio remains playable and unchanged.` });
    });
  } catch (error) {
    translationWarnings.push(`Arabic translation: ${error instanceof Error ? error.message : 'unavailable'}`);
  }

  onProgress({
    progress: 99,
    message: translationWarnings.length
      ? `Transcript assembled · ${translationWarnings.join(' · ')}`
      : failedWindows
        ? `Transcript and translations assembled · ${failedWindows} section${failedWindows === 1 ? '' : 's'} marked for review.`
        : 'Transcript and English/Arabic views assembled successfully on this device.',
  });

  return {
    engine: 'transformers.js',
    model: finalModel,
    precision: finalPrecision,
    windowed: true,
    failedWindows,
    segments,
    englishTranslation,
    arabicTranslation,
    translationWarnings,
  };
}
