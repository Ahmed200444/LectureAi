export const LECTURE_TITLE_METADATA_VERSION = 1;
export const MAX_LECTURE_TITLE_LENGTH = 180;

function compactTitleText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LECTURE_TITLE_LENGTH);
}

export function untitledLectureTitle(createdAt = new Date()) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return 'Untitled Lecture';
  try {
    const stamp = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
    return `Untitled Lecture - ${stamp}`;
  } catch {
    return 'Untitled Lecture';
  }
}

export function lectureDisplayTitle(value, createdAt) {
  return compactTitleText(value) || untitledLectureTitle(createdAt);
}

export function requireLectureTitle(value) {
  const title = compactTitleText(value);
  if (!title) throw new Error('Lecture Name cannot be blank. Enter a name or cancel to keep the current title.');
  return title;
}

export function migrateLectureMetadata(lecture) {
  if (!lecture || typeof lecture !== 'object') return lecture;
  const title = lectureDisplayTitle(lecture.title ?? lecture.lectureName ?? lecture.name, lecture.createdAt);
  if (lecture.title === title && Number(lecture.lectureTitleMetadataVersion) === LECTURE_TITLE_METADATA_VERSION) return lecture;
  return {
    ...lecture,
    title,
    lectureTitleMetadataVersion: LECTURE_TITLE_METADATA_VERSION,
  };
}

export function renameLectureTitle(lecture, requestedTitle, changedAt = new Date().toISOString()) {
  if (!lecture || typeof lecture !== 'object') throw new Error('No lecture was selected.');
  const title = requireLectureTitle(requestedTitle);
  if (title === lectureDisplayTitle(lecture.title, lecture.createdAt)) return migrateLectureMetadata(lecture);
  // Deliberately spread the existing row and change metadata only. Audio identity,
  // hashes, transcript timestamps, enhanced copies and Windows job IDs are retained.
  return {
    ...lecture,
    title,
    lectureTitleMetadataVersion: LECTURE_TITLE_METADATA_VERSION,
    titleUpdatedAt: changedAt,
    updatedAt: changedAt,
  };
}

export function safeFilenameStem(value, fallback = 'Lecture') {
  const normalizedFallback = compactTitleText(fallback) || 'Lecture';
  const cleaned = (compactTitleText(value) || normalizedFallback)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/g, '');
  if (!cleaned) return 'Lecture';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned) ? `Lecture-${cleaned}` : cleaned;
}

export function lectureExportFilename(title, label, extension) {
  const suffix = safeFilenameStem(label, 'Export');
  const ext = String(extension || '').replace(/^\.+/, '').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'txt';
  return `${safeFilenameStem(title)} ${suffix}.${ext}`;
}
