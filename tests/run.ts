import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addAttachment, deleteAudioChunks, deleteLectureData, finalizeAudio, getAttachment, getAudio, getAudioChunks, getDatabase, initializeDatabase, loadLibrary, saveAudioChunk, saveLecture } from '../lib/db.ts';
import { formatBytes, formatTime, safeFilename } from '../lib/format.ts';
import { generateNotesHtml } from '../lib/notes.ts';
import { normalizeTranscript } from '../lib/transcript.ts';
import { completeTranscription, transcribeWithWindowsHelper } from '../lib/transcription.ts';
import { recordingFileExtension } from '../lib/device.ts';
import type { Lecture } from '../lib/types.ts';

const checks: Array<{ name: string; run: () => void | Promise<void> }> = [];

function test(name: string, run: () => void | Promise<void>) {
  checks.push({ name, run });
}

function lectureFixture(id = 'lecture-1'): Lecture {
  const now = new Date().toISOString();
  return {
    id, courseId: '', title: 'Real lecture', date: now, duration: 8, size: 8, status: 'transcribing',
    segments: [], englishTranslation: [], arabicTranslation: [], bookmarks: [], attachments: [], notesOriginal: '', notesCurrent: '', noteVersions: [], createdAt: now, updatedAt: now,
  };
}

test('formats short and long timestamps', () => {
  assert.equal(formatTime(754), '12:34');
  assert.equal(formatTime(3670), '1:01:10');
  assert.equal(formatTime(70, true), '0:01:10');
});

test('formats storage and safe filenames', () => {
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(safeFilename('Lecture: 4 / chain?'), 'Lecture- 4 - chain-');
});

test('maps practical transferred audio types without relabeling them as WebM', () => {
  assert.equal(recordingFileExtension('audio/mp4'), 'm4a');
  assert.equal(recordingFileExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(recordingFileExtension('audio/mpeg'), 'mp3');
  assert.equal(recordingFileExtension('audio/aac'), 'aac');
  assert.equal(recordingFileExtension('audio/ogg'), 'ogg');
  assert.equal(recordingFileExtension('audio/flac'), 'flac');
});

test('does not invent transcription confidence when a model provides none', () => {
  const segment = normalizeTranscript({ engine: 'transformers.js', segments: [{ start: 0, end: 2, text: 'المحاضرة uses a pointer هنا.', confidence: 0 }] }, 'no-fake-confidence')[0];
  assert.equal(segment.confidence, undefined);
  assert.equal(segment.manuallyReviewed, false);
  assert.equal(segment.detectedLanguage, 'mixed');
});

test('preserves explicit imported confidence without auto-marking human review', () => {
  const segment = normalizeTranscript({ segments: [{ start: 0, end: 2, text: 'Imported transcript.', confidence: .73 }] }, 'imported-confidence')[0];
  assert.equal(segment.confidence, .73);
  assert.equal(segment.manuallyReviewed, false);
});

test('preserves technical English inside Arabic during transcript import', () => {
  const segments = normalizeTranscript({ segments: [{ start: 12.4, end: 18.2, text: 'This pointer يعني بيشاور على memory address.', confidence: .73 }] }, 'lecture-1');
  assert.equal(segments[0].detectedLanguage, 'mixed');
  assert.equal(segments[0].confidence, .73);
  assert.match(segments[0].originalText, /pointer/);
});

test('detects Egyptian Arabic and MSA transcript text without translating it', () => {
  const egyptian = normalizeTranscript({ segments: [{ start: 0, end: 3, text: 'بص يا جماعة، إحنا كده هنستخدم الـ pointer عشان نوصل للعنوان.', confidence: .91 }] }, 'egyptian');
  assert.equal(egyptian[0].detectedLanguage, 'mixed');
  assert.match(egyptian[0].originalText, /إحنا/);
  assert.match(egyptian[0].originalText, /pointer/);
  const msa = normalizeTranscript({ segments: [{ start: 3, end: 6, text: 'هذه الدالة تمثل معدل التغير اللحظي.', confidence: .94 }] }, 'msa');
  assert.equal(msa[0].detectedLanguage, 'ar');
  assert.equal(msa[0].originalText, 'هذه الدالة تمثل معدل التغير اللحظي.');
});

test('rejects invalid timestamp boundaries', () => {
  assert.throws(() => normalizeTranscript({ segments: [{ start: 20, end: 10, text: 'bad' }] }, 'lecture-1'), /invalid/);
});

test('does not impose an artificial transcript segment cap', () => {
  const source = readFileSync(new URL('../lib/transcript.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /100_000|too many segments/i);
});

test('generates every required note section with source timestamps', () => {
  const now = new Date().toISOString();
  const lecture: Lecture = {
    id: 'lecture-1', courseId: 'course-1', title: 'Derivatives', date: now, duration: 30, size: 0, status: 'done',
    segments: normalizeTranscript({ segments: [{ start: 0, end: 10, text: 'The derivative means the instantaneous rate of change.', confidence: .98 }, { start: 10, end: 20, text: 'For example, take x squared.', confidence: .97 }] }, 'lecture-1'),
    englishTranslation: [], arabicTranslation: [], bookmarks: [], attachments: [], notesOriginal: '', notesCurrent: '', noteVersions: [], createdAt: now, updatedAt: now,
  };
  const notes = generateNotesHtml(lecture);
  for (const heading of ['Lecture Summary', 'Detailed Lecture Notes', 'Key Concepts', 'Definitions', 'Examples', 'Formulas / Technical Information', 'Important Professor Notes', 'Possible Exam Topics', 'Study Questions']) assert.ok(notes.includes(heading), `Missing note section: ${heading}`);
  assert.match(notes, /data-time="0"/);
});

test('starts with an empty production library and never seeds demo data', async () => {
  const db = await getDatabase();
  for (const store of ['attachments', 'audioChunks', 'audioFiles', 'lectures', 'courses', 'settings'] as const) await db.clear(store);
  await initializeDatabase();
  const library = await loadLibrary();
  assert.deepEqual(library.lectures, []);
  assert.deepEqual(library.courses, []);
  assert.equal(library.settings.key, 'app');
  assert.equal(library.settings.preferredMode, 'computer');
});

test('migrates the removed legacy maximum mode to computer transcription', async () => {
  const db = await getDatabase();
  await db.put('settings', { key: 'app', consentAcknowledged: true, followTranscript: true, preferredMode: 'maximum' as never, phoneModelInstalled: false });
  await initializeDatabase();
  assert.equal((await db.get('settings', 'app'))?.preferredMode, 'computer');
});

test('removes only the legacy production demo records', async () => {
  const db = await getDatabase();
  const now = new Date().toISOString();
  await db.put('courses', { id: 'course-calculus', name: 'Legacy fixture', code: 'FIXTURE', professor: '', semester: '', description: '', glossary: [], color: '#315f4b', icon: 'F', createdAt: now });
  await db.put('lectures', { id: 'lecture-chain-rule', courseId: 'course-calculus', title: 'Legacy fixture', date: now, duration: 0, size: 0, status: 'done', segments: [], englishTranslation: [], arabicTranslation: [], bookmarks: [], attachments: [], notesOriginal: '', notesCurrent: '', noteVersions: [], createdAt: now, updatedAt: now });
  await db.put('lectures', { id: 'user-lecture', courseId: 'course-calculus', title: 'Real user lecture', date: now, duration: 0, size: 0, status: 'done', segments: [], englishTranslation: [], arabicTranslation: [], bookmarks: [], attachments: [], notesOriginal: '', notesCurrent: '', noteVersions: [], createdAt: now, updatedAt: now });
  await initializeDatabase();
  assert.equal(await db.get('courses', 'course-calculus'), undefined);
  assert.equal(await db.get('lectures', 'lecture-chain-rule'), undefined);
  assert.equal((await db.get('lectures', 'user-lecture'))?.courseId, '');
  await db.delete('lectures', 'user-lecture');
});

test('runs the automatic Windows job flow and generates editable notes', async () => {
  const lecture = lectureFixture('automatic-flow');
  let polls = 0;
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/jobs')) return new Response(JSON.stringify({ job_id: 'job-1' }), { status: 202, headers: { 'content-type': 'application/json' } });
    polls += 1;
    if (polls === 1) return new Response(JSON.stringify({ id: 'job-1', status: 'transcribing', progress: 48, message: 'Transcribing locally' }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: 'job-1', status: 'complete', progress: 100, message: 'Ready', result: { segments: [{ start: 0, end: 3.2, text: 'The derivative is the rate of change.', confidence: .97 }] } }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const progress: number[] = [];
  const payload = await transcribeWithWindowsHelper(lecture, undefined, new Blob(['recording'], { type: 'audio/webm' }), (update) => progress.push(update.progress), fetcher, async () => undefined);
  const completed = completeTranscription(lecture, payload, 'windows', 'configured faster-whisper');
  assert.equal(completed.status, 'done');
  assert.equal(completed.segments.length, 1);
  assert.match(completed.notesCurrent, /Detailed Lecture Notes/);
  assert.ok(progress.includes(48));
});

test('persists transcript edits and deletes the recording with all lecture data', async () => {
  const db = await getDatabase();
  const lecture = lectureFixture('delete-me');
  const edited = { ...lecture, status: 'done' as const, segments: normalizeTranscript({ segments: [{ start: 0, end: 2, text: 'Corrected technical term.', confidence: .99 }] }, lecture.id) };
  await saveLecture(edited);
  await db.put('audioFiles', { lectureId: lecture.id, blob: new Blob(['audio']), mimeType: 'audio/webm', size: 5, createdAt: new Date().toISOString() });
  await saveAudioChunk({ id: 'delete-chunk', lectureId: lecture.id, index: 0, blob: new Blob(['chunk']), mimeType: 'audio/webm', createdAt: new Date().toISOString() });
  await addAttachment({ id: 'delete-attachment', lectureId: lecture.id, blob: new Blob(['file']), name: 'slide.txt', type: 'text/plain', size: 4 });
  assert.equal((await db.get('lectures', lecture.id))?.segments[0].editedText, 'Corrected technical term.');
  await deleteLectureData(lecture.id);
  assert.equal(await db.get('lectures', lecture.id), undefined);
  assert.equal(await getAudio(lecture.id), undefined);
  assert.equal((await getAudioChunks(lecture.id)).length, 0);
  assert.equal(await getAttachment('delete-attachment'), undefined);
});

test('assembles checkpoint chunks in order and keeps the original audio', async () => {
  const db = await getDatabase();
  await db.clear('audioChunks');
  await db.clear('audioFiles');
  await saveAudioChunk({ id: 'chunk-2', lectureId: 'recording-test', index: 1, blob: new Blob(['B']), mimeType: 'audio/webm', createdAt: new Date().toISOString() });
  await saveAudioChunk({ id: 'chunk-1', lectureId: 'recording-test', index: 0, blob: new Blob(['A']), mimeType: 'audio/webm', createdAt: new Date().toISOString() });
  assert.equal((await getAudioChunks('recording-test')).length, 2);
  const combined = await finalizeAudio('recording-test', 'audio/webm');
  assert.equal(await combined.text(), 'AB');
  assert.equal((await getAudio('recording-test'))?.size, 2);
  assert.equal((await getAudioChunks('recording-test')).length, 2, 'checkpoints stay until playback validation succeeds');
  await deleteAudioChunks('recording-test');
  assert.equal((await getAudioChunks('recording-test')).length, 0);
});

test('recovers an interrupted transcription without creating a duplicate lecture', async () => {
  const db = await getDatabase();
  const lecture = { ...lectureFixture('stuck-processing'), status: 'transcribing' as const, statusMessage: 'Transcribing…' };
  await saveLecture(lecture);
  await initializeDatabase();
  const recovered = await db.get('lectures', lecture.id);
  assert.equal(recovered?.status, 'transcription-queued');
  assert.equal((await db.getAll('lectures')).filter((item) => item.id === lecture.id).length, 1);
  await db.delete('lectures', lecture.id);
});

test('keeps mobile recording and transcript length unlimited by policy while guarding against silent audio', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const flow = readFileSync(new URL('../components/RecordingFlow.tsx', import.meta.url), 'utf8');
  const recorder = readFileSync(new URL('../hooks/use-recorder.ts', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('../components/LectureDetail.tsx', import.meta.url), 'utf8');
  const exporter = readFileSync(new URL('../lib/export.ts', import.meta.url), 'utf8');
  const manifest = readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /8 GB local safety limit/);
  assert.match(app, /no artificial recording-duration, transcript-length, segment-count, or monthly-minute quota/);
  assert.doesNotMatch(recorder, /waitForAudibleInput/);
  assert.match(recorder, /recorder\.start\(5_000\)/);
  assert.match(recorder, /checkpointFailureRef/);
  assert.doesNotMatch(recorder, /track\.enabled = false/);
  assert.match(recorder, /if \(verified\.duration\) elapsedRef\.current = verified\.duration/);
  assert.match(flow, /disabled=\{!micVerified \|\| controlsBusy\}/);
  assert.match(flow, /Audio playback verified/);
  assert.match(flow, /Verify saved lecture audio/);
  assert.doesNotMatch(detail, /50 MB safety limit/);
  assert.match(detail, /Delete lecture/);
  assert.match(detail, /deleteLectureData/);
  assert.match(exporter, /nav\.share/);
  assert.match(manifest, /"display": "standalone"/);
});

test('keeps multilingual phone transcription fallbacks and predownload support', () => {
  const worker = readFileSync(new URL('../lib/phone-transcriber.worker.ts', import.meta.url), 'utf8');
  const phone = readFileSync(new URL('../lib/phone-transcription.ts', import.meta.url), 'utf8');
  assert.match(worker, /whisper-small/);
  assert.match(worker, /whisper-base/);
  assert.match(worker, /whisper-tiny/);
  assert.match(worker, /mode === 'prepare'/);
  assert.match(phone, /preparePhoneTranscriptionModel/);
  assert.match(phone, /WINDOW_SECONDS = 180/);
});

let failed = 0;
for (const check of checks) {
  try {
    await check.run();
    console.log(`✓ ${check.name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${check.name}`);
    console.error(error);
  }
}

if (failed) {
  console.error(`\n${failed} of ${checks.length} checks failed.`);
  process.exitCode = 1;
} else {
  console.log(`\n${checks.length} automated checks passed.`);
}
