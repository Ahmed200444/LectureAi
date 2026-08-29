/// <reference lib="webworker" />

import { env, pipeline } from '@huggingface/transformers';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

const MODELS = [
  {
    id: 'onnx-community/whisper-small',
    label: 'Whisper Small multilingual',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  },
  {
    id: 'onnx-community/whisper-base',
    label: 'Whisper Base multilingual',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  },
  {
    id: 'onnx-community/whisper-tiny',
    label: 'Whisper Tiny multilingual',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  },
] as const;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;

// Safari/WebKit WebGPU support varies by OS/device. WASM is slower but much more
// predictable across iPhone/iPad and still runs completely on-device.
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;

type ProgressInfo = { status?: string; progress?: number; loaded?: number; total?: number; file?: string };
type ASROutput = { text: string; chunks?: Array<{ timestamp: [number, number]; text: string }> };
type Transcriber = Awaited<ReturnType<typeof pipeline<'automatic-speech-recognition'>>>;
type WorkerRequest = { id: string; audio?: Float32Array; mode?: 'prepare' | 'transcribe'; startModelIndex?: number };

let transcriberPromise: Promise<Transcriber> | null = null;
let activeModelIndex = 0;

function progressCallback(info: ProgressInfo) {
  const progress = info.status === 'progress_total' || info.status === 'progress' ? Math.round(info.progress || 0) : undefined;
  workerScope.postMessage({ type: 'model-progress', progress, loaded: info.loaded, total: info.total, file: info.file, status: info.status });
}

async function disposeCurrent() {
  if (!transcriberPromise) return;
  try {
    const current = await transcriberPromise;
    await (current as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
  } catch { /* Best-effort cleanup before a lighter model. */ }
  transcriberPromise = null;
}

function loadModel(index: number) {
  activeModelIndex = index;
  const config = MODELS[index];
  return pipeline('automatic-speech-recognition', config.id, {
    device: 'wasm',
    dtype: config.dtype,
    progress_callback: progressCallback,
  });
}

async function getTranscriber(startIndex = activeModelIndex) {
  if (!transcriberPromise) {
    let index = Math.max(0, Math.min(startIndex, MODELS.length - 1));
    const tryLoad = async (): Promise<Transcriber> => {
      try {
        return await loadModel(index);
      } catch (error) {
        if (index >= MODELS.length - 1) throw error;
        index += 1;
        workerScope.postMessage({ type: 'transcription-progress', progress: 20, message: `The stronger model could not initialize. Retrying with ${MODELS[index].label}…` });
        return tryLoad();
      }
    };
    transcriberPromise = tryLoad();
  }
  const transcriber = await transcriberPromise;
  const config = MODELS[activeModelIndex];
  workerScope.postMessage({ type: 'model-ready', model: config.id, modelIndex: activeModelIndex, precision: 'fp32 encoder · q4 decoder' });
  return transcriber;
}

async function runRecognition(transcriber: Transcriber, audio: Float32Array) {
  return transcriber(audio, {
    task: 'transcribe',
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    force_full_sequences: false,
  }) as Promise<ASROutput>;
}

async function recognizeWithInferenceFallback(audio: Float32Array, startModelIndex = activeModelIndex) {
  if (!transcriberPromise) activeModelIndex = Math.max(0, Math.min(startModelIndex, MODELS.length - 1));

  for (;;) {
    const transcriber = await getTranscriber(activeModelIndex);
    try {
      return await runRecognition(transcriber, audio);
    } catch (error) {
      if (activeModelIndex >= MODELS.length - 1) throw error;
      const nextIndex = activeModelIndex + 1;
      workerScope.postMessage({ type: 'transcription-progress', progress: 70, message: `This model could not finish on the iPhone/iPad. Retrying automatically with ${MODELS[nextIndex].label}…` });
      await disposeCurrent();
      activeModelIndex = nextIndex;
    }
  }
}

workerScope.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const { id, audio, mode = 'transcribe', startModelIndex = 0 } = event.data;
  try {
    if (mode === 'prepare') {
      await getTranscriber(startModelIndex);
      const config = MODELS[activeModelIndex];
      workerScope.postMessage({ type: 'result', id, payload: { prepared: true, model: config.id, modelIndex: activeModelIndex, precision: 'fp32 encoder · q4 decoder' } });
      return;
    }
    if (!audio?.length) throw new Error('No decoded audio was provided for transcription.');

    const transcriber = await getTranscriber(startModelIndex);
    const config = MODELS[activeModelIndex];
    workerScope.postMessage({ type: 'transcription-progress', progress: 72, message: `Running ${config.label} locally…` });
    void transcriber;
    const output = await recognizeWithInferenceFallback(audio, startModelIndex);
    const finalConfig = MODELS[activeModelIndex];

    const chunks = output.chunks?.filter((chunk) => chunk.text.trim()) || [];
    const segments = chunks.length ? chunks.map((chunk, index) => ({
      id: `${id}-phone-${index + 1}`,
      start: Number(chunk.timestamp[0]) || 0,
      end: Number(chunk.timestamp[1]) || Number(chunk.timestamp[0]) || 0,
      text: chunk.text.trim(),
      speaker: 'Professor',
    })) : output.text.trim() ? [{ id: `${id}-phone-1`, start: 0, end: audio.length / 16_000, text: output.text.trim(), confidence: 0, speaker: 'Professor' }] : [];

    workerScope.postMessage({ type: 'result', id, payload: { engine: 'transformers.js', model: finalConfig.id, modelIndex: activeModelIndex, precision: 'fp32 encoder · q4 decoder', segments } });
  } catch (error) {
    workerScope.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : 'On-device transcription failed.' });
  }
});
