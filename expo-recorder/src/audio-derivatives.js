export const AUDIO_CLEANUP_MODES = Object.freeze(['off', 'balanced', 'strong']);

export function normalizeAudioCleanupMode(value) {
  const mode = String(value || 'balanced').trim().toLowerCase();
  if (!AUDIO_CLEANUP_MODES.includes(mode)) throw new Error('Cleanup must be Off, Balanced, or Strong.');
  return mode;
}

function normalizedMd5(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(candidate) ? candidate : null;
}

function finiteSize(value) {
  const size = Number(value || 0);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

export function currentEnhancedAudio(lecture) {
  const enhanced = lecture?.enhancedAudio;
  if (!enhanced || typeof enhanced !== 'object' || !enhanced.uri) return null;
  try {
    return { ...enhanced, cleanupMode: normalizeAudioCleanupMode(enhanced.cleanupMode) };
  } catch {
    return null;
  }
}

export function assertOriginalIntegrity(lecture, before, after = before) {
  if (!lecture?.audioUri) throw new Error('The protected original recording path is missing. Enhancement was stopped.');
  if (!before?.exists || !after?.exists) throw new Error('The protected original recording is unavailable. Enhancement was stopped.');

  const expectedMd5 = normalizedMd5(lecture.audioMd5 || lecture.originalAudio?.md5);
  const beforeMd5 = normalizedMd5(before.md5);
  const afterMd5 = normalizedMd5(after.md5);
  const expectedSize = finiteSize(lecture.size || lecture.originalAudio?.size);
  const beforeSize = finiteSize(before.size);
  const afterSize = finiteSize(after.size);

  if (expectedSize && beforeSize !== expectedSize) throw new Error('Original-audio integrity changed before enhancement. Processing was stopped and the original was not replaced.');
  if (beforeSize !== afterSize) throw new Error('Original-audio integrity changed during enhancement. Processing was stopped immediately.');
  if (expectedMd5 && beforeMd5 && expectedMd5 !== beforeMd5) throw new Error('Original-audio hash changed before enhancement. Processing was stopped and the original was not replaced.');
  if (beforeMd5 && afterMd5 && beforeMd5 !== afterMd5) throw new Error('Original-audio hash changed during enhancement. Processing was stopped immediately.');

  return { md5: beforeMd5 || expectedMd5, size: beforeSize };
}

export function buildEnhancedAudioMetadata({ lecture, cleanupMode, derived, sourceBefore, sourceAfter, generatedAt = new Date().toISOString() }) {
  const mode = normalizeAudioCleanupMode(cleanupMode);
  const source = assertOriginalIntegrity(lecture, sourceBefore, sourceAfter);
  if (!derived?.exists || !derived.uri || finiteSize(derived.size) < 1024) throw new Error('The enhanced copy is missing or too small to trust. The original recording is unchanged.');
  if (String(derived.uri) === String(lecture.audioUri)) throw new Error('Safety check refused an enhanced copy at the protected original path.');

  return {
    schemaVersion: 1,
    uri: String(derived.uri),
    filename: String(derived.filename || `lectureai-${mode}.wav`),
    size: finiteSize(derived.size),
    md5: normalizedMd5(derived.md5),
    cleanupMode: mode,
    generatedAt,
    sourceUri: String(lecture.audioUri),
    sourceMd5: source.md5,
    sourceSize: source.size,
    sampleRate: Number(derived.sampleRate || 16_000),
    channels: Number(derived.channels || 1),
    timestampReference: 'original',
    processingTechnology: String(derived.processingTechnology || ''),
    speechActivityGuided: Boolean(derived.speechActivityGuided),
    vadTrimming: Boolean(derived.vadTrimming),
    stationaryNoiseAttenuationDb: Number(derived.stationaryNoiseAttenuationDb || 0),
    transientEventsAttenuated: Number(derived.transientEventsAttenuated || 0),
    warning: mode === 'strong' ? 'Strong cleanup can affect difficult or overlapping speech. Compare it with the protected original.' : '',
  };
}

export function selectTranscriptionAudio(lecture, requestedSource = 'original') {
  const source = requestedSource === 'enhanced' ? 'enhanced' : 'original';
  if (source === 'enhanced') {
    const enhanced = currentEnhancedAudio(lecture);
    if (!enhanced) throw new Error('Generate an enhanced-for-transcription copy before selecting it.');
    return {
      source,
      uri: enhanced.uri,
      filename: enhanced.filename,
      size: enhanced.size,
      md5: enhanced.md5,
      cleanupMode: 'off',
      generatedCleanupMode: enhanced.cleanupMode,
      timestampReferenceUri: lecture.audioUri,
    };
  }
  return {
    source,
    uri: lecture.audioUri,
    filename: lecture.audioFilename,
    size: lecture.size,
    md5: lecture.audioMd5 || null,
    cleanupMode: 'off',
    generatedCleanupMode: null,
    timestampReferenceUri: lecture.audioUri,
  };
}

export function withoutEnhancedAudio(lecture) {
  return { ...lecture, enhancedAudio: null, updatedAt: new Date().toISOString() };
}
