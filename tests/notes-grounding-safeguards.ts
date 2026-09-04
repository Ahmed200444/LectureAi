import assert from 'node:assert/strict';
import { generateNotesHtml } from '../lib/notes.ts';
import { normalizeTranscript } from '../lib/transcript.ts';
import type { Lecture } from '../lib/types.ts';

const now = new Date().toISOString();
const rawSegments = Array.from({ length: 40 }, (_, index) => ({
  start: index * 10,
  end: index * 10 + 8,
  text: index === 4
    ? '[uncertain] The exam definitely uses inventedWrongTerm and this must never become a trusted note.'
    : index === 36
      ? 'Important final lecture concept: persistentRedBlackTree controls the late-stage memory example.'
      : `Lecture section ${index + 1} explains the data structure concept and its application ${index + 1}.`,
}));

const lecture: Lecture = {
  id: 'long-grounding-test',
  courseId: '',
  title: 'Whole lecture grounding test',
  date: now,
  duration: 410,
  size: 1,
  status: 'done',
  segments: normalizeTranscript({ engine: 'faster-whisper', segments: rawSegments }, 'long-grounding-test'),
  englishTranslation: [],
  arabicTranslation: [],
  bookmarks: [],
  attachments: [],
  notesOriginal: '',
  notesCurrent: '',
  noteVersions: [],
  createdAt: now,
  updatedAt: now,
};

const notes = generateNotesHtml(lecture);

assert.match(notes, /Lecture Summary/);
assert.match(notes, /Detailed Lecture Notes/);
assert.match(notes, /data-time=/);
assert.match(notes, /persistentRedBlackTree/, 'late lecture content must be eligible for notes instead of only the opening segments');
assert.doesNotMatch(notes, /inventedWrongTerm/, 'uncertain ASR must not silently become trusted notes');
assert.doesNotMatch(notes, /\[uncertain\]/i);
assert.match(notes, /not a claim that the professor said they will be on an exam/i);

console.log('✓ web notes use whole-lecture source coverage and exclude uncertain ASR from trusted study material');
