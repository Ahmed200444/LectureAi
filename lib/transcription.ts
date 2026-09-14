import { generateNotesHtml } from './notes.ts';
import { boundTranscriptToAudioDuration, normalizeTranscript } from './transcript.ts';
import type { Course, Lecture } from './types.ts';
import { detectDeviceKind, isPhoneOrTabletDevice, recordingFileExtension } from './device.ts';

const HELPER_URL = 'http://127.0.0.1:8765';

export type TranscriptionProgress = {
  progress: number;
  message: string;
};

export type CleanupMode = 'off' | 'balanced' | 'strong';

type FetchLike = typeof fetch;

type HelperJob = {
  id: string;
  status: 'queued' | 'loading-model' | 'transcribing' | 'stalled' | 'interrupted' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  result?: unknown;
  error?: string;
  completed_audio_seconds?: number;
  total_audio_seconds?: number;
  resume_available?: boolean;
  stage?: string;
  elapsed_seconds?: number;
  eta_seconds?: number;
  model?: string;
  device?: string;
  compute_type?: string;
};

const MAX_FOREGROUND_POLL_MS = 10 * 60_000;

function audioFilename(mimeType: string) {
  return `lecture.${recordingFileExtension(mimeType)}`;
}

function isNonWindowsBrowser() {
  return typeof navigator !== 'undefined' && detectDeviceKind() !== 'windows';
}

function makeForm(lecture: Lecture, course: Course | undefined, audio: Blob, model = 'configured', enhancement: CleanupMode = 'balanced') {
  const form = new FormData();
  const glossary = [
    lecture.title,
    course?.name,
    course?.code,
    course?.professor,
    ...(course?.glossary || []),
  ].map((value) => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120))
    .filter(Boolean)
    .filter((value, index, values) => values.findIndex((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase()) === index)
    .slice(0, 250);
  form.append('audio', audio, audioFilename(audio.type || lecture.mimeType || 'audio/webm'));
  form.append('lectureId', lecture.id);
  form.append('glossary', JSON.stringify(glossary));
  form.append('model', model);
  form.append('enhancement', enhancement);
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
  options: { existingJobId?: string; resume?: boolean; retryCurrent?: boolean; onJobUpdate?: (job: HelperJob) => Promise<void> | void; enhancement?: CleanupMode; signal?: AbortSignal } = {},
) {
  if (fetcher === fetch && isNonWindowsBrowser()) throw new Error('The Windows transcription helper can only be contacted from the Windows computer running LectureAI.');
  let jobId = String(options.existingJobId || '');
  let jobResponse: Response | null = null;
  if (!jobId) {
    onProgress({ progress: 8, message: 'Sending the saved recording to the private Windows transcription helper…' });
    jobResponse = await fetcher(`${HELPER_URL}/jobs`, { method: 'POST', body: makeForm(lecture, course, audio, 'configured', options.enhancement || 'balanced'), signal: options.signal });
  }

  // Older installed helpers remain compatible while users update the local package.
  // Use the helper's configured/recommended model rather than exposing a separate
  // "Maximum Accuracy" mode or forcing a particular model from the web app.
  if (jobResponse && (jobResponse.status === 404 || jobResponse.status === 405)) {
    onProgress({ progress: 18, message: 'Transcribing locally on this computer…' });
    const response = await fetcher(`${HELPER_URL}/transcribe`, { method: 'POST', body: makeForm(lecture, course, audio, 'configured'), signal: options.signal });
    if (!response.ok) throw new Error(await responseError(response) || 'The local transcription helper returned an error.');
    return response.json();
  }

  if (jobResponse) {
    if (!jobResponse.ok) throw new Error(await responseError(jobResponse) || 'Could not create a local transcription job.');
    const created = await jobResponse.json() as { job_id?: string; status?: HelperJob['status'] };
    if (!created.job_id) throw new Error('The local helper did not return a transcription job ID.');
    jobId = created.job_id;
    await options.onJobUpdate?.({ id: jobId, status: created.status || 'queued', progress: 8, message: 'Verified upload complete · Windows owns this saved job.' });
  } else if (options.resume || options.retryCurrent) {
    const action = options.retryCurrent ? 'retry-current' : 'resume';
    const resumed = await fetcher(`${HELPER_URL}/jobs/${encodeURIComponent(jobId)}/${action}`, { method: 'POST', cache: 'no-store', signal: options.signal });
    if (!resumed.ok) throw new Error(await responseError(resumed) || 'Could not resume the retained Windows job.');
    await options.onJobUpdate?.(await resumed.json() as HelperJob);
  }

  const deadline = Date.now() + MAX_FOREGROUND_POLL_MS;
  let lastJob: HelperJob | undefined;
  for (;;) {
    if (options.signal?.aborted) throw new DOMException('Transcription polling cancelled.', 'AbortError');
    await wait(700);
    const response = await fetcher(`${HELPER_URL}/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store', signal: options.signal });
    if (!response.ok) throw new Error(await responseError(response) || 'Could not read local transcription progress.');
    const job = await response.json() as HelperJob;
    lastJob = job;
    await options.onJobUpdate?.(job);
    const audioLabel = job.total_audio_seconds ? ` · ${Math.round(job.completed_audio_seconds || 0)} / ${Math.round(job.total_audio_seconds)} seconds` : '';
    const runtimeLabel = [job.model, job.device, job.compute_type].filter(Boolean).join(' · ');
    const elapsedLabel = Number.isFinite(job.elapsed_seconds) ? ` · elapsed ${Math.round(job.elapsed_seconds || 0)}s` : '';
    const showEta = ['queued', 'loading-model', 'transcribing'].includes(job.status);
    const etaLabel = Number.isFinite(job.eta_seconds) ? ` · about ${Math.round(job.eta_seconds || 0)}s remaining` : ' · Estimating remaining time…';
    onProgress({ progress: Math.max(8, Math.min(100, job.progress)), message: `${job.message || 'Transcribing lecture locally…'}${audioLabel}${elapsedLabel}${showEta ? etaLabel : ''}${runtimeLabel ? ` · ${runtimeLabel}` : ''}` });
    if (job.status === 'complete') return job.result;
    if (job.status === 'failed') throw new Error(job.error || 'Local transcription failed. Completed sections remain checkpointed.');
    if (job.status === 'interrupted' || job.status === 'stalled' || job.status === 'cancelled' || Date.now() >= deadline) {
      return { pending: true, job_id: jobId, job: lastJob, message: job.message || 'Windows retains this job; reconnect later.' };
    }
  }
}

export async function cancelWindowsHelperJob(jobId: string, fetcher: FetchLike = fetch) {
  const response = await fetcher(`${HELPER_URL}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', cache: 'no-store' });
  if (!response.ok) throw new Error(await responseError(response) || 'Could not cancel the Windows transcription job safely.');
  return response.json() as Promise<HelperJob>;
}

export async function retryCurrentWindowsSection(jobId: string, fetcher: FetchLike = fetch) {
  const response = await fetcher(`${HELPER_URL}/jobs/${encodeURIComponent(jobId)}/retry-current`, { method: 'POST', cache: 'no-store' });
  if (!response.ok) throw new Error(await responseError(response) || 'Could not retry the unfinished Windows section.');
  return response.json() as Promise<HelperJob>;
}

export function completeTranscription(lecture: Lecture, payload: unknown, engine: 'windows' | 'phone' | 'import', model: string, options: { generateNotes?: boolean } = {}) {
  const payloadRecord = (payload && typeof payload === 'object' ? payload : {}) as {
    model?: unknown;
    englishTranslation?: unknown;
    arabicTranslation?: unknown;
    translationWarnings?: unknown;
  };
  const normalizedSegments = normalizeTranscript(payload, lecture.id);
  const segments = boundTranscriptToAudioDuration(normalizedSegments, lecture.duration);
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
  const correctedSegments = lecture.segments.filter((segment) => (
    segment.manuallyReviewed
    || segment.editedText.trim() !== segment.originalText.trim()
  ));
  const transcriptCorrectionHistory = correctedSegments.length
    ? [
        ...(lecture.transcriptCorrectionHistory || []),
        {
          transcriptVersion: Number(lecture.transcriptVersion || 0),
          archivedAt: new Date().toISOString(),
          engine: lecture.transcriptionEngine,
          segments: correctedSegments,
        },
      ]
    : (lecture.transcriptCorrectionHistory || []);

  const withTranscript: Lecture = {
    ...lecture,
    segments,
    rawTranscript: segments.map((segment) => ({ ...segment })),
    transcriptState: engine === 'import' ? 'imported' : 'raw-machine',
    transcriptGeneratedAt: new Date().toISOString(),
    transcriptCorrectionHistory,
    phoneTranscriptionCheckpoint: undefined,
    englishTranslation,
    arabicTranslation,
    transcriptVersion,
    translationSourceVersion: englishTranslation.length || arabicTranslation.length ? transcriptVersion : undefined,
    derivedContentStale: Boolean(lecture.notesCurrent.trim()),
    // Playback-verified media duration is authoritative. Transcript timestamps are
    // bounded to it above; only transcript-only imports may supply a fallback.
    duration: lecture.duration > 0 ? lecture.duration : (segments.at(-1)?.endTime || 0),
    status: options.generateNotes === false ? 'done' : 'generating-notes',
    statusMessage: options.generateNotes === false ? `SOURCE TRANSCRIPT READY · ${segments.length} timestamped segment${segments.length === 1 ? '' : 's'} persisted` : 'Transcript complete · generating editable lecture notes',
    processingProgress: options.generateNotes === false ? 93 : 94,
    transcriptionEngine: engine,
    transcriptionModel: actualModel,
  };
  const translationStatus = englishTranslation.length || arabicTranslation.length
    ? ` · English/Arabic views ${translationWarnings.length ? 'partially ready' : 'ready'}`
    : '';
  if (options.generateNotes === false) return { ...withTranscript, updatedAt: new Date().toISOString() };
  return completeTranscriptNotes(withTranscript, translationStatus);
}

export function completeTranscriptNotes(lecture: Lecture, translationStatus = ''): Lecture {
  const notes = generateNotesHtml(lecture);
  const transcriptVersion = Number(lecture.transcriptVersion || 0);
  const preservedNotes = lecture.notesCurrent.trim()
    ? [{ id: crypto.randomUUID(), html: lecture.notesCurrent, createdAt: new Date().toISOString(), label: 'Preserved before transcript replacement' }]
    : [];
  return {
    ...lecture,
    notesOriginal: notes,
    notesCurrent: notes,
    notesSourceVersion: transcriptVersion,
    derivedContentStale: false,
    noteVersions: [...lecture.noteVersions, ...preservedNotes, { id: crypto.randomUUID(), html: notes, createdAt: new Date().toISOString(), label: 'Original generated notes' }],
    status: 'done' as const,
    statusMessage: `${lecture.segments.length} timestamped segment${lecture.segments.length === 1 ? '' : 's'} ready${translationStatus} · editable notes generated · model: ${lecture.transcriptionModel || 'configured'}`,
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
