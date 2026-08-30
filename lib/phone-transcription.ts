import type { TranscriptionProgress } from './transcription.ts';
import type { TranscriptSegment } from './types.ts';
import { translateTranscriptView } from './translation.ts';
import { isIOSDevice } from './device.ts';

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
const MAX_FAR_FIELD_GAIN = 16;

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

function preferredPhoneModelStartIndex() {
  // iPhone and iPad WebKit have tighter per-process memory budgets than desktop browsers.
  // Start with multilingual Base on iOS/iPadOS so WebKit is less likely to kill the page
  // before our normal model fallback can surface a recoverable error.
  return isIOSDevice() ? 1 : 0;
}

function releasePhoneTranscriptionWorker() {
  if (sharedWorker) resetWorker(sharedWorker);
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

function sampledRms(channel: Float32Array) {
  if (!channel.length) return 0;
  const stride = Math.max(1, Math.floor(channel.length / 50_000));
  let sumSquares = 0;
  let count = 0;
  for (let index = 0; index < channel.length; index += stride) {
    const value = channel[index] || 0;
    sumSquares += value * value;
    count += 1;
  }
  return count ? Math.sqrt(sumSquares / count) : 0;
}

/**
 * Convert decoded audio to one channel without blindly averaging a useful channel
 * with a nearly silent channel. The real iPhone sample that exposed this issue was
 * stereo but carried essentially all speech on only one side.
 */
function makeSpeechMonoBuffer(context: AudioContext, decoded: AudioBuffer) {
  if (decoded.numberOfChannels === 1) {
    const source = decoded.getChannelData(0);
    return { buffer: decoded, selectedChannel: 0, channelRms: [sampledRms(source)] };
  }

  const mono = context.createBuffer(1, decoded.length, decoded.sampleRate);
  const destination = mono.getChannelData(0);
  const channelRms = Array.from({ length: decoded.numberOfChannels }, (_, index) => sampledRms(decoded.getChannelData(index)));
  const ranked = channelRms.map((rms, index) => ({ rms, index })).sort((a, b) => b.rms - a.rms);
  const strongest = ranked[0];
  const second = ranked[1];
  const useStrongestOnly = strongest && (!second || strongest.rms > Math.max(0.00001, second.rms * 3));

  if (useStrongestOnly) {
    destination.set(decoded.getChannelData(strongest.index));
    return { buffer: mono, selectedChannel: strongest.index, channelRms };
  }

  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const source = decoded.getChannelData(channel);
    for (let index = 0; index < destination.length; index += 1) destination[index] += source[index] / decoded.numberOfChannels;
  }
  return { buffer: mono, selectedChannel: undefined, channelRms };
}

/**
 * Prepare a disposable Whisper copy for distant classroom speech. Rare taps or
 * clipped spikes must not prevent quiet speech from being amplified, so gain is
 * based on a winsorized RMS rather than the absolute file peak. A gentle high-pass
 * removes low-frequency rumble and a soft limiter contains those rare peaks after
 * gain. The stored original recording is never modified.
 */
function normalizeSpeechForTranscriptionInPlace(samples: Float32Array) {
  if (!samples.length) return { gain: 1, rms: 0, peak: 0, percentilePeak: 0 };

  const stride = Math.max(1, Math.floor(samples.length / 40_000));
  const magnitudes: number[] = [];
  let peak = 0;
  for (let index = 0; index < samples.length; index += stride) {
    const value = Math.abs(samples[index] || 0);
    magnitudes.push(value);
    peak = Math.max(peak, value);
  }
  if (!magnitudes.length || peak < 0.0001) return { gain: 1, rms: 0, peak, percentilePeak: peak };

  magnitudes.sort((a, b) => a - b);
  const percentileIndex = Math.min(magnitudes.length - 1, Math.floor(magnitudes.length * 0.995));
  const percentilePeak = Math.max(0.0001, magnitudes[percentileIndex] || peak);
  let winsorizedSquares = 0;
  for (const value of magnitudes) winsorizedSquares += Math.min(value, percentilePeak) ** 2;
  const rms = Math.sqrt(winsorizedSquares / magnitudes.length);

  const targetRms = 0.05;
  const gain = Math.max(1, Math.min(MAX_FAR_FIELD_GAIN, targetRms / Math.max(rms, 0.00005)));
  const highPassMemory = { previousInput: 0, previousOutput: 0 };
  const highPassCoefficient = 0.97;

  for (let index = 0; index < samples.length; index += 1) {
    const input = samples[index] || 0;
    const highPassed = highPassCoefficient * (highPassMemory.previousOutput + input - highPassMemory.previousInput);
    highPassMemory.previousInput = input;
    highPassMemory.previousOutput = highPassed;

    const scaled = highPassed * gain;
    const magnitude = Math.abs(scaled);
    if (magnitude <= 0.72) {
      samples[index] = scaled;
    } else {
      const compressed = 0.72 + 0.26 * (1 - Math.exp(-(magnitude - 0.72) / 0.26));
      samples[index] = Math.sign(scaled) * Math.min(0.98, compressed);
    }
  }

  return { gain, rms, peak, percentilePeak };
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

    const mono = makeSpeechMonoBuffer(context, decoded);
    let pcm: Float32Array;
    if (decoded.sampleRate === SAMPLE_RATE) {
      pcm = mono.buffer.getChannelData(0);
    } else {
      const outputLength = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE));
      const offline = new OfflineAudioContext(1, outputLength, SAMPLE_RATE);
      const source = offline.createBufferSource();
      source.buffer = mono.buffer;
      source.connect(offline.destination);
      source.start();
      const rendered = await offline.startRendering();
      pcm = rendered.getChannelData(0);
    }

    const signal = normalizeSpeechForTranscriptionInPlace(pcm);
    if (signal.peak < 0.0001) throw new Error('The saved recording decoded as silence. Keep the original recording and check microphone playback before retrying.');
    return { pcm, signal, channelInfo: mono };
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
    instance.postMessage({ id, mode: 'transcribe', audio, startModelIndex, iosMemorySafe: isIOSDevice() }, [audio.buffer]);
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
  const modelIndexes = preferredPhoneModelStartIndex() === 1 ? [1, 2] : [0, 1, 2];
  for (const startModelIndex of modelIndexes) {
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
    instance.postMessage({ id, mode: 'prepare', startModelIndex: preferredPhoneModelStartIndex(), iosMemorySafe: isIOSDevice() });
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
  const isIOS = isIOSDevice();
  onProgress({
    progress: 2,
    message: isIOS
      ? 'Preparing audio first to reduce iPhone/iPad memory pressure…'
      : 'Starting the speech model and preparing audio in parallel…',
  });

  const warmModel = () => preparePhoneTranscriptionModel(({ progress, message }) => {
    onProgress({ progress: Math.max(2, Math.min(35, Math.round(progress * 0.35))), message });
  }).catch(() => null);

  if (audio.size > 250 * 1024 * 1024) {
    onProgress({ progress: 5, message: 'This is a large lecture. LectureAI will process it in smaller windows to reduce iPhone/iPad memory pressure; the original recording remains safe.' });
  } else if (!isIOS) {
    onProgress({ progress: 4, message: 'Preparing a private far-field speech copy at 16 kHz while the model warms up…' });
  }

  let decoded: Awaited<ReturnType<typeof decodeTo16Khz>>;
  if (isIOS) {
    // Do not overlap the full browser audio decode with model initialization on
    // iPhone or iPad. Either operation can be memory-heavy enough for WebKit to
    // terminate the page before JavaScript receives a recoverable exception.
    decoded = await decodeTo16Khz(audio);
    onProgress({ progress: 18, message: 'Audio prepared · loading the memory-safer multilingual model on iPhone/iPad…' });
    await warmModel();
  } else {
    const warmup = warmModel();
    [decoded] = await Promise.all([decodeTo16Khz(audio), warmup.then(() => undefined)]);
  }
  const { pcm, signal, channelInfo } = decoded;

  const channelMessage = channelInfo.selectedChannel === undefined ? '' : ` · using the stronger audio channel ${channelInfo.selectedChannel + 1}`;
  if (signal.gain > 1.03) {
    onProgress({ progress: 36, message: `Quiet/distant speech detected · adaptive ${signal.gain.toFixed(1)}× far-field enhancement on the transcription copy only${channelMessage}…` });
  } else {
    onProgress({ progress: 36, message: `Speech level is suitable${channelMessage} · original recording remains untouched…` });
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
      segments.push({ start: gapStart, end: endSeconds, text: '[inaudible]', speaker: 'Professor' });
      onProgress({ progress: 75, message: 'One section could not be processed after automatic retries. LectureAI kept the rest of the transcript and marked this section for review.' });
    }

    if (endSample >= pcm.length) break;
  }

  if (!successfulWindows) {
    throw new Error('The iPhone/iPad could not process any transcription section after automatic model retries. The original recording is still safe.');
  }

  const sourceSegments = asTranscriptSegments(segments, lectureId);

  // Translation uses separate local models. Release Whisper first so the speech
  // model and translation model are never resident together on memory-constrained
  // iPhone Safari. Browser-cached model files remain cached for the next lecture.
  onProgress({ progress: 93, message: 'Original transcript ready · releasing speech model memory before translation…' });
  releasePhoneTranscriptionWorker();
  await new Promise((resolve) => setTimeout(resolve, 80));

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
