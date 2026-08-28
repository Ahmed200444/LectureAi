export type DeviceKind = 'iphone' | 'ipad' | 'android-phone' | 'android-tablet' | 'windows' | 'mac' | 'other';

export function detectDeviceKind(): DeviceKind {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const touchMac = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  if (/iPad/i.test(ua) || touchMac) return 'ipad';
  if (/iPhone|iPod/i.test(ua)) return 'iphone';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'android-phone' : 'android-tablet';
  if (/Windows NT/i.test(ua) || /^Win/i.test(platform)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua) || /^Mac/i.test(platform)) return 'mac';
  return 'other';
}

export function isIOSDevice() {
  const kind = detectDeviceKind();
  return kind === 'iphone' || kind === 'ipad';
}

export function isPhoneOrTabletDevice() {
  return ['iphone', 'ipad', 'android-phone', 'android-tablet'].includes(detectDeviceKind());
}

export function deviceLabel() {
  const kind = detectDeviceKind();
  return ({
    iphone: 'iPhone',
    ipad: 'iPad',
    'android-phone': 'Android phone',
    'android-tablet': 'Android tablet',
    windows: 'Windows laptop/desktop',
    mac: 'Mac',
    other: 'this device',
  } as Record<DeviceKind, string>)[kind];
}

/**
 * Safari is more reliable when we ask for the default iOS microphone without
 * requiring optional processing constraints. Other browsers can still receive
 * speech-oriented ideal constraints without making them mandatory.
 */
export function microphoneCaptureConstraints(): MediaStreamConstraints {
  if (isIOSDevice()) return { audio: true, video: false };
  return {
    audio: {
      echoCancellation: { ideal: false },
      noiseSuppression: { ideal: false },
      autoGainControl: { ideal: true },
      channelCount: { ideal: 1 },
    },
    video: false,
  };
}

export function recordingMimeCandidates() {
  const ios = isIOSDevice();
  return ios
    ? ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm']
    : ['audio/webm;codecs=opus', 'audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm'];
}

export function preferredRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return recordingMimeCandidates().find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

/** Avoid optional bitrate options on iOS Safari, where the platform encoder
 * should choose a native AAC configuration. */
export function mediaRecorderOptions(mimeType: string): MediaRecorderOptions | undefined {
  const options: MediaRecorderOptions = {};
  if (mimeType) options.mimeType = mimeType;
  if (!isIOSDevice()) options.audioBitsPerSecond = 128_000;
  return Object.keys(options).length ? options : undefined;
}

export function normalizeAudioMimeType(mimeType = '', filename = '') {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith('audio/') && lower !== 'audio/octet-stream') return mimeType;
  const name = filename.toLowerCase();
  if (/\.(m4a|mp4|aac)$/.test(name)) return 'audio/mp4';
  if (/\.webm$/.test(name)) return 'audio/webm';
  if (/\.wav$/.test(name)) return 'audio/wav';
  if (/\.mp3$/.test(name)) return 'audio/mpeg';
  if (/\.ogg$/.test(name)) return 'audio/ogg';
  if (/\.flac$/.test(name)) return 'audio/flac';
  return mimeType || 'application/octet-stream';
}

export function audioFileExtension(mimeType = '', filename = '') {
  const normalized = normalizeAudioMimeType(mimeType, filename).toLowerCase();
  if (normalized.includes('mp4') || normalized.includes('aac')) return 'm4a';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('mpeg')) return 'mp3';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('flac')) return 'flac';
  return 'webm';
}
