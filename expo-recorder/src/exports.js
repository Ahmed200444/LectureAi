import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

function safeName(value) {
  return String(value || 'Lecture')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Lecture';
}

function formatTime(seconds = 0) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function transcriptText(segment) {
  return String(segment?.editedText || segment?.originalText || segment?.text || '').trim();
}

function studyIsFresh(lecture) {
  return Boolean(lecture?.studyPack)
    && Number(lecture.studyPackSourceVersion) === Number(lecture.transcriptVersion || 0);
}

function sourceSuffix(item) {
  if (!item?.source) return '';
  return ` (${formatTime(item.source.startTime)} source)`;
}

function markdownItems(items = []) {
  return items.map((item) => `- ${String(item?.text || '').trim()}${sourceSuffix(item)}`).join('\n');
}

export function buildTranscriptText(lecture) {
  const rows = (lecture?.transcript || [])
    .map((segment) => {
      const text = transcriptText(segment);
      if (!text) return null;
      const speaker = String(segment?.speaker || 'Speaker');
      return `[${formatTime(segment.startTime)}–${formatTime(segment.endTime)}] ${speaker}: ${text}`;
    })
    .filter(Boolean);
  if (!rows.length) throw new Error('This lecture does not have a transcript to export.');
  return `${safeName(lecture.title)}\n\n${rows.join('\n\n')}\n`;
}

export function buildNotesMarkdown(lecture) {
  if (!studyIsFresh(lecture)) {
    throw new Error('Notes are missing or stale. Regenerate derived content from the current transcript before exporting notes.');
  }
  const pack = lecture.studyPack;
  return [
    `# ${safeName(lecture.title)} — Notes`,
    '',
    'Generated from the current timestamped transcript. Original audio remains the source of truth.',
    '',
    '## Lecture summary',
    markdownItems(pack.summary) || '- No summary items available.',
    '',
    '## Detailed lecture notes',
    markdownItems(pack.detailedNotes) || '- No detailed notes available.',
    '',
    '## Key concepts',
    (pack.keyConcepts || []).map((item) => `- ${item}`).join('\n') || '- No key concepts available.',
    '',
    '## Definitions',
    markdownItems(pack.definitions) || '- No definitions identified.',
    '',
    '## Examples',
    markdownItems(pack.examples) || '- No examples identified.',
    '',
    '## Formulas / technical information',
    markdownItems(pack.technicalInformation) || '- No technical items identified.',
    '',
    '## Lecture emphasis',
    markdownItems(pack.professorEmphasis) || '- No emphasis items identified.',
    '',
  ].join('\n');
}

export function buildStudyMarkdown(lecture) {
  if (!studyIsFresh(lecture)) {
    throw new Error('Study material is missing or stale. Regenerate it from the current transcript before exporting.');
  }
  const pack = lecture.studyPack;
  return [
    `# ${safeName(lecture.title)} — Study Guide`,
    '',
    'Possible exam topics are review suggestions only; they are not claims about what will appear on an exam.',
    '',
    '## Key concepts',
    (pack.keyConcepts || []).map((item) => `- ${item}`).join('\n') || '- No key concepts available.',
    '',
    '## Possible exam review topics',
    (pack.possibleExamTopics || []).map((item) => `- **${item.topic}** — ${item.note}`).join('\n') || '- No review topics available.',
    '',
    '## Study questions',
    (pack.studyQuestions || []).map((item, index) => `${index + 1}. **${String(item.type || 'question').toUpperCase()}** — ${item.question}`).join('\n') || '- No study questions available.',
    '',
  ].join('\n');
}

export function buildLectureJson(lecture) {
  if (!lecture) throw new Error('No lecture selected.');
  return JSON.stringify({
    format: 'lectureai-expo-export-v1',
    exportedAt: new Date().toISOString(),
    lecture: {
      id: lecture.id,
      title: lecture.title,
      course: lecture.course || '',
      professor: lecture.professor || '',
      createdAt: lecture.createdAt,
      updatedAt: lecture.updatedAt,
      durationMs: lecture.durationMs,
      size: lecture.size,
      audioFilename: lecture.audioFilename,
      audioMd5: lecture.audioMd5 || null,
      audioVerification: lecture.audioVerification,
      marks: lecture.marks || [],
      transcriptVersion: lecture.transcriptVersion || 0,
      transcriptEngine: lecture.transcriptEngine || null,
      transcriptionMetadata: lecture.transcriptionMetadata || null,
      transcript: lecture.transcript || [],
      translations: lecture.translations || { en: [], ar: [] },
      translationsSourceVersion: lecture.translationsSourceVersion ?? null,
      studyPack: studyIsFresh(lecture) ? lecture.studyPack : null,
      studyPackSourceVersion: studyIsFresh(lecture) ? lecture.studyPackSourceVersion : null,
      staleDerivedContent: !studyIsFresh(lecture) && Boolean(lecture.studyPack),
    },
    originalAudio: {
      filename: lecture.audioFilename,
      md5: lecture.audioMd5 || null,
      note: 'Original audio is exported separately through Share / Save to Files and is never embedded or modified by this JSON export.',
    },
  }, null, 2);
}

async function writeAndShare(lecture, suffix, extension, content, mimeType, UTI) {
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('The system share sheet is not available on this device.');
  const filename = `${safeName(lecture?.title)}-${suffix}.${extension}`;
  const file = new File(Paths.cache, filename);
  if (file.exists) file.delete();
  file.create();
  file.write(content);
  await Sharing.shareAsync(file.uri, {
    dialogTitle: `Export ${safeName(lecture?.title)}`,
    mimeType,
    UTI,
  });
  return file.uri;
}

export async function exportTranscript(lecture) {
  return writeAndShare(lecture, 'transcript', 'txt', buildTranscriptText(lecture), 'text/plain', 'public.plain-text');
}

export async function exportNotes(lecture) {
  return writeAndShare(lecture, 'notes', 'md', buildNotesMarkdown(lecture), 'text/markdown', 'net.daringfireball.markdown');
}

export async function exportStudyGuide(lecture) {
  return writeAndShare(lecture, 'study-guide', 'md', buildStudyMarkdown(lecture), 'text/markdown', 'net.daringfireball.markdown');
}

export async function exportLectureData(lecture) {
  return writeAndShare(lecture, 'lecture-data', 'json', buildLectureJson(lecture), 'application/json', 'public.json');
}
