/// <reference lib="webworker" />

import { env, pipeline } from '@huggingface/transformers';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

type Direction = 'en-ar' | 'ar-en';
type WorkerRequest = { id: string; direction: Direction; texts: string[] };
type ProgressInfo = { status?: string; progress?: number; loaded?: number; total?: number; file?: string };
type TranslationOutput = { translation_text?: string };
type Translator = Awaited<ReturnType<typeof pipeline<'translation'>>>;

const MODELS: Record<Direction, string> = {
  'en-ar': 'Xenova/opus-mt-en-ar',
  'ar-en': 'Xenova/opus-mt-ar-en',
};

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.numThreads = 1;

let activeDirection: Direction | null = null;
let translatorPromise: Promise<Translator> | null = null;

function progressCallback(info: ProgressInfo) {
  const progress = info.status === 'progress_total' || info.status === 'progress' ? Math.round(info.progress || 0) : undefined;
  workerScope.postMessage({ type: 'model-progress', progress, loaded: info.loaded, total: info.total, file: info.file, status: info.status });
}

async function getTranslator(direction: Direction) {
  if (!translatorPromise || activeDirection !== direction) {
    activeDirection = direction;
    translatorPromise = pipeline('translation', MODELS[direction], {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: progressCallback,
    });
  }
  return translatorPromise;
}

function translationText(value: unknown): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = translationText(item);
      if (text) return text;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    const text = (value as TranslationOutput).translation_text;
    return typeof text === 'string' ? text.trim() : '';
  }
  return '';
}

workerScope.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const { id, direction, texts } = event.data;
  try {
    if (!Array.isArray(texts) || !texts.length) throw new Error('No transcript text was provided for translation.');
    const translator = await getTranslator(direction);
    workerScope.postMessage({ type: 'model-ready', model: MODELS[direction] });
    const output = await translator(texts) as unknown;
    const list = Array.isArray(output) ? output : [output];
    const translations = texts.map((original, index) => translationText(list[index]) || original);
    workerScope.postMessage({ type: 'result', id, payload: { translations, model: MODELS[direction] } });
  } catch (error) {
    workerScope.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : 'Local translation failed.' });
  }
});
