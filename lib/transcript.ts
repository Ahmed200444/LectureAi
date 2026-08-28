import type { TranscriptSegment } from './types.ts';

function guessLanguage(text: string): TranscriptSegment['detectedLanguage'] {
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const english = (text.match(/[A-Za-z]/g) || []).length;
  if (arabic && english) return 'mixed';
  if (arabic) return 'ar';
  if (english) return 'en';
  return 'unknown';
}

type ImportedSegment = {
  id?: unknown;
  start?: unknown;
  end?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  text?: unknown;
  originalText?: unknown;
  confidence?: unknown;
  avg_logprob?: unknown;
  language?: unknown;
  speaker?: unknown;
};

export function normalizeTranscript(input: unknown, lectureId: string): TranscriptSegment[] {
  const root = input as { segments?: unknown };
  if (!root || !Array.isArray(root.segments)) throw new Error('Transcript JSON must contain a segments array.');
  if (root.segments.length > 100_000) throw new Error('Transcript contains too many segments.');

  const normalized = root.segments.map((raw, index) => {
    const segment = raw as ImportedSegment;
    const originalText = String(segment.text ?? segment.originalText ?? '').trim();
    const startTime = Number(segment.start ?? segment.startTime);
    const endTime = Number(segment.end ?? segment.endTime);
    if (!originalText || !Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime < startTime) {
      throw new Error(`Segment ${index + 1} has invalid text or timestamps.`);
    }
    const importedConfidence = Number(segment.confidence);
    const logProbability = Number(segment.avg_logprob);
    const confidence = Number.isFinite(importedConfidence)
      ? Math.min(1, Math.max(0, importedConfidence))
      : Number.isFinite(logProbability)
        ? Math.min(1, Math.max(0, Math.exp(logProbability)))
        : 0.86;
    const importedLanguage = String(segment.language);
    const detectedLanguage = ['en', 'ar', 'mixed'].includes(importedLanguage)
      ? importedLanguage as TranscriptSegment['detectedLanguage']
      : guessLanguage(originalText);
    return {
      id: typeof segment.id === 'string' ? segment.id : `${lectureId}-segment-${index + 1}`,
      lectureId,
      startTime,
      endTime,
      originalText,
      editedText: originalText,
      detectedLanguage,
      confidence,
      manuallyReviewed: confidence >= 0.85,
      speaker: typeof segment.speaker === 'string' ? segment.speaker.slice(0, 50) : 'Professor',
    } satisfies TranscriptSegment;
  });

  return normalized.sort((a, b) => a.startTime - b.startTime);
}

export function toTranscriptJson(segments: TranscriptSegment[]) {
  return {
    version: 1,
    segments: segments.map((segment) => ({
      id: segment.id,
      start: segment.startTime,
      end: segment.endTime,
      text: segment.editedText || segment.originalText,
      originalText: segment.originalText,
      language: segment.detectedLanguage,
      confidence: segment.confidence,
      manuallyReviewed: segment.manuallyReviewed,
      speaker: segment.speaker,
    })),
  };
}
