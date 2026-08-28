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

export function recordingMimeCandidates() {
  const ios = isIOSDevice();
  return ios
    ? ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
    : ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm'];
}

export function preferredRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return recordingMimeCandidates().find((type) => MediaRecorder.isTypeSupported(type)) || '';
}
