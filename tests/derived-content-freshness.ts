import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const types = readFileSync(new URL('../lib/types.ts', import.meta.url), 'utf8');
const transcription = readFileSync(new URL('../lib/transcription.ts', import.meta.url), 'utf8');
const notesEditor = readFileSync(new URL('../components/NotesEditor.tsx', import.meta.url), 'utf8');

// Every generated transcript/notes relationship must have an explicit source version.
assert.match(types, /transcriptVersion\?: number/);
assert.match(types, /translationSourceVersion\?: number/);
assert.match(types, /notesSourceVersion\?: number/);
assert.match(types, /derivedContentStale\?: boolean/);

// A fresh transcription establishes a new source version and records which version
// its generated notes/translations were derived from.
assert.match(transcription, /const transcriptVersion = Number\(lecture\.transcriptVersion \|\| 0\) \+ 1/);
assert.match(transcription, /notesSourceVersion: transcriptVersion/);
assert.match(transcription, /translationSourceVersion: englishTranslation\.length \|\| arabicTranslation\.length \? transcriptVersion : undefined/);

// Manual note edits never magically make stale notes current. Delayed autosave must
// merge into the latest lecture object, and only regeneration from that current
// transcript updates notesSourceVersion.
assert.match(notesEditor, /const lectureRef = useRef\(lecture\)/);
assert.match(notesEditor, /const latest = lectureRef\.current/);
assert.match(notesEditor, /onSave\(\{ \.\.\.latest, notesCurrent: html/);
assert.match(notesEditor, /const notesFresh = !lecture\.segments\.length \|\| Number\(lecture\.notesSourceVersion \|\| 0\) === transcriptVersion/);
assert.match(notesEditor, /The transcript changed after these notes were generated/);
assert.match(notesEditor, /const sourceVersion = Number\(latest\.transcriptVersion \|\| 0\)/);
assert.match(notesEditor, /notesSourceVersion: sourceVersion/);
assert.match(notesEditor, /Your existing edits are preserved/);

console.log('✓ transcript-derived freshness and race-safe note autosave safeguards are present');
