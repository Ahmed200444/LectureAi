import assert from 'node:assert/strict';
import { audioFileExtension, normalizeAudioMimeType } from '../lib/device.ts';

assert.equal(normalizeAudioMimeType('', 'Lecture 1.m4a'), 'audio/mp4');
assert.equal(normalizeAudioMimeType('application/octet-stream', 'Lecture 1.m4a'), 'audio/mp4');
assert.equal(normalizeAudioMimeType('audio/mp4', 'Lecture 1.m4a'), 'audio/mp4');
assert.equal(audioFileExtension('audio/mp4'), 'm4a');
assert.equal(audioFileExtension('', 'Lecture 1.m4a'), 'm4a');
assert.equal(audioFileExtension('audio/webm'), 'webm');
assert.equal(audioFileExtension('audio/wav'), 'wav');

console.log('✓ iPhone/iPad M4A transfer and MIME normalization checks passed');
