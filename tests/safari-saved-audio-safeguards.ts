import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const validation = readFileSync(new URL('../lib/audio-validation.ts', import.meta.url), 'utf8');
const recorder = readFileSync(new URL('../hooks/use-recorder.ts', import.meta.url), 'utf8');

// A Safari recording must not be declared safe from metadata alone. The validator
// must wait for decoded media data/canplay and reject media-element source errors.
assert.doesNotMatch(validation, /addEventListener\('loadedmetadata',\s*finish/);
assert.match(validation, /addEventListener\('loadeddata', onDecodeReady\)/);
assert.match(validation, /addEventListener\('canplay', onDecodeReady\)/);
assert.match(validation, /HTMLMediaElement\.HAVE_CURRENT_DATA/);
assert.match(validation, /HTMLMediaElement\.NETWORK_NO_SOURCE/);
assert.match(validation, /audio\.error/);

// Safari gets a second fresh playback probe before checkpoint chunks can be deleted.
assert.match(validation, /const firstProbe = await probePlayableAudioUrl/);
assert.match(validation, /if \(!isWindowsImportedFile\) await probePlayableAudioUrl/);
assert.match(validation, /350/);

// Recorder safety remains fail-closed: only delete checkpoints after playback
// validation succeeds, and keep them when validation throws.
const validationPosition = recorder.indexOf('await validatePlayableAudio(blob)');
const deletionPosition = recorder.indexOf('await deleteAudioChunks(lectureIdRef.current)');
assert.ok(validationPosition >= 0, 'recorder must validate assembled audio');
assert.ok(deletionPosition > validationPosition, 'checkpoint deletion must happen only after playback validation');
assert.match(recorder, /Recording checkpoints were kept for recovery/);

console.log('Safari saved-audio safeguards passed.');
