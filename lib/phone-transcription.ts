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
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (decoded.sampleRate === 16_000 && decoded.numberOfChannels >= 1) {
      // Return the browser-owned channel directly. The buffer is transferred to the
      // worker immediately, avoiding a second lecture-sized Float32Array allocation.
      return decoded.getChannelData(0);
    }

    const outputLength = Math.max(1, Math.ceil(decoded.duration * 16_000));
    const offline = new OfflineAudioContext(1, outputLength, 16_000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
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
  onProgress({ progress: 4, message: 'Preparing the saved recording at 16 kHz for private on-device transcription…' });
  if (audio.size > 250 * 1024 * 1024) {
    onProgress({ progress: 5, message: 'This is a large lecture. LectureAI will still try on-device transcription, but iOS memory may be the limiting factor; the original recording remains safe.' });
  }
  const pcm = await decodeTo16Khz(audio);
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
    const workerError = () => fail('The on-device speech worker stopped unexpectedly, usually because iOS ran low on memory. Your original recording is still safe. Retry after closing other apps, or use Maximum Accuracy on Windows for a long lecture.', true);
    const messageError = () => fail('The phone could not pass audio to the on-device speech worker. Your original recording is still safe.', true);
    const listener = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'model-progress') {
        const downloaded = message.total ? ` · ${Math.round((message.loaded || 0) / 1024 / 1024)} of ${Math.round(message.total / 1024 / 1024)} MB` : '';
        onProgress({ progress: Math.max(8, Math.min(65, Math.round((message.progress || 0) * .55) + 8)), message: `Downloading or loading the multilingual phone model${downloaded}…` });
      } else if (message.type === 'model-ready') {
        onModelReady();
        onProgress({ progress: 68, message: `Phone model ready (${message.model || 'multilingual Whisper'}${message.precision ? `, ${message.precision}` : ''}) · transcribing English, Egyptian Arabic, MSA, and mixed technical speech locally…` });
      } else if (message.type === 'transcription-progress') {
        onProgress({ progress: message.progress || 72, message: message.message || 'Transcribing on this device…' });
      } else if (message.id === id && message.type === 'result') {
        cleanUp();
        resolve(message.payload);
      } else if (message.id === id && message.type === 'error') {
        fail(message.message || 'On-device transcription failed.');
      }
    };
    instance.addEventListener('message', listener);
    instance.addEventListener('error', workerError);
    instance.addEventListener('messageerror', messageError);
    instance.postMessage({ id, mode: 'transcribe', audio: pcm }, [pcm.buffer]);
  });
}
