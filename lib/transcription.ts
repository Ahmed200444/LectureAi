import { generateNotesHtml } from './notes.ts';
import { normalizeTranscript } from './transcript.ts';
import type { Course, Lecture } from './types.ts';
import { detectDeviceKind, isPhoneOrTabletDevice, recordingFileExtension } from './device.ts';

const HELPER_URL = 'http://127.0.0.1:8765';

export type TranscriptionProgress = {
  progress: number;
  message: string;
};

type FetchLike = typeof fetch;

type HelperJob = {
  id: string;
  status: 'queued' | 'loading-model' | 'transcribing' | 'complete' | 'failed';
  progress: number;
  message: string;
  result?: unknown;
  error?: string;
};

function audioFilename(mimeType: string) {
  return `lecture.${recordingFileExtension(mimeType)}`;
}

function isNonWindowsBrowser() {
  return typeof navigator !== 'undefined' && detectDeviceKind() !== 'windows';
}

function makeForm(lecture: Lecture, course: Course | undefined, audio: Blob, model = 'configured') {
  const form = new FormData();
  form.append('audio', audio, audioFilename(audio.type || lecture.mimeType || 'audio/webm'));
  form.append('lectureId', lecture.id);
  form.append('glossary', JSON.stringify(course?.glossary || []));
  form.append('model', model);
  return form;
}

async function responseError(response: Response) {
  const text = (await response.text()).trim();
  try {
    const parsed = JSON.parse(text) as { detail?: string };
    return parsed.detail || text;
  } catch {
    return text;
  }
}

export async function windowsHelperHealth(fetcher: FetchLike = fetch, timeoutMs = 1800) {
  if (isNonWindowsBrowser()) return { available: false as const, error: 'Windows helper is only available on Windows; loopback was not contacted.' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${HELPER_URL}/health`, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) return { available: false as const, error: `Helper returned HTTP ${response.status}` };
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    return { available: true as const, payload };
  } catch (error) {
    return { available: false as const, error: error instanceof Error ? error.message : 'Helper connection failed' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function windowsHelperAvailable(fetcher: FetchLike = fetch, timeoutMs = 1800) {
  return (await windowsHelperHealth(fetcher, timeoutMs)).available;
}

export async function transcribeWithWindowsHelper(
  lecture: Lecture,
  course: Course | undefined,
  audio: Blob,
  onProgress: (update: TranscriptionProgress) => void,
  fetcher: FetchLike = fetch,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  if (fetcher === fetch && isNonWindowsBrowser()) throw new Error('The Windows transcription helper can only be contacted from the Windows computer running LectureAI.');
  onProgress({ progress: 8, message: 'Sending the saved recording to the private Windows transcription helper…' });
  const jobResponse = await fetcher(`${HELPER_URL}/jobs`, { method: 'POST', body: makeForm(lecture, course, audio) });

  // Older installed helpers remain compatible while users update the local package.
  // Use the helper's configured/recommended model rather than exposing a separate
  // "Maximum Accuracy" mode or forcing a particular model from the web app.
  if (jobResponse.status === 404 || jobResponse.status === 405) {
    onProgress({ progress: 18, message: 'Transcribing locally on this computer…' });
    const response = await fetcher(`${HELPER_URL}/transcribe`, { method: 'POST', body: makeForm(lecture, course, audio, 'configured') });
    if (!response.ok) throw new Error(await responseError(response) || 'The local transcription helper returned an error.');
    return response.json();
  }

  if (!jobResponse.ok) throw new Error(await responseError(jobResponse) || 'Could not create a local transcription job.');
  const created = await jobResponse.json() as { job_id?: string };
  if (!created.job_id) throw new Error('The local helper did not return a transcription job ID.');

  for (;;) {
    await wait(700);
    const response = await fetcher(`${HELPER_URL}/jobs/${encodeURIComponent(created.job_id)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await responseError(response) || 'Could not read local transcription progress.');
    const job = await response.json() as HelperJob;
    onProgress({ progress: Math.max(8, Math.min(90, job.progress)), message: job.message || 'Transcribing lecture locally…' });
    if (job.status === 'complete') return job.result;
    if (job.status === 'failed') throw new Error(job.error || 'Local transcription failed.');
  }
}

export function completeTranscription(lecture: Lecture, payload: unknown, engine: 'windows' | 'phone' | 'import', model: string) {
  const payloadRecord = (payload && typeof payload === 'object' ? payload : {}) as {
    model?: unknown;
    englishTranslation?: unknown;
    arabicTranslation?: unknown;
    translationWarnings?: unknown;
  };
  const segments = normalizeTranscript(payload, lecture.id);
  const actualModel = String(payloadRecord.model || model);
  if (!segments.length) throw new Error('No speech was detected in this recording. Check the audio and try again.');

  const normalizeOptionalTranslation = (value: unknown) => Array.isArray(value) && value.length
    ? normalizeTranscript({ segments: value }, lecture.id)
    : [];
  const englishTranslation = normalizeOptionalTranslation(payloadRecord.englishTranslation);
  const arabicTranslation = normalizeOptionalTranslation(payloadRecord.arabicTranslation);
  const translationWarnings = Array.isArray(payloadRecord.translationWarnings)
    ? payloadRecord.translationWarnings.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    : [];
  const transcriptVersion = Number(lecture.transcriptVersion || 0) + 1;

  const withTranscript: Lecture = {
    ...lecture,
    segments,
    englishTranslation,
    arabicTranslation,
    transcriptVersion,
    translationSourceVersion: englishTranslation.length || arabicTranslation.length ? transcriptVersion : undefined,
    derivedContentStale: false,
    duration: Math.max(lecture.duration, segments.at(-1)?.endTime || 0),
    status: 'generating-notes',
    statusMessage: 'Transcript complete · generating editable lecture notes',
    processingProgress: 94,
    transcriptionEngine: engine,
    transcriptionModel: actualModel,
  };
  const notes = generateNotesHtml(withTranscript);
  const translationStatus = englishTranslation.length || arabicTranslation.length
    ? ` · English/Arabic views ${translationWarnings.length ? 'partially ready' : 'ready'}`
    : '';
  return {
    ...withTranscript,
    notesOriginal: notes,
    notesCurrent: notes,
    notesSourceVersion: transcriptVersion,
    derivedContentStale: false,
    noteVersions: [...withTranscript.noteVersions, { id: crypto.randomUUID(), html: notes, createdAt: new Date().toISOString(), label: 'Original generated notes' }],
    status: 'done' as const,
    statusMessage: `${segments.length} timestamped segment${segments.length === 1 ? '' : 's'} ready${translationStatus} · editable notes generated · model: ${actualModel}`,
    processingProgress: 100,
    updatedAt: new Date().toISOString(),
  };
}

export function phoneTranscriptionSupported() {
  return typeof window !== 'undefined'
    && typeof Worker !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && typeof (window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) !== 'undefined';
}

export function isPhoneOrTablet() {
  return isPhoneOrTabletDevice();
}
