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
  manuallyReviewed?: unknown;
  language?: unknown;
  speaker?: unknown;
};

export function normalizeTranscript(input: unknown, lectureId: string): TranscriptSegment[] {
  const root = input as { segments?: unknown; engine?: unknown };
  const engine = typeof root?.engine === 'string' ? root.engine : '';
  const engineConfidenceIsUncalibrated = engine === 'faster-whisper' || engine === 'transformers.js';
  if (!root || !Array.isArray(root.segments)) throw new Error('Transcript JSON must contain a segments array.');

  // Do not impose an artificial transcript-length or segment-count quota.
  // Extremely large transcripts are limited only by the browser/device resources available.
  const normalized = root.segments.map((raw, index) => {
    const segment = raw as ImportedSegment;
    const originalText = String(segment.text ?? segment.originalText ?? '').trim();
    const startTime = Number(segment.start ?? segment.startTime);
    const endTime = Number(segment.end ?? segment.endTime);
    if (!originalText || !Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime < startTime) {
      throw new Error(`Segment ${index + 1} has invalid text or timestamps.`);
    }
    const importedConfidence = segment.confidence === undefined || segment.confidence === null || segment.confidence === '' ? Number.NaN : Number(segment.confidence);
    // faster-whisper avg_logprob and Transformers.js placeholders are not calibrated
    // accuracy percentages. Only preserve an explicit numeric confidence from an
    // external/imported transcript source that claims to provide one.
    const confidence = !engineConfidenceIsUncalibrated && Number.isFinite(importedConfidence)
      ? Math.min(1, Math.max(0, importedConfidence))
      : undefined;
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
      manuallyReviewed: segment.manuallyReviewed === true,
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
