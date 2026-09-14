import { File } from 'expo-file-system';

const DEFAULT_PORT = 8765;
const PAIR_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 20_000;
const POLL_DELAY_MS = 1_500;
const MIN_UPLOAD_TIMEOUT_MS = 120_000;
const MAX_UPLOAD_TIMEOUT_MS = 30 * 60_000;
const MAX_FOREGROUND_POLL_MS = 10 * 60_000;
const MAX_ENHANCEMENT_POLL_MS = 3 * 60 * 60_000;
const CONSERVATIVE_UPLOAD_BYTES_PER_SECOND = 256 * 1024;

function privateIpv4(hostname) {
  const parts = String(hostname || '').split('.').map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

export function normalizeComputerAddress(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter the Windows helper address shown on your computer.');
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed;
  try { parsed = new URL(candidate); } catch { throw new Error('The computer address is not valid. Example: http://192.168.1.20:8765'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Use an http:// or https:// computer address.');
  if (!privateIpv4(parsed.hostname)) throw new Error('For privacy, LectureAI only sends recordings to a private local IPv4 address on your current Wi-Fi/LAN.');
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Use only the helper base address, without a path, username, query, or fragment.');
  if (!parsed.port) parsed.port = String(DEFAULT_PORT);
  return parsed.toString().replace(/\/$/, '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const timer = setTimeout(stop, timeoutMs);
  options.signal?.addEventListener?.('abort', stop, { once: true });
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (options.signal?.aborted) throw new Error('Transcription was cancelled on this device. Your original recording remains safe.');
    if (error?.name === 'AbortError') throw new Error('The Windows helper did not respond in time. Confirm both devices are on the same Wi-Fi and the helper is running with --lan.');
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', stop);
  }
}

async function responseMessage(response) {
  const text = await response.text().catch(() => '');
  if (!text) return `Windows helper returned HTTP ${response.status}.`;
  try {
    const parsed = JSON.parse(text);
    return parsed.detail || parsed.error || parsed.message || text;
  } catch { return text; }
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function pairWithComputer(address, pairingCode) {
  const baseUrl = normalizeComputerAddress(address);
  const code = String(pairingCode || '').trim().toUpperCase();
  if (!code) throw new Error('Enter the pairing code shown by the Windows helper.');
  const response = await fetchWithTimeout(`${baseUrl}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }, PAIR_TIMEOUT_MS);
  if (!response.ok) throw new Error(await responseMessage(response));
  const payload = await response.json();
  if (!payload?.token) throw new Error('The Windows helper paired but did not return an authorization token.');
  return { baseUrl, token: String(payload.token), expiresAt: Number(payload.expires_at || 0) || null };
}

export async function computerHealth(address, token) {
  const baseUrl = normalizeComputerAddress(address);
  const response = await fetchWithTimeout(`${baseUrl}/health`, { headers: authHeaders(token) }, PAIR_TIMEOUT_MS);
  if (!response.ok) throw new Error(await responseMessage(response));
  const payload = await response.json();
  if (payload?.pairing_required) throw new Error('This device is not paired with the Windows helper. Enter the current pairing code and pair again.');
  if (!payload?.ok) throw new Error('The Windows helper responded but is not ready.');
  return payload;
}

function guessedMime(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'm4a' || ext === 'mp4' || ext === 'aac') return 'audio/mp4';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'ogg') return 'audio/ogg';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'webm') return 'audio/webm';
  return 'application/octet-stream';
}

function contextualGlossary(lecture, supplied) {
  const candidates = [...(Array.isArray(supplied) ? supplied : []), lecture?.title, lecture?.course, lecture?.professor, ...(Array.isArray(lecture?.glossary) ? lecture.glossary : [])];
  const seen = new Set();
  const terms = [];
  for (const candidate of candidates) {
    const value = String(candidate || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120);
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    terms.push(value);
    if (terms.length >= 250) break;
  }
  return terms;
}

function uploadTimeoutMs(sizeBytes) {
  const size = Math.max(0, Number(sizeBytes) || 0);
  if (!size) return MIN_UPLOAD_TIMEOUT_MS;
  const estimatedTransferMs = (size / CONSERVATIVE_UPLOAD_BYTES_PER_SECOND) * 1000;
  return Math.max(MIN_UPLOAD_TIMEOUT_MS, Math.min(MAX_UPLOAD_TIMEOUT_MS, Math.ceil(estimatedTransferMs + 60_000)));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function preservedTranscriptRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => ({
    id: String(row?.id || `segment-${index + 1}`),
    startTime: Math.max(0, Number(row?.start ?? row?.startTime ?? 0) || 0),
    endTime: Math.max(0, Number(row?.end ?? row?.endTime ?? row?.start ?? row?.startTime ?? 0) || 0),
    text: String(row?.text ?? row?.editedText ?? row?.originalText ?? '').trim(),
    language: String(row?.language || ''),
    uncertain: Boolean(row?.uncertain) || /^\s*\[(?:uncertain|inaudible)\]/i.test(String(row?.text || '')),
    speaker: String(row?.speaker || 'Speaker'),
  })).filter((row) => row.text && row.endTime >= row.startTime);
}

function attachDualTranscriptMetadata(lecture, result) {
  if (!lecture || !result) return;
  const sourceTranscript = preservedTranscriptRows(result.source_segments);
  const englishTranscript = preservedTranscriptRows(result.english_segments);
  // Source speech is authoritative. English is a separate convenience view and
  // may be deferred so a second full Whisper pass never blocks source readiness.
  lecture.sourceTranscript = sourceTranscript;
  lecture.englishTranscript = englishTranscript;
  lecture.sourceLanguage = String(result.source_language || result.detected_language || 'unknown');
  lecture.sourceLanguageProbability = result.language_probability ?? null;
  lecture.englishTranscriptMethod = String(result.english_translation || 'unknown');
  lecture.transcriptionAccuracyNote = String(result.accuracy_note || 'Machine transcription should be checked against the original audio when wording matters.');
}

export async function computerJobStatus({ address, token, jobId, signal }) {
  if (!jobId) throw new Error('No Windows transcription job ID was provided.');
  const baseUrl = normalizeComputerAddress(address);
  const response = await fetchWithTimeout(`${baseUrl}/jobs/${encodeURIComponent(jobId)}`, { headers: authHeaders(token), cache: 'no-store', signal });
  if (!response.ok) throw new Error(await responseMessage(response));
  return response.json();
}

export async function resumeComputerJob({ address, token, jobId, signal }) {
  const baseUrl = normalizeComputerAddress(address);
  const response = await fetchWithTimeout(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST', headers: authHeaders(token), signal });
  if (!response.ok) throw new Error(await responseMessage(response));
  return response.json();
}

export async function cancelComputerJob({ address, token, jobId }) {
  const baseUrl = normalizeComputerAddress(address);
  const response = await fetchWithTimeout(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', headers: authHeaders(token) });
  if (!response.ok) throw new Error(await responseMessage(response));
  return response.json();
}

export async function retryCurrentComputerSection({ address, token, jobId, signal }) {
  const baseUrl = normalizeComputerAddress(address);
  const response = await fetchWithTimeout(`${baseUrl}/jobs/${encodeURIComponent(jobId)}/retry-current`, { method: 'POST', headers: authHeaders(token), signal });
  if (!response.ok) throw new Error(await responseMessage(response));
  return response.json();
}

export async function generateEnhancedOnComputer({
  address,
  token,
  lecture,
  cleanupMode = 'balanced',
  onProgress = () => {},
  signal,
}) {
  if (!lecture?.audioUri) throw new Error('This lecture does not have a protected original audio file.');
  if (!token) throw new Error('Pair this iPhone/iPad with the Windows helper first.');
  const baseUrl = normalizeComputerAddress(address);
  const form = new FormData();
  form.append('audio', { uri: lecture.audioUri, name: lecture.audioFilename || 'lecture.m4a', type: guessedMime(lecture.audioFilename) });
  form.append('lectureId', String(lecture.id || 'lecture'));
  form.append('cleanupMode', String(cleanupMode || 'balanced'));
  if (lecture.audioMd5) form.append('audioMd5', String(lecture.audioMd5).toLowerCase());
  onProgress({ progress: 2, message: 'Verifying and sending the protected original to Windows for derived-copy generation…' });
  const response = await fetchWithTimeout(`${baseUrl}/enhancements`, { method: 'POST', headers: authHeaders(token), body: form, signal }, uploadTimeoutMs(lecture.size));
  if (!response.ok) throw new Error(await responseMessage(response));
  const created = await response.json();
  if (!created?.job_id) throw new Error('The Windows helper did not return an enhanced-audio job ID.');
  if (lecture.audioMd5 && created.integrity_checked !== true) {
    throw new Error('Windows did not confirm the protected original upload hash. Enhanced-copy generation was stopped.');
  }
  const jobId = String(created.job_id);
  const deadline = Date.now() + MAX_ENHANCEMENT_POLL_MS;
  for (;;) {
    if (signal?.aborted) throw new Error('Enhanced-copy generation was cancelled. The protected original remains unchanged.');
    if (Date.now() >= deadline) throw new Error('Windows is still generating the enhanced copy. Try again later; the protected original remains unchanged.');
    const statusResponse = await fetchWithTimeout(`${baseUrl}/enhancements/${encodeURIComponent(jobId)}`, { headers: authHeaders(token), cache: 'no-store', signal });
    if (!statusResponse.ok) throw new Error(await responseMessage(statusResponse));
    const job = await statusResponse.json();
    onProgress({ progress: Math.max(2, Math.min(100, Number(job.progress || 0))), message: String(job.message || 'Creating a private enhanced-for-transcription copy…') });
    if (job.status === 'complete' && job.download_ready) return { ...job, job_id: jobId, baseUrl };
    if (job.status === 'failed' || job.status === 'interrupted') throw new Error(job.error || job.message || 'Windows could not generate the enhanced copy.');
    await sleep(POLL_DELAY_MS);
  }
}

export async function downloadEnhancedFromComputer({ address, token, jobId, destination }) {
  const baseUrl = normalizeComputerAddress(address);
  const target = destination instanceof File ? destination : new File(destination);
  if (target.exists) throw new Error('The temporary enhanced download destination already exists and was not overwritten.');
  return File.downloadFileAsync(
    `${baseUrl}/enhancements/${encodeURIComponent(jobId)}/audio`,
    target,
    { headers: authHeaders(token), idempotent: false },
  );
}

export async function releaseComputerEnhancement({ address, token, jobId }) {
  const baseUrl = normalizeComputerAddress(address);
  const response = await fetchWithTimeout(`${baseUrl}/enhancements/${encodeURIComponent(jobId)}/release`, { method: 'POST', headers: authHeaders(token) });
  if (!response.ok && response.status !== 404) throw new Error(await responseMessage(response));
}

export async function transcribeOnComputer({
  address,
  token,
  lecture,
  audioInput = null,
  glossary = [],
  enhancement = 'balanced',
  existingJobId = '',
  resume = false,
  retryCurrent = false,
  onProgress = () => {},
  onJobUpdate = () => {},
  signal,
}) {
  if (!lecture?.audioUri) throw new Error('This lecture does not have an original audio file.');
  if (!token) throw new Error('Pair this iPhone/iPad with the Windows helper first.');
  const baseUrl = normalizeComputerAddress(address);
  let jobId = String(existingJobId || '');
  if (!jobId) {
    const input = audioInput || { uri: lecture.audioUri, filename: lecture.audioFilename, size: lecture.size, md5: lecture.audioMd5, source: 'original' };
    const form = new FormData();
    form.append('audio', { uri: input.uri, name: input.filename || 'lecture.m4a', type: guessedMime(input.filename) });
    form.append('model', 'configured');
    form.append('lectureId', String(lecture.id || 'lecture'));
    form.append('glossary', JSON.stringify(contextualGlossary(lecture, glossary)));
    form.append('enhancement', input.source === 'enhanced' ? 'off' : enhancement);
    if (input.md5) form.append('audioMd5', String(input.md5).toLowerCase());

    onProgress({ progress: 3, message: input.source === 'enhanced' ? 'Sending the verified enhanced copy · transcript timestamps will still reference the protected original…' : input.md5 ? 'Sending the preserved original to your paired Windows computer · transfer checksum will be verified…' : 'Sending the preserved original to your paired Windows computer…' });
    const create = await fetchWithTimeout(`${baseUrl}/jobs`, { method: 'POST', headers: authHeaders(token), body: form, signal }, uploadTimeoutMs(input.size));
    if (!create.ok) throw new Error(await responseMessage(create));
    const created = await create.json();
    if (!created?.job_id) throw new Error('The Windows helper did not return a transcription job ID.');
    if (input.md5 && created.integrity_checked !== true) throw new Error('The Windows helper did not confirm transfer integrity. The phone original is unchanged; retry after updating/restarting the helper.');
    jobId = String(created.job_id);
    await onJobUpdate({ id: jobId, status: created.status || 'queued', progress: 3, message: created.reused ? 'Reconnected to the existing verified Windows job.' : 'Verified upload complete · Windows now owns this transcription job.' });
  } else if (resume || retryCurrent) {
    const resumed = retryCurrent
      ? await retryCurrentComputerSection({ address, token, jobId, signal })
      : await resumeComputerJob({ address, token, jobId, signal });
    await onJobUpdate(resumed);
  }

  const deadline = Date.now() + MAX_FOREGROUND_POLL_MS;
  let lastJob = null;
  for (;;) {
    if (signal?.aborted) throw new Error('Transcription was cancelled on this device. Your original recording remains safe.');
    if (Date.now() >= deadline) {
      return { pending: true, job_id: jobId, job: lastJob, message: 'Windows is still transcribing. You can close LectureAI and reconnect to this saved job later.' };
    }
    await sleep(POLL_DELAY_MS);
    const job = await computerJobStatus({ address: baseUrl, token, jobId, signal });
    lastJob = job;
    await onJobUpdate(job);
    const audioProgress = Number(job.completed_audio_seconds || 0);
    const totalAudio = Number(job.total_audio_seconds || 0);
    const audioLabel = totalAudio > 0 ? ` · ${Math.round(audioProgress)} / ${Math.round(totalAudio)} seconds` : '';
    const runtimeLabel = [job.model, job.device, job.compute_type].filter(Boolean).join(' · ');
    const elapsedLabel = Number.isFinite(Number(job.elapsed_seconds)) ? ` · elapsed ${Math.round(Number(job.elapsed_seconds))}s` : '';
    const showEta = ['queued', 'loading-model', 'transcribing'].includes(job.status);
    const etaLabel = typeof job.eta_seconds === 'number' && Number.isFinite(job.eta_seconds) ? ` · about ${Math.round(job.eta_seconds)}s remaining` : ' · Estimating remaining time…';
    onProgress({ progress: Math.max(3, Math.min(100, Number(job.progress || 0))), message: `${String(job.message || 'Transcribing locally on your Windows computer…')}${audioLabel}${elapsedLabel}${showEta ? etaLabel : ''}${runtimeLabel ? ` · ${runtimeLabel}` : ''}` });
    if (job.status === 'complete') {
      if (!job.result?.segments) throw new Error('The Windows helper finished but returned no transcript segments.');
      attachDualTranscriptMetadata(lecture, job.result);
      return { ...job.result, job_id: jobId };
    }
    if (job.status === 'interrupted' || job.status === 'stalled' || job.status === 'cancelled') {
      return { pending: true, job_id: jobId, job, message: job.message };
    }
    if (job.status === 'failed') {
      const error = new Error(job.error || 'Windows transcription failed. Completed sections remain checkpointed.');
      error.job = job;
      throw error;
    }
  }
}
