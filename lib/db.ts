import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AppSettings, AudioChunk, Course, Lecture, StoredAttachment, StoredAudio } from './types.ts';
import { generateNotesHtml } from './notes.ts';

const LEGACY_DEMO_COURSE_ID = 'course-calculus';
const LEGACY_DEMO_LECTURE_ID = 'lecture-chain-rule';

type LegacySettings = Omit<AppSettings, 'preferredMode'> & { preferredMode?: string };

interface LectureAIDatabase extends DBSchema {
  courses: { key: string; value: Course; indexes: { semester: string } };
  lectures: { key: string; value: Lecture; indexes: { courseId: string; date: string; status: string } };
  audioChunks: { key: string; value: AudioChunk; indexes: { lectureId: string } };
  audioFiles: { key: string; value: StoredAudio };
  attachments: { key: string; value: StoredAttachment; indexes: { lectureId: string } };
  settings: { key: string; value: AppSettings };
}

let databasePromise: Promise<IDBPDatabase<LectureAIDatabase>> | null = null;

export function getDatabase() {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available in this browser.');
  if (!databasePromise) {
    databasePromise = openDB<LectureAIDatabase>('lectureai', 1, {
      upgrade(db) {
        const courses = db.createObjectStore('courses', { keyPath: 'id' });
        courses.createIndex('semester', 'semester');
        const lectures = db.createObjectStore('lectures', { keyPath: 'id' });
        lectures.createIndex('courseId', 'courseId');
        lectures.createIndex('date', 'date');
        lectures.createIndex('status', 'status');
        const chunks = db.createObjectStore('audioChunks', { keyPath: 'id' });
        chunks.createIndex('lectureId', 'lectureId');
        db.createObjectStore('audioFiles', { keyPath: 'lectureId' });
        const attachments = db.createObjectStore('attachments', { keyPath: 'id' });
        attachments.createIndex('lectureId', 'lectureId');
        db.createObjectStore('settings', { keyPath: 'key' });
      },
    });
  }
  return databasePromise;
}

export async function initializeDatabase() {
  const db = await getDatabase();
  await removeLegacyDemoData(db);
  const currentSettings = await db.get('settings', 'app') as LegacySettings | undefined;
  if (!currentSettings) {
    await db.put('settings', { key: 'app', consentAcknowledged: false, followTranscript: true, preferredMode: 'computer', phoneModelInstalled: false });
  } else if (currentSettings.preferredMode === 'maximum') {
    await db.put('settings', { ...currentSettings, preferredMode: 'computer' } as AppSettings);
  }
  const savedWithoutTranscript = (await db.getAllFromIndex('lectures', 'status', 'saved')).filter((lecture) => !lecture.segments.length);
  await Promise.all(savedWithoutTranscript.map((lecture) => db.put('lectures', { ...lecture, status: 'transcription-queued', statusMessage: 'Original audio preserved · transcription queued', processingProgress: 0, updatedAt: new Date().toISOString() })));
  const interrupted = await db.getAllFromIndex('lectures', 'status', 'recording');
  await Promise.all(interrupted.map((lecture) => db.put('lectures', { ...lecture, status: 'interrupted', statusMessage: 'Recording was interrupted; saved chunks can be recovered.', updatedAt: new Date().toISOString() })));

  for (const status of ['preparing', 'transcribing', 'checking', 'generating-notes'] as const) {
    const stuck = await db.getAllFromIndex('lectures', 'status', status);
    await Promise.all(stuck.map(async (lecture) => {
      if (!lecture.segments.length) return db.put('lectures', { ...lecture, status: 'transcription-queued', statusMessage: 'Interrupted transcription recovered · retrying the same saved recording', processingProgress: 0, updatedAt: new Date().toISOString() });
      const notes = lecture.notesCurrent || generateNotesHtml(lecture);
      return db.put('lectures', { ...lecture, notesCurrent: notes, notesOriginal: lecture.notesOriginal || notes, noteVersions: lecture.noteVersions.length ? lecture.noteVersions : [{ id: crypto.randomUUID(), html: notes, createdAt: new Date().toISOString(), label: 'Recovered generated notes' }], status: 'done', statusMessage: 'Recovered transcript and editable notes after an interrupted processing session.', processingProgress: 100, updatedAt: new Date().toISOString() });
    }));
  }
}

async function removeLegacyDemoData(db: IDBPDatabase<LectureAIDatabase>) {
  const lecturesUsingDemoCourse = await db.getAllFromIndex('lectures', 'courseId', LEGACY_DEMO_COURSE_ID);
  await Promise.all(lecturesUsingDemoCourse
    .filter((lecture) => lecture.id !== LEGACY_DEMO_LECTURE_ID)
    .map((lecture) => db.put('lectures', { ...lecture, courseId: '', updatedAt: new Date().toISOString() })));

  if (await db.get('lectures', LEGACY_DEMO_LECTURE_ID)) await deleteLectureData(LEGACY_DEMO_LECTURE_ID);
  await db.delete('courses', LEGACY_DEMO_COURSE_ID);
}

export async function loadLibrary() {
  const db = await getDatabase();
  const [courses, lectures, settings] = await Promise.all([db.getAll('courses'), db.getAll('lectures'), db.get('settings', 'app')]);
  return {
    courses: courses.sort((a, b) => a.name.localeCompare(b.name)),
    lectures: lectures.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    settings: settings!,
  };
}

export async function saveCourse(course: Course) {
  return (await getDatabase()).put('courses', course);
}

export async function saveLecture(lecture: Lecture) {
  return (await getDatabase()).put('lectures', { ...lecture, updatedAt: new Date().toISOString() });
}

export async function saveSettings(settings: AppSettings) {
  return (await getDatabase()).put('settings', settings);
}

export async function saveAudioChunk(chunk: AudioChunk) {
  return (await getDatabase()).put('audioChunks', chunk);
}

export async function getAudioChunks(lectureId: string) {
  const chunks = await (await getDatabase()).getAllFromIndex('audioChunks', 'lectureId', lectureId);
  return chunks.sort((a, b) => a.index - b.index);
}

export async function finalizeAudio(lectureId: string, mimeType: string) {
  const db = await getDatabase();
  const chunks = await getAudioChunks(lectureId);
  if (!chunks.length) throw new Error('No recoverable audio chunks were found.');
  const blob = new Blob(chunks.map((chunk) => chunk.blob), { type: mimeType || chunks[0].mimeType });
  await db.put('audioFiles', { lectureId, blob, mimeType: blob.type, size: blob.size, createdAt: new Date().toISOString() });
  return blob;
}

export async function deleteAudioChunks(lectureId: string) {
  const db = await getDatabase();
  const chunks = await getAudioChunks(lectureId);
  const tx = db.transaction('audioChunks', 'readwrite');
  for (const chunk of chunks) await tx.store.delete(chunk.id);
  await tx.done;
}

export async function getAudio(lectureId: string) {
  return (await getDatabase()).get('audioFiles', lectureId);
}

export async function saveImportedAudio(lectureId: string, blob: Blob) {
  return (await getDatabase()).put('audioFiles', { lectureId, blob, mimeType: blob.type || 'application/octet-stream', size: blob.size, createdAt: new Date().toISOString() });
}

export async function addAttachment(attachment: StoredAttachment) {
  return (await getDatabase()).put('attachments', attachment);
}

export async function getAttachment(id: string) {
  return (await getDatabase()).get('attachments', id);
}

export async function deleteLectureData(lectureId: string) {
  const db = await getDatabase();
  const tx = db.transaction(['lectures', 'audioFiles', 'audioChunks', 'attachments'], 'readwrite');
  await tx.objectStore('lectures').delete(lectureId);
  await tx.objectStore('audioFiles').delete(lectureId);
  for (const chunk of await tx.objectStore('audioChunks').index('lectureId').getAllKeys(lectureId)) await tx.objectStore('audioChunks').delete(chunk);
  for (const attachment of await tx.objectStore('attachments').index('lectureId').getAllKeys(lectureId)) await tx.objectStore('attachments').delete(attachment);
  await tx.done;
}

export async function createBackup() {
  const db = await getDatabase();
  const [courses, lectures, settings] = await Promise.all([db.getAll('courses'), db.getAll('lectures'), db.get('settings', 'app')]);
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), courses, lectures, settings };
}

export async function clearAllDataForDevelopmentTest() {
  if (import.meta.env.PROD) throw new Error('Development data reset is unavailable in production.');
  const db = await getDatabase();
  const tx = db.transaction(['courses', 'lectures', 'audioChunks', 'audioFiles', 'attachments', 'settings'], 'readwrite');
  await Promise.all([
    tx.objectStore('courses').clear(),
    tx.objectStore('lectures').clear(),
    tx.objectStore('audioChunks').clear(),
    tx.objectStore('audioFiles').clear(),
    tx.objectStore('attachments').clear(),
    tx.objectStore('settings').clear(),
  ]);
  await tx.done;
}
