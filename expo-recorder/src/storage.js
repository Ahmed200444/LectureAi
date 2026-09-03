import Storage from 'expo-sqlite/kv-store';
import { Directory, File, Paths } from 'expo-file-system';

const LIBRARY_KEY = 'lectureai.unified.library.v1';
const SETTINGS_KEY = 'lectureai.unified.settings.v1';

export const defaultSettings = {
  keepScreenAwake: true,
  autoOpenShareSheet: false,
  verifyBeforeTrusting: true,
  preferredTranscription: 'computer',
};

function nowIso() {
  return new Date().toISOString();
}

function ensureRecordingDirectory() {
  const root = new Directory(Paths.document, 'LectureAI');
  if (!root.exists) root.create();
  const recordings = new Directory(root, 'Recordings');
  if (!recordings.exists) recordings.create();
  return recordings;
}

function safeName(value) {
  return String(value || 'Lecture')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Lecture';
}

export async function loadLibrary() {
  const raw = await Storage.getItem(LIBRARY_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))) : [];
  } catch {
    return [];
  }
}

export async function saveLibrary(lectures) {
  const clean = [...lectures].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  await Storage.setItem(LIBRARY_KEY, JSON.stringify(clean));
  return clean;
}

export async function loadSettings() {
  const raw = await Storage.getItem(SETTINGS_KEY);
  if (!raw) return defaultSettings;
  try {
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return defaultSettings;
  }
}

export async function saveSettings(settings) {
  const next = { ...defaultSettings, ...settings };
  await Storage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export async function preserveAudioFile(sourceUri, lectureId, title, extension = 'm4a') {
  if (!sourceUri) throw new Error('The recorder did not return an audio file.');
  const source = new File(sourceUri);
  if (!source.exists || source.size < 1024) throw new Error('The captured audio file is missing or too small to trust.');

  const recordings = ensureRecordingDirectory();
  const filename = `${safeName(title)}-${lectureId.slice(0, 8)}.${String(extension || 'm4a').replace(/^\./, '')}`;
  const destination = new File(recordings, filename);
  if (destination.exists) destination.delete();
  source.copy(destination);

  const info = destination.info({ md5: true });
  if (!destination.exists || destination.size < 1024) throw new Error('LectureAI could not verify the preserved audio file after copying it into permanent storage.');

  return {
    uri: destination.uri,
    size: destination.size,
    md5: info.md5 || destination.md5 || null,
    filename,
  };
}

export function createLecture({ id, title, audio, durationMs, marks = [], source = 'recorded' }) {
  const createdAt = nowIso();
  return {
    id,
    title: safeName(title),
    course: '',
    professor: '',
    createdAt,
    updatedAt: createdAt,
    durationMs: Math.max(0, Math.round(durationMs || 0)),
    size: audio.size,
    audioUri: audio.uri,
    audioFilename: audio.filename,
    audioMd5: audio.md5,
    audioSource: source,
    audioVerification: 'needs-listen-check',
    marks,
    transcript: [],
    transcriptVersion: 0,
    transcriptStatus: 'not-started',
    transcriptEngine: null,
    translations: { en: [], ar: [] },
    translationsSourceVersion: null,
    studyPack: null,
    studyPackSourceVersion: null,
    staleDerivedContent: false,
  };
}

export async function upsertLecture(lecture) {
  const library = await loadLibrary();
  const next = {
    ...lecture,
    updatedAt: nowIso(),
  };
  await saveLibrary([next, ...library.filter((item) => item.id !== lecture.id)]);
  return next;
}

export async function removeLecture(lecture) {
  try {
    if (lecture?.audioUri) {
      const file = new File(lecture.audioUri);
      if (file.exists) file.delete();
    }
  } finally {
    const library = await loadLibrary();
    await saveLibrary(library.filter((item) => item.id !== lecture.id));
  }
}

export function markAudioVerified(lecture) {
  return {
    ...lecture,
    audioVerification: 'user-playback-confirmed',
    updatedAt: nowIso(),
  };
}

export function replaceTranscript(lecture, segments, engine = 'import') {
  const version = Number(lecture.transcriptVersion || 0) + 1;
  return {
    ...lecture,
    transcript: segments,
    transcriptVersion: version,
    transcriptStatus: segments.length ? 'ready' : 'not-started',
    transcriptEngine: engine,
    staleDerivedContent: true,
    updatedAt: nowIso(),
  };
}

export function updateTranscriptSegment(lecture, segmentId, text) {
  const transcript = lecture.transcript.map((segment) => segment.id === segmentId ? { ...segment, editedText: text, manuallyReviewed: true } : segment);
  return replaceTranscript(lecture, transcript, lecture.transcriptEngine || 'edited');
}
