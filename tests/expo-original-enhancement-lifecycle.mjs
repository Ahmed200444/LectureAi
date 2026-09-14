import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const derivativesSource = readFileSync(new URL('../expo-recorder/src/audio-derivatives.js', import.meta.url), 'utf8');
const {
  assertOriginalIntegrity,
  buildEnhancedAudioMetadata,
  currentEnhancedAudio,
  normalizeAudioCleanupMode,
  selectTranscriptionAudio,
  withoutEnhancedAudio,
} = await import(`data:text/javascript;base64,${Buffer.from(derivativesSource).toString('base64')}`);

const root = join(tmpdir(), `lectureai-derived-lifecycle-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: false });

function md5(path) {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

function observation(path) {
  const exists = existsSync(path);
  return { exists, uri: path, filename: path.split(/[\\/]/).pop(), size: exists ? readFileSync(path).length : 0, md5: exists ? md5(path) : null };
}

function makeOriginal(id, seed) {
  const path = join(root, `${id}-original.m4a`);
  const bytes = Buffer.alloc(4096, seed);
  writeFileSync(path, bytes);
  return {
    id,
    title: `Synthetic ${id}`,
    audioUri: path,
    audioFilename: `${id}-original.m4a`,
    audioMd5: md5(path),
    size: bytes.length,
    transcript: [],
  };
}

function generatedMetadata(lecture, mode, label) {
  const before = observation(lecture.audioUri);
  const path = join(root, `${lecture.id}-${label}-${mode}.wav`);
  writeFileSync(path, Buffer.concat([Buffer.from(`derived-${mode}-`), Buffer.alloc(5000, mode === 'strong' ? 31 : 17)]));
  const after = observation(lecture.audioUri);
  return buildEnhancedAudioMetadata({ lecture, cleanupMode: mode, derived: observation(path), sourceBefore: before, sourceAfter: after });
}

try {
  assert.equal(normalizeAudioCleanupMode('off'), 'off');
  assert.equal(normalizeAudioCleanupMode('balanced'), 'balanced');
  assert.equal(normalizeAudioCleanupMode('strong'), 'strong');

  // Simulate four pre-feature library rows: no migration and no enhancedAudio field.
  const legacy = [makeOriginal('old-one', 1), makeOriginal('old-two', 2), makeOriginal('old-three', 3), makeOriginal('old-four', 4)];
  const originalHashes = new Map(legacy.map((lecture) => [lecture.id, md5(lecture.audioUri)]));
  assert.ok(legacy.every((lecture) => currentEnhancedAudio(lecture) === null));
  assert.ok(legacy.every((lecture) => existsSync(lecture.audioUri)));

  const balanced = generatedMetadata(legacy[0], 'balanced', 'first');
  legacy[0] = { ...legacy[0], originalAudioProtected: true, enhancedAudio: balanced };
  const restartedWithLegacyEnhancement = JSON.parse(JSON.stringify(legacy));
  assert.equal(currentEnhancedAudio(restartedWithLegacyEnhancement[0]).uri, balanced.uri);
  assert.notEqual(legacy[0].audioUri, balanced.uri);
  assert.equal(md5(legacy[0].audioUri), originalHashes.get(legacy[0].id));
  const enhancedInput = selectTranscriptionAudio(legacy[0], 'enhanced');
  assert.equal(enhancedInput.uri, balanced.uri);
  assert.equal(enhancedInput.timestampReferenceUri, legacy[0].audioUri);
  assert.equal(enhancedInput.source, 'enhanced');

  const strong = generatedMetadata(legacy[0], 'strong', 'second');
  const oldDerived = legacy[0].enhancedAudio.uri;
  legacy[0] = { ...legacy[0], enhancedAudio: strong };
  unlinkSync(oldDerived);
  assert.equal(strong.cleanupMode, 'strong');
  assert.equal(md5(legacy[0].audioUri), originalHashes.get(legacy[0].id));
  unlinkSync(strong.uri);
  legacy[0] = withoutEnhancedAudio(legacy[0]);
  assert.equal(currentEnhancedAudio(legacy[0]), null);
  assert.ok(existsSync(legacy[0].audioUri));
  assert.ok(legacy.every((lecture) => md5(lecture.audioUri) === originalHashes.get(lecture.id)));

  const restartedLegacy = JSON.parse(JSON.stringify(legacy));
  assert.equal(restartedLegacy.length, 4);
  assert.ok(restartedLegacy.every((lecture) => existsSync(lecture.audioUri)));

  // Simulate the permanent future-recording lifecycle with the same metadata path.
  let future = { ...makeOriginal('future-one', 9), originalAudioProtected: true, enhancedAudio: null };
  const futureOriginalHash = md5(future.audioUri);
  future = { ...future, enhancedAudio: generatedMetadata(future, 'balanced', 'first') };
  assert.equal(md5(future.audioUri), futureOriginalHash);
  const priorFutureDerived = future.enhancedAudio.uri;
  future = { ...future, enhancedAudio: generatedMetadata(future, 'strong', 'second') };
  unlinkSync(priorFutureDerived);
  const restartedWithFutureEnhancement = JSON.parse(JSON.stringify(future));
  assert.equal(currentEnhancedAudio(restartedWithFutureEnhancement).cleanupMode, 'strong');
  assert.equal(md5(future.audioUri), futureOriginalHash);
  assert.equal(selectTranscriptionAudio(future, 'enhanced').timestampReferenceUri, future.audioUri);
  unlinkSync(future.enhancedAudio.uri);
  future = withoutEnhancedAudio(future);
  assert.ok(existsSync(future.audioUri));
  assert.equal(md5(future.audioUri), futureOriginalHash);
  assert.equal(selectTranscriptionAudio(future, 'original').uri, future.audioUri);
  const restartedFuture = JSON.parse(JSON.stringify(future));
  assert.ok(existsSync(restartedFuture.audioUri));
  assertOriginalIntegrity(restartedFuture, observation(restartedFuture.audioUri));

  const tampered = makeOriginal('tamper-check', 4);
  writeFileSync(tampered.audioUri, Buffer.alloc(4096, 5));
  assert.throws(() => assertOriginalIntegrity(tampered, observation(tampered.audioUri)), /hash changed before enhancement/);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('✓ four legacy and future recordings preserve originals across enhancement, regeneration, deletion, transcription selection, and restart');
