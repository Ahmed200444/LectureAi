import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const metadataSource = readFileSync(new URL('../expo-recorder/src/lecture-metadata.js', import.meta.url), 'utf8');
const {
  lectureDisplayTitle,
  lectureExportFilename,
  migrateLectureMetadata,
  renameLectureTitle,
  safeFilenameStem,
} = await import(`data:text/javascript;base64,${Buffer.from(metadataSource).toString('base64')}`);

const createdAt = '2026-09-08T06:30:00.000Z';
const baseRows = Array.from({ length: 4 }, (_, index) => ({
  id: `legacy-${index + 1}`,
  createdAt,
  updatedAt: createdAt,
  audioUri: `file:///private/LectureAI/Recordings/original-${index + 1}.m4a`,
  audioFilename: `original-${index + 1}.m4a`,
  audioMd5: `${index + 1}`.repeat(32),
  originalAudioProtected: true,
  enhancedAudio: index === 0 ? {
    uri: 'file:///private/LectureAI/DerivedAudio/legacy-1-balanced.wav',
    md5: 'e'.repeat(32),
    sourceMd5: '1'.repeat(32),
    cleanupMode: 'balanced',
  } : undefined,
  transcript: index === 0 ? [{ id: 's1', startTime: 12.5, endTime: 18.25, editedText: 'Synthetic text' }] : [],
  transcriptVersion: index === 0 ? 1 : 0,
  windowsTranscriptionJob: index === 0 ? { id: 'synthetic-job', completedAudioSeconds: 300, status: 'interrupted' } : null,
}));

function protectedIdentity(lecture) {
  return {
    audioUri: lecture.audioUri,
    audioFilename: lecture.audioFilename,
    audioMd5: lecture.audioMd5,
    enhancedAudio: lecture.enhancedAudio,
    transcript: lecture.transcript,
    transcriptVersion: lecture.transcriptVersion,
    windowsTranscriptionJob: lecture.windowsTranscriptionJob,
  };
}

const migrated = baseRows.map(migrateLectureMetadata);
assert.equal(migrated.length, 4);
assert.ok(migrated.every((lecture) => lecture.title.startsWith('Untitled Lecture')));
assert.deepEqual(migrated.map(protectedIdentity), baseRows.map(protectedIdentity));

const requestedTitles = [
  '  Computer Science - Lecture 4  ',
  'محاضرة الذكاء الاصطناعي',
  'الـ Neural Network - Lecture 7',
  'C++ Lecture 8 - Classes & Objects (Part 2)',
];
const renamed = migrated.map((lecture, index) => {
  const before = protectedIdentity(lecture);
  const next = renameLectureTitle(lecture, requestedTitles[index], `2026-09-08T07:0${index}:00.000Z`);
  assert.deepEqual(protectedIdentity(next), before);
  return next;
});
assert.equal(renamed[0].title, 'Computer Science - Lecture 4');
assert.equal(renamed[1].title, 'محاضرة الذكاء الاصطناعي');
assert.equal(renamed[2].title, 'الـ Neural Network - Lecture 7');
assert.equal(renamed[3].title, 'C++ Lecture 8 - Classes & Objects (Part 2)');

const restarted = JSON.parse(JSON.stringify(renamed)).map(migrateLectureMetadata);
assert.deepEqual(restarted.map((lecture) => lecture.title), renamed.map((lecture) => lecture.title));
assert.deepEqual(restarted.map(protectedIdentity), renamed.map(protectedIdentity));

assert.throws(() => renameLectureTitle(restarted[0], ' \n\t '), /cannot be blank/i);
assert.equal(lectureDisplayTitle('', 'invalid-date'), 'Untitled Lecture');
assert.equal(safeFilenameStem(' AI: Neural / Networks? '), 'AI- Neural - Networks-');
assert.equal(lectureExportFilename('AI: Neural / Networks?', 'Transcript', 'txt'), 'AI- Neural - Networks- Transcript.txt');
assert.equal(lectureExportFilename('محاضرة AI: 7', 'Study Guide', '.md'), 'محاضرة AI- 7 Study Guide.md');

const longTitle = `Advanced Systems ${'Architecture '.repeat(30)}`;
const futureNamed = migrateLectureMetadata({ ...baseRows[0], id: 'future-named', title: longTitle });
assert.ok(futureNamed.title.length <= 180);
const futureUnnamed = migrateLectureMetadata({ ...baseRows[1], id: 'future-unnamed', title: '   ' });
assert.ok(futureUnnamed.title.startsWith('Untitled Lecture'));

const afterTranscriptionRename = renameLectureTitle(restarted[0], 'Data Structures - Dijkstra');
assert.deepEqual(protectedIdentity(afterTranscriptionRename), protectedIdentity(restarted[0]));
assert.equal(afterTranscriptionRename.transcript[0].startTime, 12.5);
assert.equal(afterTranscriptionRename.enhancedAudio.uri, restarted[0].enhancedAudio.uri);
assert.equal(afterTranscriptionRename.windowsTranscriptionJob.id, 'synthetic-job');

console.log('✓ four legacy and future Lecture Names migrate, persist, export safely, and never alter audio/transcript/enhancement/job identity');
