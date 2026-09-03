const DEFAULT_PORT = 8765;
const PAIR_TIMEOUT_MS = 8_000;
const REQUEST_TIMEOUT_MS = 20_000;
const POLL_DELAY_MS = 900;
const MIN_UPLOAD_TIMEOUT_MS = 120_000;
const MAX_UPLOAD_TIMEOUT_MS = 30 * 60_000;
const CONSERVATIVE_UPLOAD_BYTES_PER_SECOND = 256 * 1024;

function privateIpv4(hostname) {
  const parts = String(hostname || '').split('.').map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

export function normalizeComputerAddress(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Enter the Windows helper address shown on your computer.');
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('The computer address is not valid. Example: http://192.168.1.20:8765');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Use an http:// or https:// computer address.');
  if (!privateIpv4(parsed.hostname)) throw new Error('For privacy, LectureAI only sends recordings to a private local IPv4 address on your current Wi-Fi/LAN.');
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Use only the helper base address, without a path, username, query, or fragment.');
  if (!parsed.port) parsed.port = String(DEFAULT_PORT);
  return parsed.toString().replace(/\/$/, '');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('The Windows helper did not respond in time. Confirm both devices are on the same Wi-Fi and the helper is running with --lan.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function responseMessage(response) {
  const text = await response.text().catch(() => '');
  if (!text) return `Windows helper returned HTTP ${response.status}.`;
  try {
    const parsed = JSON.parse(text);
    return parsed.detail || parsed.error || parsed.message || text;
  } catch {
    return text;
  }
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function pairWithComputer(address, pairingCode) {
  const baseUrl = normalizeComputerAddress(address);
  const code = String(pairingCode || '').trim().toUpperCase();
  if (!code) throw new Error('Enter the pairing code shown by the Windows helper.');
  const response = await fetchWithTimeout(`${baseUrl}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  }, PAIR_TIMEOUT_MS);
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
  const candidates = [
    ...(Array.isArray(supplied) ? supplied : []),
    lecture?.title,
    lecture?.course,
    ...(Array.isArray(lecture?.glossary) ? lecture.glossary : []),
  ];
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
  // A two-hour lecture can be hundreds of MB. Give slow private Wi-Fi enough time
  // instead of aborting a healthy transfer at a fixed two-minute deadline.
  const estimatedTransferMs = (size / CONSERVATIVE_UPLOAD_BYTES_PER_SECOND) * 1000;
  return Math.max(
    MIN_UPLOAD_TIMEOUT_MS,
    Math.min(MAX_UPLOAD_TIMEOUT_MS, Math.ceil(estimatedTransferMs + 60_000)),
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function transcribeOnComputer({ address, token, lecture, glossary = [], onProgress = () => {} }) {
  if (!lecture?.audioUri) throw new Error('This lecture does not have an original audio file.');
  if (!token) throw new Error('Pair this iPhone/iPad with the Windows helper first.');
  const baseUrl = normalizeComputerAddress(address);
  const form = new FormData();
  form.append('audio', {
    uri: lecture.audioUri,
    name: lecture.audioFilename || 'lecture.m4a',
    type: guessedMime(lecture.audioFilename),
  });
  form.append('model', 'configured');
  form.append('lectureId', String(lecture.id || 'lecture'));
  form.append('glossary', JSON.stringify(contextualGlossary(lecture, glossary)));
  if (lecture.audioMd5) form.append('audioMd5', String(lecture.audioMd5).toLowerCase());

  onProgress({ progress: 3, message: lecture.audioMd5 ? 'Sending the preserved original to your paired Windows computer · transfer checksum will be verified…' : 'Sending the preserved original to your paired Windows computer…' });
  const create = await fetchWithTimeout(`${baseUrl}/jobs`, {
    method: 'POST',
    headers: authHeaders(token),
    body: form,
  }, uploadTimeoutMs(lecture.size));
  if (!create.ok) throw new Error(await responseMessage(create));
  const created = await create.json();
  if (!created?.job_id) throw new Error('The Windows helper did not return a transcription job ID.');
  if (lecture.audioMd5 && created.integrity_checked !== true) throw new Error('The Windows helper did not confirm transfer integrity. The phone original is unchanged; retry after updating/restarting the helper.');

  for (;;) {
    await sleep(POLL_DELAY_MS);
    const response = await fetchWithTimeout(`${baseUrl}/jobs/${encodeURIComponent(created.job_id)}`, {
      headers: authHeaders(token),
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(await responseMessage(response));
    const job = await response.json();
    onProgress({
      progress: Math.max(3, Math.min(100, Number(job.progress || 0))),
      message: String(job.message || 'Transcribing locally on your Windows computer…'),
    });
    if (job.status === 'complete') {
      if (!job.result?.segments) throw new Error('The Windows helper finished but returned no transcript segments.');
      return job.result;
    }
    if (job.status === 'failed') throw new Error(job.error || 'Windows transcription failed.');
  }
}
