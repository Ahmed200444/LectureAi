import type { Lecture, TranscriptSegment } from './types.ts';
import { formatTime } from './format.ts';

const stopWords = new Set([
  'about', 'after', 'again', 'because', 'before', 'being', 'could', 'every', 'first', 'from', 'going', 'have', 'into', 'just', 'more', 'most', 'that', 'their', 'there', 'these', 'they', 'this', 'through', 'using', 'very', 'what', 'when', 'where', 'which', 'with', 'would',
  'احنا', 'إحنا', 'اللي', 'يعني', 'عشان', 'كده', 'ده', 'دي', 'طيب', 'تمام', 'مثلاً', 'هنا', 'على', 'إلى', 'في', 'من', 'هو', 'هي',
]);

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] || character);
}

function text(segment: TranscriptSegment) {
  return (segment.editedText || segment.originalText).trim();
}

function citation(segment: TranscriptSegment) {
  return `<button class="note-time-link" data-time="${segment.startTime}" contenteditable="false">${formatTime(segment.startTime)}</button>`;
}

function extractKeywords(segments: TranscriptSegment[]) {
  const counts = new Map<string, number>();
  for (const segment of segments) {
    for (const raw of text(segment).match(/[A-Za-z][A-Za-z-]{3,}|[\u0600-\u06FF]{4,}/g) || []) {
      const word = raw.toLocaleLowerCase();
      if (!stopWords.has(word)) counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7).map(([word]) => word);
}

function list(items: string[], empty: string) {
  return `<ul>${(items.length ? items : [empty]).map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

export function generateNotesHtml(lecture: Lecture) {
  const segments = lecture.segments.filter((segment) => text(segment) && !/^\[(inaudible|uncertain)\]$/i.test(text(segment)));
  const first = segments.slice(0, 3);
  const keySegments = segments.filter((segment) => /important|remember|key|exam|definition|means|يعني|مهم|خدوا بالكم/i.test(text(segment))).slice(0, 5);
  const examples = segments.filter((segment) => /example|for instance|مثال|مثلاً/i.test(text(segment))).slice(0, 5);
  const definitions = segments.filter((segment) => /\bis\b|means|defined as|refers to|هو|هي|يعني/i.test(text(segment))).slice(0, 5);
  const keywords = extractKeywords(segments);
  const details = segments.slice(0, 14).map((segment) => `${escapeHtml(text(segment))} ${citation(segment)}`);
  const marked = lecture.bookmarks.map((bookmark) => `${escapeHtml(bookmark.label)} ${citation({ startTime: bookmark.time } as TranscriptSegment)}`);

  return [
    '<h2>Lecture Summary</h2>',
    `<p>${first.length ? first.map((segment) => escapeHtml(text(segment))).join(' ') : 'Add a transcript to generate a source-grounded summary.'}</p>`,
    '<h2>Detailed Lecture Notes</h2>',
    list(details, 'No transcript details are available yet.'),
    '<h2>Key Concepts</h2>',
    list(keywords.map((keyword) => `<strong>${escapeHtml(keyword)}</strong>`), 'Key concepts will appear after transcription.'),
    '<h2>Definitions</h2>',
    list(definitions.map((segment) => `${escapeHtml(text(segment))} ${citation(segment)}`), 'No explicit definitions were detected.'),
    '<h2>Examples</h2>',
    list(examples.map((segment) => `${escapeHtml(text(segment))} ${citation(segment)}`), 'No explicit examples were detected.'),
    '<h2>Formulas / Technical Information</h2>',
    list(segments.filter((segment) => /[=+−*/^]|equation|formula|algorithm|function|derivative|integral/i.test(text(segment))).slice(0, 5).map((segment) => `${escapeHtml(text(segment))} ${citation(segment)}`), 'No formulas or technical expressions were detected.'),
    '<h2>Important Professor Notes</h2>',
    list([...marked, ...keySegments.map((segment) => `${escapeHtml(text(segment))} ${citation(segment)}`)].slice(0, 7), 'No marked or explicit emphasis was detected.'),
    '<h2>Possible Exam Topics</h2>',
    '<p><em>LectureAI suggests reviewing these topics; this is not a claim that the professor said they will be on an exam.</em></p>',
    list(keywords.slice(0, 5).map((keyword) => `Review <strong>${escapeHtml(keyword)}</strong> and explain it using the lecture recording.`), 'Review the main ideas after a transcript is added.'),
    '<h2>Study Questions</h2>',
    list(keywords.slice(0, 5).map((keyword) => `How would you explain <strong>${escapeHtml(keyword)}</strong> in your own words?`), 'What was the central idea of this lecture?'),
  ].join('');
}
