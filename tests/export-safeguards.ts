import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const webExport = readFileSync(new URL('../lib/export.ts', import.meta.url), 'utf8');
const device = readFileSync(new URL('../lib/device.ts', import.meta.url), 'utf8');
const detail = readFileSync(new URL('../ios/LectureAIRecorder/Sources/LectureDetailView.swift', import.meta.url), 'utf8');
const recorder = readFileSync(new URL('../ios/LectureAIRecorder/Sources/RecorderStore.swift', import.meta.url), 'utf8');

// Browser/PWA exports use the Web Share API wherever the browser exposes it, not only
// on iOS, and always preserve a normal download fallback when file sharing is absent
// or a share target rejects the attachment.
assert.match(webExport, /function shareOrDownload\(/);
assert.match(webExport, /typeof navigator !== 'undefined'/);
assert.match(webExport, /nav\.share/);
assert.match(webExport, /nav\.canShare/);
assert.match(webExport, /new File\(\[blob\], safe/);
assert.match(webExport, /blob\.type\.startsWith\('text\/'\)/);
assert.match(webExport, /download\(blob, safe\)/);
assert.doesNotMatch(webExport, /isIOSDevice|isStandaloneApp/);

// Notes, transcript, DOCX and original audio all pass through the same share/download
// compatibility layer. UTF-8 text gives recipients a format that is readable without
// LectureAI, while the original audio remains a real file attachment.
assert.match(webExport, /export function exportMarkdown[\s\S]*shareOrDownload\(blob, filename/);
assert.match(webExport, /export function exportTranscriptText[\s\S]*text\/plain;charset=utf-8[\s\S]*shareOrDownload/);
assert.match(webExport, /export async function exportDocx[\s\S]*shareOrDownload\(blob/);
assert.match(webExport, /export function downloadBlob[\s\S]*shareOrDownload\(blob, filename, 'LectureAI original recording'\)/);

// Prefer the most broadly playable browser recording container first. Unsupported
// browsers can fall back to WebM and the file extension must still match the real MIME.
assert.match(device, /return \['audio\/mp4;codecs=mp4a\.40\.2', 'audio\/mp4', 'audio\/webm;codecs=opus', 'audio\/webm'\]/);
assert.match(device, /if \(type\.includes\('mp4'\) \|\| type\.includes\('m4a'\)\) return 'm4a'/);
assert.match(device, /if \(type\.includes\('webm'\)\) return 'webm'/);

// The native iPhone/iPad application records universally common AAC/M4A, exports audio
// through the iOS share sheet, and exports transcript/notes as standalone UTF-8 .txt files.
assert.match(recorder, /kAudioFormatMPEG4AAC/);
assert.match(recorder, /\.m4a"\)/);
assert.match(detail, /ShareLink\(item: recording\.audioURL\)/);
assert.match(detail, /FileRepresentation\(exportedContentType: \.plainText\)/);
assert.match(detail, /appendingPathExtension\("txt"\)/);
assert.match(detail, /encoding: \.utf8/);
assert.match(detail, /Export recording/);
assert.match(detail, /Export transcript/);
assert.match(detail, /Export notes/);

console.log('✓ cross-platform export safeguards are present');
