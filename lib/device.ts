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

export function isStandaloneApp() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const iosStandalone = Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
  const displayModeStandalone = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  return iosStandalone || displayModeStandalone;
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
 * Lecture capture favors a faithful source recording over call-style processing.
 * iOS/iPadOS may ignore unsupported preferences, so every field is a preference,
 * not a hard requirement that would make microphone access fail.
 */
export function lectureAudioConstraints(): MediaTrackConstraints {
  return {
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false },
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
  };
}

/**
 * After permission is granted, make one best-effort attempt to disable call-style
 * processing on the real microphone track. This helps avoid pumping/whooshing
 * artifacts without making recording fail on Safari builds that ignore a control.
 */
export async function applyLectureAudioPreferences(track: MediaStreamTrack) {
  const supported = navigator.mediaDevices?.getSupportedConstraints?.() || {};
  const preferred: MediaTrackConstraints = {};
  if (supported.echoCancellation) preferred.echoCancellation = false;
  if (supported.noiseSuppression) preferred.noiseSuppression = false;
  if (supported.autoGainControl) preferred.autoGainControl = false;
  if (supported.channelCount) preferred.channelCount = { ideal: 1 };
  if (supported.sampleRate) preferred.sampleRate = { ideal: 48_000 };

  if (Object.keys(preferred).length) {
    try {
      await track.applyConstraints(preferred);
    } catch {
      try { await track.applyConstraints(lectureAudioConstraints()); } catch { /* Best effort only. */ }
    }
  }
  return track.getSettings?.() || {};
}

export function recordingMimeCandidates() {
  const ios = isIOSDevice();
  return ios
    ? ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    : ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'];
}

export function recordingFileExtension(mimeType: string) {
  const type = (mimeType || '').toLowerCase();
  if (type.includes('mp4') || type.includes('m4a')) return 'm4a';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('aac')) return 'aac';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('flac')) return 'flac';
  if (type.includes('webm')) return 'webm';
  return 'audio';
}

export function preferredRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return recordingMimeCandidates().find((type) => MediaRecorder.isTypeSupported(type)) || '';
}
