import type { TranscriptSegment } from './types.ts';
import type { TranscriptionProgress } from './transcription.ts';

type TargetLanguage = 'en' | 'ar';
type WorkerMessage = {
  type: 'model-progress' | 'model-ready' | 'result' | 'error';
  id?: string;
  progress?: number;
  loaded?: number;
  total?: number;
  model?: string;
  message?: string;
  payload?: { translations?: string[]; model?: string };
};

function shouldTranslate(segment: TranscriptSegment, target: TargetLanguage) {
  if (target === 'en') return segment.detectedLanguage === 'ar' || segment.detectedLanguage === 'mixed';
  return segment.detectedLanguage === 'en' || segment.detectedLanguage === 'mixed';
}

export async function translateTranscriptView(
  segments: TranscriptSegment[],
  target: TargetLanguage,
  onProgress: (update: TranscriptionProgress) => void,
) {
  if (!segments.length) return [];

  const candidates = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => shouldTranslate(segment, target));

  if (!candidates.length) {
    return segments.map((segment) => ({
      ...segment,
      id: `${segment.id}-translation-${target}`,
      detectedLanguage: target,
      confidence: undefined,
    }));
  }

  const id = `translate-${target}-${crypto.randomUUID()}`;
  const worker = new Worker(new URL('./translation.worker.ts', import.meta.url), { type: 'module', name: `lectureai-${target}-translation` });
  const direction = target === 'en' ? 'ar-en' : 'en-ar';
  const texts = candidates.map(({ segment }) => (segment.editedText || segment.originalText).trim());

  const translations = await new Promise<string[]>((resolve, reject) => {
    const cleanUp = () => {
      worker.removeEventListener('message', listener);
      worker.removeEventListener('error', workerError);
      worker.removeEventListener('messageerror', messageError);
      worker.terminate();
    };
    const fail = (message: string) => {
      cleanUp();
      reject(new Error(message));
    };
    const workerError = () => fail('The local translation worker stopped unexpectedly.');
    const messageError = () => fail('The browser could not communicate with the local translation worker.');
    const listener = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'model-progress') {
        const downloaded = message.total ? ` · ${Math.round((message.loaded || 0) / 1024 / 1024)} of ${Math.round(message.total / 1024 / 1024)} MB` : '';
        onProgress({ progress: Math.max(5, Math.min(70, Math.round((message.progress || 0) * .65) + 5)), message: `Loading local ${target === 'en' ? 'Arabic → English' : 'English → Arabic'} translation model${downloaded}…` });
      } else if (message.type === 'model-ready') {
        onProgress({ progress: 74, message: `Local translation model ready · translating ${candidates.length} segment${candidates.length === 1 ? '' : 's'}…` });
      } else if (message.id === id && message.type === 'result') {
        const result = message.payload?.translations;
        if (!Array.isArray(result) || result.length !== texts.length) {
          fail('The local translation model returned an incomplete result.');
          return;
        }
        cleanUp();
        resolve(result.map((text, index) => String(text || texts[index]).trim()));
      } else if (message.id === id && message.type === 'error') {
        fail(message.message || 'Local translation failed.');
      }
    };
    worker.addEventListener('message', listener);
    worker.addEventListener('error', workerError);
    worker.addEventListener('messageerror', messageError);
    worker.postMessage({ id, direction, texts });
  });

  onProgress({ progress: 96, message: `Assembling ${target === 'en' ? 'English' : 'Arabic'} translation…` });
  const translatedByIndex = new Map(candidates.map((candidate, index) => [candidate.index, translations[index]]));

  return segments.map((segment, index) => {
    const text = translatedByIndex.get(index) || (segment.editedText || segment.originalText);
    return {
      ...segment,
      id: `${segment.id}-translation-${target}`,
      originalText: text,
      editedText: text,
      detectedLanguage: target,
      confidence: undefined,
      manuallyReviewed: false,
    } satisfies TranscriptSegment;
  });
}
