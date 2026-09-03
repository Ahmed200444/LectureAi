import type { TranscriptSegment } from './types.ts';
import type { TranscriptionProgress } from './transcription.ts';

type TargetLanguage = 'en' | 'ar';
type Script = TargetLanguage | 'neutral';
type TranslationPiece = { text: string; script: Script; translationIndex?: number };
type TranslationPlan = { segmentIndex: number; pieces: TranslationPiece[] };
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

function charScript(character: string): Script {
  if (/[\u0600-\u06FF]/.test(character)) return 'ar';
  if (/[A-Za-z]/.test(character)) return 'en';
  return 'neutral';
}

/**
 * Mixed university speech often contains English technical terms inside Arabic.
 * Do not send a whole mixed sentence through one one-way translation model. Split
 * it into script runs so already-target-language text stays untouched and only the
 * opposite-script spans are translated.
 */
function splitScriptRuns(value: string): TranslationPiece[] {
  const pieces: TranslationPiece[] = [];
  let currentScript: Exclude<Script, 'neutral'> | null = null;
  let buffer = '';

  const flush = () => {
    if (!buffer) return;
    pieces.push({ text: buffer, script: currentScript || 'neutral' });
    buffer = '';
  };

  for (const character of value) {
    const script = charScript(character);
    if (script !== 'neutral' && currentScript && script !== currentScript) {
      flush();
      currentScript = script;
    } else if (script !== 'neutral' && !currentScript) {
      currentScript = script;
    }
    buffer += character;
  }
  flush();
  return pieces;
}

function translationCore(value: string) {
  const leading = value.match(/^\s*/)?.[0] || '';
  const trailing = value.match(/\s*$/)?.[0] || '';
  const core = value.slice(leading.length, value.length - trailing.length || undefined).trim();
  return { leading, core, trailing };
}

function createPlans(segments: TranscriptSegment[], target: TargetLanguage) {
  const texts: string[] = [];
  const plans: TranslationPlan[] = [];

  segments.forEach((segment, segmentIndex) => {
    if (!shouldTranslate(segment, target)) return;
    const source = (segment.editedText || segment.originalText).trim();
    const pieces = splitScriptRuns(source);
    for (const piece of pieces) {
      if (piece.script === 'neutral' || piece.script === target) continue;
      const { core } = translationCore(piece.text);
      if (!core) continue;
      piece.translationIndex = texts.length;
      texts.push(core);
    }
    if (pieces.some((piece) => piece.translationIndex !== undefined)) plans.push({ segmentIndex, pieces });
  });

  return { texts, plans };
}

function rebuildPlan(plan: TranslationPlan, translations: string[]) {
  return plan.pieces.map((piece) => {
    if (piece.translationIndex === undefined) return piece.text;
    const { leading, core, trailing } = translationCore(piece.text);
    const translated = String(translations[piece.translationIndex] || core).trim();
    return `${leading}${translated}${trailing}`;
  }).join('').replace(/\s+([,.;:!?،؛؟])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

export async function translateTranscriptView(
  segments: TranscriptSegment[],
  target: TargetLanguage,
  onProgress: (update: TranscriptionProgress) => void,
) {
  if (!segments.length) return [];

  const { texts, plans } = createPlans(segments, target);
  if (!texts.length) {
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
        onProgress({ progress: 74, message: `Local translation model ready · translating ${texts.length} language span${texts.length === 1 ? '' : 's'} without rewriting already-${target === 'en' ? 'English' : 'Arabic'} text…` });
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

  onProgress({ progress: 96, message: `Assembling ${target === 'en' ? 'English' : 'Arabic'} translation while preserving code-switched source spans…` });
  const translatedByIndex = new Map(plans.map((plan) => [plan.segmentIndex, rebuildPlan(plan, translations)]));

  return segments.map((segment, index) => {
    const translatedText = translatedByIndex.get(index) || (segment.editedText || segment.originalText);
    return {
      ...segment,
      id: `${segment.id}-translation-${target}`,
      originalText: translatedText,
      editedText: translatedText,
      detectedLanguage: target,
      confidence: undefined,
      manuallyReviewed: false,
    } satisfies TranscriptSegment;
  });
}
