/// <reference lib="webworker" />

import { env, pipeline } from '@huggingface/transformers';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

const MODELS = [
  {
    id: 'onnx-community/whisper-small',
    label: 'Whisper Small multilingual',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
  },
  {
    id: 'onnx-community/whisper-base',
    label: 'Whisper Base multilingual',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
  },
  {
    id: 'onnx-community/whisper-tiny',
    label: 'Whisper Tiny multilingual',
    dtype: { encoder_model: 'q8', decoder_model_merged: 'q4' },
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
type WorkerRequest = { id: string; audio?: Float32Array; mode?: 'prepare' | 'transcribe'; startModelIndex?: number; iosMemorySafe?: boolean };

let transcriberPromise: Promise<Transcriber> | null = null;
let activeModelIndex = 0;
let activeIOSMemorySafe = false;

const IOS_MEMORY_SAFE_DTYPE = { encoder_model: 'q8', decoder_model_merged: 'q8' } as const;

function activePrecision() {
  return activeIOSMemorySafe && activeModelIndex >= 1 ? 'q8 encoder · q8 decoder' : 'q8 encoder · q4 decoder';
}

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

function loadModel(index: number, iosMemorySafe = false) {
  activeModelIndex = index;
  activeIOSMemorySafe = iosMemorySafe;
  const config = MODELS[index];
  const dtype = iosMemorySafe && index >= 1 ? IOS_MEMORY_SAFE_DTYPE : config.dtype;
  return pipeline('automatic-speech-recognition', config.id, {
    device: 'wasm',
    dtype,
    progress_callback: progressCallback,
  });
}

async function getTranscriber(startIndex = activeModelIndex, iosMemorySafe = activeIOSMemorySafe) {
  if (!transcriberPromise) {
    let index = Math.max(0, Math.min(startIndex, MODELS.length - 1));
    const tryLoad = async (): Promise<Transcriber> => {
      try {
        return await loadModel(index, iosMemorySafe);
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
  workerScope.postMessage({ type: 'model-ready', model: config.id, modelIndex: activeModelIndex, precision: activePrecision() });
  return transcriber;
}

async function runRecognition(transcriber: Transcriber, audio: Float32Array, iosMemorySafe = false) {
  return transcriber(audio, {
    task: 'transcribe',
    return_timestamps: true,
    // Smaller inference chunks reduce peak WebKit activation memory on iPhone/iPad.
    // Overlap remains so words near chunk boundaries retain context.
    chunk_length_s: iosMemorySafe ? 15 : 30,
    stride_length_s: iosMemorySafe ? 3 : 5,
    force_full_sequences: false,
  }) as Promise<ASROutput>;
}

async function recognizeWithInferenceFallback(audio: Float32Array, startModelIndex = activeModelIndex, iosMemorySafe = activeIOSMemorySafe) {
  if (!transcriberPromise) activeModelIndex = Math.max(0, Math.min(startModelIndex, MODELS.length - 1));

  for (;;) {
    const transcriber = await getTranscriber(activeModelIndex, iosMemorySafe);
    try {
      return await runRecognition(transcriber, audio, iosMemorySafe);
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
  const { id, audio, mode = 'transcribe', startModelIndex = 0, iosMemorySafe = false } = event.data;
  try {
    if (mode === 'prepare') {
      await getTranscriber(startModelIndex, iosMemorySafe);
      const config = MODELS[activeModelIndex];
      workerScope.postMessage({ type: 'result', id, payload: { prepared: true, model: config.id, modelIndex: activeModelIndex, precision: activePrecision() } });
      return;
    }
    if (!audio?.length) throw new Error('No decoded audio was provided for transcription.');

    const transcriber = await getTranscriber(startModelIndex, iosMemorySafe);
    const config = MODELS[activeModelIndex];
    workerScope.postMessage({ type: 'transcription-progress', progress: 72, message: `Running ${config.label} locally with automatic English/Arabic language detection…` });
    void transcriber;
    const output = await recognizeWithInferenceFallback(audio, startModelIndex, iosMemorySafe);
    const finalConfig = MODELS[activeModelIndex];

    const chunks = output.chunks?.filter((chunk) => chunk.text.trim()) || [];
    const segments = chunks.length ? chunks.map((chunk, index) => ({
      id: `${id}-phone-${index + 1}`,
      start: Number(chunk.timestamp[0]) || 0,
      end: Number(chunk.timestamp[1]) || Number(chunk.timestamp[0]) || 0,
      text: chunk.text.trim(),
      // Whisper ASR does not diarize speakers. Never silently attribute student
      // questions or another voice to the professor.
      speaker: 'Speaker',
    })) : output.text.trim() ? [{ id: `${id}-phone-1`, start: 0, end: audio.length / 16_000, text: output.text.trim(), speaker: 'Speaker' }] : [];

    workerScope.postMessage({ type: 'result', id, payload: { engine: 'transformers.js', model: finalConfig.id, modelIndex: activeModelIndex, precision: activePrecision(), segments } });
  } catch (error) {
    workerScope.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : 'On-device transcription failed.' });
  }
});
