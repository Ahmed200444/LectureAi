import type { TranscriptionProgress } from './transcription.ts';

type WorkerMessage = {
  type: 'model-progress' | 'model-ready' | 'transcription-progress' | 'result' | 'error';
  id?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  model?: string;
  message?: string;
  payload?: unknown;
};

let sharedWorker: Worker | null = null;

function worker() {
  if (!sharedWorker) sharedWorker = new Worker(new URL('./phone-transcriber.worker.ts', import.meta.url), { type: 'module', name: 'lectureai-phone-transcriber' });
  return sharedWorker;
}

async function decodeTo16Khz(blob: Blob) {
  const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) throw new Error('This browser cannot decode the saved recording for on-device transcription.');
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const outputLength = Math.max(1, Math.ceil(decoded.duration * 16_000));
    const offline = new OfflineAudioContext(1, outputLength, 16_000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function transcribeOnPhone(
  lectureId: string,
  audio: Blob,
  onProgress: (update: TranscriptionProgress) => void,
  onModelReady: () => void,
) {
  onProgress({ progress: 6, message: 'Preparing the saved recording for on-device transcription…' });
  const pcm = await decodeTo16Khz(audio);
  const id = `${lectureId}-${crypto.randomUUID()}`;

  return new Promise<unknown>((resolve, reject) => {
    const instance = worker();
    const listener = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'model-progress') {
        const downloaded = message.total ? ` · ${Math.round((message.loaded || 0) / 1024 / 1024)} of ${Math.round(message.total / 1024 / 1024)} MB` : '';
        onProgress({ progress: Math.max(8, Math.min(65, Math.round((message.progress || 0) * .55) + 8)), message: `Downloading or loading the multilingual phone model${downloaded}…` });
      } else if (message.type === 'model-ready') {
        onModelReady();
        onProgress({ progress: 68, message: 'Phone model ready · transcribing English and Arabic locally…' });
      } else if (message.type === 'transcription-progress') {
        onProgress({ progress: message.progress || 72, message: message.message || 'Transcribing on this device…' });
      } else if (message.id === id && message.type === 'result') {
        instance.removeEventListener('message', listener);
        resolve(message.payload);
      } else if (message.id === id && message.type === 'error') {
        instance.removeEventListener('message', listener);
        reject(new Error(message.message || 'On-device transcription failed.'));
      }
    };
    instance.addEventListener('message', listener);
    instance.postMessage({ id, audio: pcm }, [pcm.buffer]);
  });
}
