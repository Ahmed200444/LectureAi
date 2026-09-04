import { Directory, File, Paths } from 'expo-file-system';
import { createLecture, preserveAudioFile, upsertLecture } from './storage';

const JOURNAL_FILENAME = 'active-recording.json';
const MIN_RECOVERABLE_BYTES = 1024;

function rootDirectory() {
  const root = new Directory(Paths.document, 'LectureAI');
  if (!root.exists) root.create();
  return root;
}

function journalFile() {
  return new File(rootDirectory(), JOURNAL_FILENAME);
}

function safeJournalValue(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

export function readActiveRecordingJournal() {
  try {
    const file = journalFile();
    if (!file.exists || !file.size) return null;
    const parsed = JSON.parse(file.textSync());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveActiveRecordingJournal(snapshot) {
  try {
    const file = journalFile();
    if (!file.exists) file.create();
    file.write(JSON.stringify({
      version: 1,
      title: String(snapshot?.title || 'Recovered lecture').slice(0, 120),
      startedAt: snapshot?.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sourceUri: snapshot?.sourceUri || null,
      durationMs: Math.max(0, Math.round(Number(snapshot?.durationMs || 0))),
      marks: Array.isArray(snapshot?.marks) ? safeJournalValue(snapshot.marks).slice(0, 1000) : [],
      state: snapshot?.state || 'recording',
    }));
    return true;
  } catch {
    // The native recorder remains authoritative. A journal failure must never stop
    // the microphone session or imply that audio was lost.
    return false;
  }
}

export function clearActiveRecordingJournal() {
  try {
    const file = journalFile();
    if (file.exists) file.delete();
  } catch {
    // Best effort. A stale journal is handled safely on the next launch.
  }
}

export async function recoverInterruptedRecording() {
  const journal = readActiveRecordingJournal();
  if (!journal) return { recovered: false, reason: 'none' };

  const sourceUri = String(journal.sourceUri || '').trim();
  if (!sourceUri) {
    clearActiveRecordingJournal();
    return {
      recovered: false,
      reason: 'no-file-url',
      message: 'LectureAI found an interrupted recording journal, but Expo did not expose a recoverable file URL before the interruption.',
    };
  }

  try {
    const source = new File(sourceUri);
    if (!source.exists || source.size < MIN_RECOVERABLE_BYTES) {
      clearActiveRecordingJournal();
      return {
        recovered: false,
        reason: 'file-missing',
        message: 'LectureAI found an interrupted recording journal, but the temporary recorder file was no longer available.',
      };
    }

    const id = `recovered-${Date.now().toString(36)}`;
    const title = `${String(journal.title || 'Lecture').trim() || 'Lecture'} (recovered)`;
    const preserved = await preserveAudioFile(sourceUri, id, title, 'm4a');
    let lecture = createLecture({
      id,
      title,
      audio: preserved,
      durationMs: journal.durationMs || 0,
      marks: journal.marks || [],
      source: 'interrupted-recorder-recovery',
    });
    lecture = {
      ...lecture,
      recoveryNotice: 'LectureAI recovered a file left by an interrupted Expo recording session. The container may not have finalized normally, so listen to the beginning, middle, and end before trusting it.',
    };
    await upsertLecture(lecture);
    clearActiveRecordingJournal();
    return { recovered: true, lecture };
  } catch (error) {
    // Keep the journal when preservation itself failed. That gives a later launch
    // another chance instead of discarding the only pointer to a possible file.
    return {
      recovered: false,
      reason: 'copy-failed',
      message: error instanceof Error ? error.message : 'LectureAI could not preserve the interrupted recorder file yet.',
    };
  }
}
