import type { Lecture, TranscriptSegment } from './types.ts';
import { formatTime } from './format.ts';

const stopWords = new Set([
  'about', 'after', 'again', 'also', 'because', 'before', 'being', 'could', 'every', 'first', 'from', 'going', 'have', 'into', 'just', 'more', 'most', 'that', 'their', 'there', 'these', 'they', 'this', 'through', 'using', 'very', 'what', 'when', 'where', 'which', 'with', 'would', 'your', 'then', 'than', 'will', 'were', 'been', 'does', 'did', 'can', 'are', 'the', 'and', 'for', 'but', 'not', 'our', 'out', 'how', 'why',
  'احنا', 'إحنا', 'اللي', 'يعني', 'عشان', 'كده', 'ده', 'دي', 'طيب', 'تمام', 'مثلا', 'مثلاً', 'هنا', 'على', 'إلى', 'في', 'من', 'هو', 'هي', 'هذا', 'هذه', 'ذلك', 'تلك', 'كان', 'كانت', 'يكون', 'تكون', 'عند', 'عندي', 'عندنا', 'بس', 'مش', 'لو', 'كل', 'مع', 'عن', 'ايه', 'إيه',
]);

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] || character);
}

function text(segment: TranscriptSegment) {
  return (segment.editedText || segment.originalText).trim();
}

function citation(segment: Pick<TranscriptSegment, 'startTime'>) {
  return `<button class="note-time-link" data-time="${segment.startTime}" contenteditable="false">${formatTime(segment.startTime)}</button>`;
}

function isTrustworthy(segment: TranscriptSegment) {
  const value = text(segment);
  if (!value) return false;
  // faster-whisper prefixes questionable speech with markers such as
  // "[uncertain] ...". Do not turn those sections into apparently factual notes.
  return !/^\s*\[(?:inaudible|uncertain)\]/i.test(value) && !/\[inaudible\]/i.test(value);
}

function importance(segment: TranscriptSegment) {
  const value = text(segment);
  let score = Math.min(4, value.length / 120);
  if (/important|remember|key point|exam|definition|defined as|means|therefore|because|conclusion|مهم|خدوا بالكم|امتحان|تعريف|يعني|بالتالي|لأن/i.test(value)) score += 5;
  if (/example|for example|for instance|suppose|consider|مثال|مثلاً|افترض/i.test(value)) score += 2;
  if (/[=+−*/^]|equation|formula|algorithm|function|derivative|integral|complexity|runtime|pointer|memory|network|model|gradient|معادلة|خوارزمية|دالة/i.test(value)) score += 2;
  return score;
}

/**
 * Pick useful material from across the complete lecture instead of over-weighting
 * the opening few transcript segments. Each chronological bucket contributes its
 * strongest source-grounded items, preserving coverage of the lecture's middle/end.
 */
function representativeSegments(segments: TranscriptSegment[], maxItems = 14) {
  if (!segments.length) return [];
  const bucketCount = Math.min(7, Math.max(1, Math.ceil(segments.length / 8)));
  const bucketSize = Math.ceil(segments.length / bucketCount);
  const candidates: TranscriptSegment[] = [];

  for (let start = 0; start < segments.length; start += bucketSize) {
    const bucket = segments.slice(start, start + bucketSize);
    const selected = bucket
      .map((segment, index) => ({ segment, index, score: importance(segment) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 2)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.segment);
    candidates.push(...selected);
  }

  return candidates.slice(0, maxItems).sort((a, b) => a.startTime - b.startTime);
}

function extractKeywords(segments: TranscriptSegment[], limit = 10) {
  const counts = new Map<string, { label: string; count: number }>();
  for (const segment of segments) {
    for (const raw of text(segment).match(/[A-Za-z][A-Za-z0-9+.#_-]{1,}|[\u0600-\u06FF]{3,}/g) || []) {
      const word = raw.toLocaleLowerCase();
      if (stopWords.has(word) || /^\d+$/.test(word)) continue;
      const current = counts.get(word) || { label: raw, count: 0 };
      current.count += 1;
      if (raw.length > current.label.length) current.label = raw;
      counts.set(word, current);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || b.label.length - a.label.length)
    .slice(0, limit)
    .map(({ label }) => label);
}

function uniqueSegments(segments: TranscriptSegment[], limit: number) {
  const seen = new Set<string>();
  const result: TranscriptSegment[] = [];
  for (const segment of segments) {
    const key = text(segment).toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(segment);
    if (result.length >= limit) break;
  }
  return result;
}

function sourced(segment: TranscriptSegment) {
  return `${escapeHtml(text(segment))} ${citation(segment)}`;
}

function list(items: string[], empty: string) {
  return `<ul>${(items.length ? items : [empty]).map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

export function generateNotesHtml(lecture: Lecture) {
  const segments = lecture.segments.filter(isTrustworthy);
  const representative = representativeSegments(segments);
  const summary = representative.filter((_, index) => index % 2 === 0).slice(0, 6);
  const keySegments = uniqueSegments(segments.filter((segment) => /important|remember|key point|exam|definition|defined as|means|مهم|خدوا بالكم|امتحان|تعريف|يعني/i.test(text(segment))), 7);
  const examples = uniqueSegments(segments.filter((segment) => /example|for example|for instance|suppose|consider|مثال|مثلاً|افترض/i.test(text(segment))), 7);
  const definitions = uniqueSegments(segments.filter((segment) => /defined as|means|refers to|we call|definition|هو عبارة عن|هي عبارة عن|يعني|تعريف/i.test(text(segment))), 7);
  const technical = uniqueSegments(segments.filter((segment) => /[=+−*/^]|equation|formula|algorithm|function|derivative|integral|complexity|runtime|memory|pointer|class|object|model|loss|gradient|معادلة|خوارزمية|دالة/i.test(text(segment))), 8);
  const keywords = extractKeywords(segments);
  const marked = lecture.bookmarks.map((bookmark) => `${escapeHtml(bookmark.label)} ${citation({ startTime: bookmark.time })}`);

  return [
    '<h2>Lecture Summary</h2>',
    summary.length
      ? list(summary.map(sourced), 'No trustworthy transcript summary is available yet.')
      : '<p>Add or verify a transcript to generate a source-grounded summary.</p>',
    '<h2>Detailed Lecture Notes</h2>',
    list(representative.map(sourced), 'No trustworthy transcript details are available yet.'),
    '<h2>Key Concepts</h2>',
    list(keywords.map((keyword) => `<strong>${escapeHtml(keyword)}</strong>`), 'Key concepts will appear after transcription.'),
    '<h2>Definitions</h2>',
    list(definitions.map(sourced), 'No explicit trustworthy definitions were detected.'),
    '<h2>Examples</h2>',
    list(examples.map(sourced), 'No explicit trustworthy examples were detected.'),
    '<h2>Formulas / Technical Information</h2>',
    list(technical.map(sourced), 'No formulas or technical expressions were detected in trustworthy transcript sections.'),
    '<h2>Important Lecture Emphasis</h2>',
    list([...marked, ...keySegments.map(sourced)].slice(0, 10), 'No marked or explicit emphasis was detected.'),
    '<h2>Possible Exam Topics</h2>',
    '<p><em>LectureAI suggests reviewing these topics; this is not a claim that the professor said they will be on an exam.</em></p>',
    list(keywords.slice(0, 8).map((keyword) => `Review <strong>${escapeHtml(keyword)}</strong> and explain it using the original lecture recording.`), 'Review the main ideas after a transcript is added.'),
    '<h2>Study Questions</h2>',
    list(keywords.slice(0, 8).map((keyword, index) => index % 3 === 0
      ? `How would you explain <strong>${escapeHtml(keyword)}</strong> in your own words using the lecture?`
      : index % 3 === 1
        ? `What is one application of <strong>${escapeHtml(keyword)}</strong> supported by the lecture?`
        : `What other lecture idea is most closely related to <strong>${escapeHtml(keyword)}</strong>, and how are they different?`), 'What was the central idea of this lecture?'),
  ].join('');
}
