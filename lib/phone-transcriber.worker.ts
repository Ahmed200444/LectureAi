/// <reference lib="webworker" />

import { env, pipeline } from '@huggingface/transformers';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const PRIMARY_MODEL = 'Xenova/whisper-small';
const FALLBACK_MODEL = 'Xenova/whisper-base';

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

type ProgressInfo = { status?: string; progress?: number; loaded?: number; total?: number; file?: string };
type ASROutput = { text: string; chunks?: Array<{ timestamp: [number, number]; text: string }> };
type Transcriber = Awaited<ReturnType<typeof pipeline<'automatic-speech-recognition'>>>;

let transcriberPromise: Promise<Transcriber> | null = null;
let activeModel = PRIMARY_MODEL;

function progressCallback(info: ProgressInfo) {
  const progress = info.status === 'progress_total' || info.status === 'progress' ? Math.round(info.progress || 0) : undefined;
  workerScope.postMessage({ type: 'model-progress', progress, loaded: info.loaded, total: info.total, file: info.file, status: info.status });
}

async function loadModel(model: string) {
  return pipeline('automatic-speech-recognition', model, { progress_callback: progressCallback });
}

async function getTranscriber() {
  if (!transcriberPromise) {
    activeModel = PRIMARY_MODEL;
    transcriberPromise = loadModel(PRIMARY_MODEL).catch(async () => {
      // Keep on-phone transcription available on iOS devices that cannot hold the
      // Small model in memory. Base remains multilingual and the original audio is
      // never altered, so Maximum Accuracy can still be run later on Windows.
      activeModel = FALLBACK_MODEL;
      return loadModel(FALLBACK_MODEL);
    });
  }
  const transcriber = await transcriberPromise;
  workerScope.postMessage({ type: 'model-ready', model: activeModel });
  return transcriber;
}

workerScope.addEventListener('message', async (event: MessageEvent<{ id: string; audio: Float32Array }>) => {
  const { id, audio } = event.data;
  try {
    const transcriber = await getTranscriber();
    workerScope.postMessage({ type: 'transcription-progress', progress: 72, message: 'Running multilingual speech recognition on this device…' });
    const output = await transcriber(audio, {
      task: 'transcribe',
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      force_full_sequences: false,
    }) as ASROutput;
    const chunks = output.chunks?.filter((chunk) => chunk.text.trim()) || [];
    const segments = chunks.length ? chunks.map((chunk, index) => ({
      id: `${id}-phone-${index + 1}`,
      start: Number(chunk.timestamp[0]) || 0,
      end: Number(chunk.timestamp[1]) || Number(chunk.timestamp[0]) || 0,
      text: chunk.text.trim(),
      confidence: 0,
      speaker: 'Professor',
    })) : output.text.trim() ? [{ id: `${id}-phone-1`, start: 0, end: audio.length / 16_000, text: output.text.trim(), confidence: 0, speaker: 'Professor' }] : [];
    workerScope.postMessage({ type: 'result', id, payload: { engine: 'transformers.js', model: activeModel, segments } });
  } catch (error) {
    workerScope.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : 'On-device transcription failed.' });
  }
});
