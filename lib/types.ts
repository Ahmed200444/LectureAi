export type ProcessingStatus =
  | 'recording'
  | 'interrupted'
  | 'saved'
  | 'transcription-queued'
  | 'needs-transcription'
  | 'preparing'
  | 'transcribing'
  | 'checking'
  | 'generating-notes'
  | 'done'
  | 'failed';

export interface Course {
  id: string;
  name: string;
  code: string;
  professor: string;
  semester: string;
  description: string;
  glossary: string[];
  color: string;
  icon: string;
  createdAt: string;
}

export interface TranscriptSegment {
  id: string;
  lectureId: string;
  startTime: number;
  endTime: number;
  originalText: string;
  editedText: string;
  detectedLanguage: 'en' | 'ar' | 'mixed' | 'unknown';
  confidence?: number;
  manuallyReviewed: boolean;
  speaker?: string;
}

export interface Bookmark {
  id: string;
  time: number;
  label: string;
}

export interface NoteVersion {
  id: string;
  html: string;
  createdAt: string;
  label: string;
}

export interface AttachmentMeta {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface Lecture {
  id: string;
  courseId: string;
  title: string;
  date: string;
  duration: number;
  size: number;
  mimeType?: string;
  status: ProcessingStatus;
  statusMessage?: string;
  processingProgress?: number;
  transcriptionEngine?: 'windows' | 'phone' | 'import';
  transcriptionModel?: string;
  /** Increments whenever the source transcript text is replaced or corrected. */
  transcriptVersion?: number;
  /** Transcript version used to build the currently stored translation view(s). */
  translationSourceVersion?: number;
  /** Transcript version used to build the current generated notes. */
  notesSourceVersion?: number;
  /** True when transcript corrections make generated notes/derived views stale. */
  derivedContentStale?: boolean;
  segments: TranscriptSegment[];
  englishTranslation: TranscriptSegment[];
  arabicTranslation: TranscriptSegment[];
  bookmarks: Bookmark[];
  attachments: AttachmentMeta[];
  notesOriginal: string;
  notesCurrent: string;
  noteVersions: NoteVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface AudioChunk {
  id: string;
  lectureId: string;
  index: number;
  blob: Blob;
  mimeType: string;
  createdAt: string;
}

export interface StoredAudio {
  lectureId: string;
  blob: Blob;
  mimeType: string;
  size: number;
  createdAt: string;
}

export interface StoredAttachment {
  id: string;
  lectureId: string;
  blob: Blob;
  name: string;
  type: string;
  size: number;
}

export interface AppSettings {
  key: 'app';
  consentAcknowledged: boolean;
  followTranscript: boolean;
  preferredMode: 'computer' | 'phone';
  phoneModelInstalled?: boolean;
}

export type ViewName = 'home' | 'lectures' | 'courses' | 'search' | 'lecture' | 'settings';
