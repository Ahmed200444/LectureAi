import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const webDetail = readFileSync(new URL('../components/LectureDetail.tsx', import.meta.url), 'utf8');
const webNotes = readFileSync(new URL('../components/NotesEditor.tsx', import.meta.url), 'utf8');
const webExport = readFileSync(new URL('../lib/export.ts', import.meta.url), 'utf8');
const nativeDetail = readFileSync(new URL('../ios/LectureAIRecorder/Sources/LectureDetailView.swift', import.meta.url), 'utf8');
const nativeStore = readFileSync(new URL('../ios/LectureAIRecorder/Sources/NativeLectureStore.swift', import.meta.url), 'utf8');

// Safari/PWA: each timestamp seeks the original recording; corrected transcript fields
// persist locally; notes are content-editable and autosave; exports use share/download.
assert.match(webDetail, /function seek\(time: number, autoplay = false\)/);
assert.match(webDetail, /audioRef\.current\.currentTime = time/);
assert.match(webDetail, /onClick=\{\(\) => onSeek\(segment\.startTime, true\)\}/);
assert.match(webDetail, /textarea[\s\S]*onBlur=\{\(event\) => onEdit\(segment\.id/);
assert.match(webDetail, /Transcript edit saved locally/);
assert.match(webNotes, /contentEditable/);
assert.match(webNotes, /onInput=\{scheduleSave\}/);
assert.match(webNotes, /Saved locally/);
assert.match(webExport, /shareOrDownload/);
assert.match(webExport, /exportTranscriptText/);
assert.match(webExport, /exportMarkdown/);
assert.match(webExport, /downloadBlob/);

// Native iPhone/iPad app: transcript and notes edits are explicit, local, persisted,
// timestamp navigation seeks the source audio, and all three requested exports exist.
assert.match(nativeStore, /func updateTranscriptSegment\(/);
assert.match(nativeStore, /record\.segments\[index\] = replacement/);
assert.match(nativeStore, /record\.statusMessage = "Transcript edit saved locally"/);
assert.match(nativeStore, /func updateNotes\(/);
assert.match(nativeStore, /record\.notes = notes/);
assert.match(nativeStore, /record\.statusMessage = "Notes edit saved locally"/);
assert.match(nativeStore, /persist\(record\)/);
assert.match(nativeDetail, /Edit transcript/);
assert.match(nativeDetail, /Done editing/);
assert.match(nativeDetail, /NativeTranscriptSegmentEditor/);
assert.match(nativeDetail, /TextField\("Transcript segment"/);
assert.match(nativeDetail, /Edit notes/);
assert.match(nativeDetail, /Save notes/);
assert.match(nativeDetail, /TextEditor\(text: \$notesDraft\)/);
assert.match(nativeDetail, /recorder\.play\(recording, from: segment\.startTime\)/);
assert.match(nativeDetail, /Tap any timestamp to play that exact part of the original recording/);
assert.match(nativeDetail, /ShareLink\(item: recording\.audioURL\)/);
assert.match(nativeDetail, /Export recording/);
assert.match(nativeDetail, /Export transcript/);
assert.match(nativeDetail, /Export notes/);

console.log('✓ final transcript, notes, navigation, and export safeguards are present');
