import Storage from 'expo-sqlite/kv-store';
import * as SecureStore from 'expo-secure-store';
import { Directory, File, Paths } from 'expo-file-system';

const LIBRARY_KEY = 'lectureai.unified.library.v1';
const SETTINGS_KEY = 'lectureai.unified.settings.v1';
const COMPUTER_TOKEN_KEY = 'lectureai.windows.pairing-token.v1';
const LIBRARY_BACKUP_FILENAME = 'library-backup.json';
const AUDIO_EXTENSIONS = new Set(['.m4a', '.mp4', '.aac', '.wav', '.mp3', '.ogg', '.flac', '.webm']);

export const defaultSettings = {
  keepScreenAwake: true,
  autoOpenShareSheet: false,
  verifyBeforeTrusting: true,
  preferredTranscription: 'computer',
  computerAddress: '',
  computerToken: '',
  computerTokenExpiresAt: null,
};

function nowIso() {
  return new Date().toISOString();
}

function ensureRootDirectory() {
  const root = new Directory(Paths.document, 'LectureAI');
  if (!root.exists) root.create();
  return root;
}

function ensureRecordingDirectory() {
  const root = ensureRootDirectory();
  const recordings = new Directory(root, 'Recordings');
  if (!recordings.exists) recordings.create();
  return recordings;
}

function libraryBackupFile() {
  return new File(ensureRootDirectory(), LIBRARY_BACKUP_FILENAME);
}

function writeLibraryBackup(lectures) {
  try {
    const file = libraryBackupFile();
    if (!file.exists) file.create();
    file.write(JSON.stringify(lectures));
    return true;
  } catch {
    return false;
  }
}

function readLibraryBackup() {
  try {
    const file = libraryBackupFile();
    if (!file.exists || !file.size) return [];
    const parsed = JSON.parse(file.textSync());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function newestUpdate(lectures) {
  return (lectures || []).reduce((latest, lecture) => {
    const stamp = Date.parse(String(lecture?.updatedAt || lecture?.createdAt || '')) || 0;
    return Math.max(latest, stamp);
  }, 0);
}

function safeName(value) {
  return String(value || 'Lecture')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Lecture';
}

function stableRecoveryId(file) {
  const source = `${file.name}:${file.size}:${file.creationTime || file.modificationTime || 0}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `recovered-${(hash >>> 0).toString(36)}`;
}

function recoveryTitle(file) {
  const withoutExtension = file.name.replace(/\.[^.]+$/, '');
  return safeName(withoutExtension.replace(/-[a-z0-9]{8}$/i, '') || 'Recovered lecture');
}

function defaultPlaybackChecks() {
  return { beginning: false, middle: false, end: false };
}

function recoveredLectureFromFile(file) {
  const created = file.creationTime || file.modificationTime;
  const createdAt = typeof created === 'number' && Number.isFinite(created) ? new Date(created).toISOString() : nowIso();
  return {
    id: stableRecoveryId(file),
    title: recoveryTitle(file),
    course: '',
    professor: '',
    createdAt,
    updatedAt: createdAt,
    durationMs: 0,
    size: file.size,
    audioUri: file.uri,
    audioFilename: file.name,
    audioMd5: file.md5 || null,
    audioSource: 'recovered-document-file',
    audioVerification: 'needs-listen-check',
    audioPlaybackChecks: defaultPlaybackChecks(),
    recoveryNotice: 'LectureAI recovered this original audio file from document storage after its library metadata was missing or unreadable. Listen to the beginning, middle, and end before trusting its duration or metadata.',
    marks: [],
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

function recoverOrphanedAudioFiles(lectures) {
  try {
    const recordings = ensureRecordingDirectory();
    const knownUris = new Set(lectures.map((lecture) => lecture?.audioUri).filter(Boolean));
    const knownNames = new Set(lectures.map((lecture) => lecture?.audioFilename).filter(Boolean));
    const recovered = [];
    for (const entry of recordings.list()) {
      if (!(entry instanceof File) || entry.size < 1024 || !AUDIO_EXTENSIONS.has(entry.extension.toLowerCase())) continue;
      if (knownUris.has(entry.uri) || knownNames.has(entry.name)) continue;
      recovered.push(recoveredLectureFromFile(entry));
    }
    return [...lectures, ...recovered];
  } catch {
    return lectures;
  }
}

function sortLibrary(lectures) {
  return [...lectures].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function loadLibrary() {
  const raw = await Storage.getItem(LIBRARY_KEY);
  const backup = readLibraryBackup();
  let parsed = [];
  let primaryReadable = false;

  if (raw) {
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) {
        parsed = value;
        primaryReadable = true;
      }
    } catch {
      // Fall through to backup.
    }
  } else {
    primaryReadable = true;
  }

  if (!primaryReadable) parsed = backup;
  else if (backup.length && newestUpdate(backup) > newestUpdate(parsed)) parsed = backup;

  const recovered = sortLibrary(recoverOrphanedAudioFiles(parsed));
  if (!primaryReadable || recovered.length !== parsed.length || newestUpdate(backup) > newestUpdate(parsed)) {
    try { await Storage.setItem(LIBRARY_KEY, JSON.stringify(recovered)); } catch { /* audio remains authoritative */ }
    writeLibraryBackup(recovered);
  }
  return recovered;
}

export async function saveLibrary(lectures) {
  const clean = sortLibrary(lectures);
  // Write the secondary document backup first so a failed primary KV write cannot
  // prevent the newest metadata from being recoverable on the next launch.
  writeLibraryBackup(clean);
  await Storage.setItem(LIBRARY_KEY, JSON.stringify(clean));
  return clean;
}

async function readPairingToken() {
  try { return await SecureStore.getItemAsync(COMPUTER_TOKEN_KEY) || ''; } catch { return ''; }
}

async function writePairingToken(token) {
  const value = String(token || '');
  try {
    if (value) await SecureStore.setItemAsync(COMPUTER_TOKEN_KEY, value);
    else await SecureStore.deleteItemAsync(COMPUTER_TOKEN_KEY);
  } catch (error) {
    if (value) throw new Error(`LectureAI could not securely save the Windows pairing token: ${error instanceof Error ? error.message : 'SecureStore unavailable.'}`);
  }
}

export async function loadSettings() {
  const raw = await Storage.getItem(SETTINGS_KEY);
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = {}; }

  const pairingAddress = String(parsed?.computerAddress || '').trim();
  const legacyToken = String(parsed?.computerToken || '');
  const secureToken = await readPairingToken();
  let computerToken = pairingAddress ? secureToken : '';

  if (pairingAddress && !computerToken && legacyToken) {
    try { await writePairingToken(legacyToken); computerToken = legacyToken; } catch { computerToken = legacyToken; }
  }
  if (!pairingAddress && secureToken) {
    computerToken = '';
    try { await SecureStore.deleteItemAsync(COMPUTER_TOKEN_KEY); } catch { /* retry later */ }
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'computerToken')) {
    const { computerToken: _removed, ...withoutToken } = parsed;
    try { await Storage.setItem(SETTINGS_KEY, JSON.stringify(withoutToken)); } catch { /* retry later */ }
    parsed = withoutToken;
  }
  return { ...defaultSettings, ...parsed, computerToken };
}

export async function saveSettings(settings) {
  const next = { ...defaultSettings, ...settings };
  const computerToken = String(next.computerToken || '');
  const { computerToken: _secureOnly, ...publicSettings } = next;
  await writePairingToken(computerToken);
  await Storage.setItem(SETTINGS_KEY, JSON.stringify(publicSettings));
  return { ...publicSettings, computerToken };
}

export async function preserveAudioFile(sourceUri, lectureId, title, extension = 'm4a') {
  if (!sourceUri) throw new Error('The recorder did not return an audio file.');
  const source = new File(sourceUri);
  if (!source.exists || source.size < 1024) throw new Error('The captured audio file is missing or too small to trust.');

  let sourceMd5 = null;
  try { sourceMd5 = source.info({ md5: true }).md5 || source.md5 || null; } catch { /* hash may be unavailable */ }

  const recordings = ensureRecordingDirectory();
  const filename = `${safeName(title)}-${lectureId.slice(0, 8)}.${String(extension || 'm4a').replace(/^\./, '')}`;
  const destination = new File(recordings, filename);
  if (destination.exists) destination.delete();
  source.copy(destination);

  const info = destination.info({ md5: true });
  const destinationMd5 = info.md5 || destination.md5 || null;
  if (!destination.exists || destination.size < 1024) throw new Error('LectureAI could not verify the preserved audio file after copying it into permanent storage.');
  if (sourceMd5 && destinationMd5 && sourceMd5.toLowerCase() !== destinationMd5.toLowerCase()) {
    try { destination.delete(); } catch { /* fail closed */ }
    throw new Error('The permanent audio copy did not match the recorder file. The source was not modified; retry preservation before trusting this lecture.');
  }

  return { uri: destination.uri, size: destination.size, md5: destinationMd5, filename };
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
    audioPlaybackChecks: defaultPlaybackChecks(),
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
  const next = { ...lecture, updatedAt: nowIso() };
  const remaining = library.filter((item) => (
    item.id !== lecture.id
    && (!lecture.audioUri || item.audioUri !== lecture.audioUri)
    && (!lecture.audioFilename || item.audioFilename !== lecture.audioFilename)
  ));
  await saveLibrary([next, ...remaining]);
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
    await saveLibrary(library.filter((item) => (
      item.id !== lecture.id
      && (!lecture.audioUri || item.audioUri !== lecture.audioUri)
      && (!lecture.audioFilename || item.audioFilename !== lecture.audioFilename)
    )));
  }
}

export function markAudioPlaybackPoint(lecture, point) {
  if (!['beginning', 'middle', 'end'].includes(point)) return lecture;
  return {
    ...lecture,
    audioPlaybackChecks: { ...defaultPlaybackChecks(), ...(lecture.audioPlaybackChecks || {}), [point]: true },
    updatedAt: nowIso(),
  };
}

export function markAudioVerified(lecture) {
  const checks = { ...defaultPlaybackChecks(), ...(lecture.audioPlaybackChecks || {}) };
  if (!checks.beginning || !checks.middle || !checks.end) {
    throw new Error('Verify playback at the beginning, middle, and end before marking this original audio as clear.');
  }
  return {
    ...lecture,
    audioVerification: 'user-playback-confirmed',
    audioPlaybackChecks: checks,
    recoveryNotice: undefined,
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
    translations: { en: [], ar: [] },
    translationsSourceVersion: null,
    staleDerivedContent: true,
    updatedAt: nowIso(),
  };
}

export function updateTranscriptSegment(lecture, segmentId, text) {
  const nextText = String(text ?? '').trim();
  const existing = lecture.transcript.find((segment) => segment.id === segmentId);
  const currentText = String(existing?.editedText || existing?.originalText || '').trim();
  const transcript = lecture.transcript.map((segment) => segment.id === segmentId ? { ...segment, editedText: nextText, manuallyReviewed: true } : segment);
  if (nextText === currentText) return { ...lecture, transcript, updatedAt: nowIso() };
  return replaceTranscript(lecture, transcript, lecture.transcriptEngine || 'edited');
}
