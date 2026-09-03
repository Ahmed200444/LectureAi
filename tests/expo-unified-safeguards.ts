import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../expo-recorder/App.js', import.meta.url), 'utf8');
const storage = readFileSync(new URL('../expo-recorder/src/storage.js', import.meta.url), 'utf8');
const study = readFileSync(new URL('../expo-recorder/src/study.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../expo-recorder/package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> };
const appJson = readFileSync(new URL('../expo-recorder/app.json', import.meta.url), 'utf8');

// App Store Expo Go on iPhone currently targets SDK 54; do not silently move the
// physical-device project to a newer SDK that the store app cannot open.
assert.match(packageJson.dependencies?.expo || '', /^~54\./);
assert.match(packageJson.dependencies?.['expo-audio'] || '', /^~1\./);
assert.ok(packageJson.dependencies?.['expo-file-system']);
assert.ok(packageJson.dependencies?.['expo-sqlite']);
assert.ok(packageJson.dependencies?.['expo-sharing']);
assert.ok(packageJson.dependencies?.['expo-document-picker']);

// Recording must use native Expo audio rather than browser MediaRecorder/Safari.
assert.match(app, /from 'expo-audio'/);
assert.match(app, /useAudioRecorder\(RECORDING_OPTIONS\)/);
assert.match(app, /sampleRate: 48_000/);
assert.match(app, /numberOfChannels: 1/);
assert.match(app, /bitRate: 192_000/);
assert.match(app, /isMeteringEnabled: true/);
assert.match(app, /recorder\.pause\(\)/);
assert.match(app, /recorder\.record\(\)/);
assert.match(app, /markMoment/);
assert.match(app, /mediaServicesDidReset/);
assert.match(app, /Paths\.availableDiskSpace/);
assert.match(app, /KeepAwake\.activateKeepAwakeAsync/);

// Stock Expo Go cannot apply LectureAI's own iOS UIBackgroundModes config. Do not
// claim or runtime-enable guaranteed background recording in this free build.
assert.doesNotMatch(app, /allowsBackgroundRecording:\s*true/);
assert.doesNotMatch(appJson, /enableBackgroundRecording\"\s*:\s*true/);
assert.match(app, /Expo Go cannot guarantee locked-screen\/background recording/);

// The original file is copied from temporary recorder/import locations into the
// project document directory and checked before metadata says it was preserved.
assert.match(storage, /new Directory\(Paths\.document, 'LectureAI'\)/);
assert.match(storage, /new Directory\(root, 'Recordings'\)/);
assert.match(storage, /source\.copy\(destination\)/);
assert.match(storage, /destination\.size < 1024/);
assert.match(storage, /info\(\{ md5: true \}\)/);
assert.match(storage, /audioVerification: 'needs-listen-check'/);
assert.match(storage, /audioVerification: 'user-playback-confirmed'/);
assert.match(app, /I listened — audio is clear/);

// Large metadata belongs in local persistent storage; the audio remains a file.
assert.match(storage, /expo-sqlite\/kv-store/);
assert.doesNotMatch(storage, /base64\(|bytes\(\).*Storage\.setItem/s);

// Transcript edits must invalidate derived material instead of silently leaving
// stale notes/translations behind.
assert.match(storage, /transcriptVersion/);
assert.match(storage, /staleDerivedContent: true/);
assert.match(storage, /studyPackSourceVersion/);
assert.match(study, /derivedContentIsFresh/);
assert.match(app, /Transcript changed/);
assert.match(app, /Update derived content/);

// Source-grounded notes use the whole transcript and exclude uncertain/inaudible
// text instead of treating questionable ASR output as trusted lecture facts.
assert.match(study, /representativeSegments\(all, 7, 2\)/);
assert.match(study, /\[\(\?:inaudible\|uncertain\)\]/);
assert.match(study, /possibleExamTopics/);
assert.match(study, /not a claim that the professor promised it will be on an exam/);
assert.match(app, /source audio/);

// Do not fake the browser Whisper worker as a React Native transcription engine.
assert.doesNotMatch(app, /@huggingface\/transformers/);
assert.match(app, /does not pretend the browser Whisper worker can run natively/);
assert.match(app, /Import transcript JSON/);

console.log('✓ unified Expo Go recorder, persistent audio/library, transcript freshness, and source-grounded study safeguards are present');
