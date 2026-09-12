import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../expo-recorder/App.js', import.meta.url), 'utf8');
const root = readFileSync(new URL('../expo-recorder/Root.js', import.meta.url), 'utf8');
const exportsSource = readFileSync(new URL('../expo-recorder/src/exports.js', import.meta.url), 'utf8');

// Expo exports keep the protected original byte-for-byte and label it from its real
// file extension, rather than assuming every imported file is an M4A/MP4.
assert.match(app, /mimeType: audioMime\(lecture\.audioFilename\)/);
assert.match(root, /mimeType: audioMime\(lecture\.audioFilename\)/);
assert.match(root, /Original audio/);
assert.match(root, /English transcript \(\.txt\)/);
assert.match(root, /Original-language transcript \(\.txt\)/);
assert.match(root, /Lecture data \(\.json\)/);

assert.match(exportsSource, /buildEnglishTranscriptText/);
assert.match(exportsSource, /buildSourceTranscriptText/);
assert.match(exportsSource, /editedText \|\| segment\?\.originalText/);
assert.match(exportsSource, /Notes are missing or stale/);
assert.match(exportsSource, /Study material is missing or stale/);
assert.match(exportsSource, /Original audio is exported separately/);
assert.match(exportsSource, /Sharing\.shareAsync/);

console.log('✓ Expo exports preserve original audio MIME, dual-language transcripts, and stale-derived-content blocks');
