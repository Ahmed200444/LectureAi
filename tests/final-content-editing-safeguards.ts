import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../expo-recorder/App.js', import.meta.url), 'utf8');
const storage = readFileSync(new URL('../expo-recorder/src/storage.js', import.meta.url), 'utf8');
const exportsSource = readFileSync(new URL('../expo-recorder/src/exports.js', import.meta.url), 'utf8');

// Edits are persisted before their UI can claim success, and changing transcript text
// creates a new source version so older study material cannot remain current.
assert.match(app, /Transcript edit was not saved/);
assert.match(app, /await upsertLecture\(updated\)/);
assert.match(app, /TextInput multiline/);
assert.match(app, /player\.seekTo\(segment\.startTime\)/);
assert.match(storage, /const version = Number\(lecture\.transcriptVersion \|\| 0\) \+ 1/);
assert.match(storage, /staleDerivedContent: true/);
assert.match(storage, /clearSourceMetadata/);
assert.match(exportsSource, /studyPackSourceVersion/);

console.log('✓ Expo transcript editing persists before success and invalidates stale derived content');
