import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../expo-recorder/App.js', import.meta.url), 'utf8');
const root = readFileSync(new URL('../expo-recorder/Root.js', import.meta.url), 'utf8');
const storage = readFileSync(new URL('../expo-recorder/src/storage.js', import.meta.url), 'utf8');
const study = readFileSync(new URL('../expo-recorder/src/study.js', import.meta.url), 'utf8');
const exportsSource = readFileSync(new URL('../expo-recorder/src/exports.js', import.meta.url), 'utf8');
const journal = readFileSync(new URL('../expo-recorder/src/recording-journal.js', import.meta.url), 'utf8');
const computer = readFileSync(new URL('../expo-recorder/src/computer.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../local-ai/server.py', import.meta.url), 'utf8');
const pairing = readFileSync(new URL('../local-ai/pairing.py', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../expo-recorder/package.json', import.meta.url), 'utf8')) as { scripts?: Record<string, string>, dependencies?: Record<string, string> };
const appJson = readFileSync(new URL('../expo-recorder/app.json', import.meta.url), 'utf8');

assert.match(packageJson.dependencies?.expo || '', /^~57\./);
assert.match(packageJson.dependencies?.['expo-audio'] || '', /^~57\./);
assert.match(packageJson.dependencies?.['expo-secure-store'] || '', /^~57\./);
assert.ok(packageJson.dependencies?.['expo-file-system']);
assert.ok(packageJson.dependencies?.['expo-sqlite']);
assert.ok(packageJson.dependencies?.['expo-sharing']);
assert.ok(packageJson.dependencies?.['expo-document-picker']);
assert.ok(!packageJson.scripts?.postinstall, 'Expo install must not rewrite App.js at runtime');

assert.match(appJson, /"supportsTablet"\s*:\s*true/);
assert.match(appJson, /"requireFullScreen"\s*:\s*false/);
assert.match(appJson, /"targetAppleDevices"\s*:\s*\["iPhone",\s*"iPad"\]/);

// SDK 57 records into document storage rather than relying on a cache recording.
assert.match(app, /from 'expo-audio'/);
assert.match(app, /useAudioRecorder\(RECORDING_OPTIONS\)/);
assert.match(app, /directory:\s*['"]document['"]/i);
assert.match(app, /sampleRate: 48_000/);
assert.match(app, /numberOfChannels: 1/);
assert.match(app, /bitRate: 192_000/);
assert.match(app, /isMeteringEnabled: true/);
assert.match(app, /recorder\.prepareToRecordAsync\(\)/);
assert.match(app, /recorder\.pause\(\)/);
assert.match(app, /recorder\.record\(\)/);
assert.match(app, /mediaServicesDidReset/);
assert.match(app, /hadRecorderSignalRef/);
assert.match(app, /unexpectedHandledRef/);
assert.match(app, /unexpected-recorder-stop/);
assert.match(app, /preserveRecorderOutput\(\{ unexpected: true \}\)/);
assert.doesNotMatch(app, /allowsBackgroundRecording:\s*true/);
assert.match(app, /Expo Go cannot guarantee locked-screen\/background recording/);

// SDK57 optional APIs must never block microphone start.
assert.match(app, /typeof recorder\.getCurrentInput === 'function'/);
assert.match(app, /typeof KeepAwake\.activateKeepAwakeAsync === 'function'/);
assert.match(app, /Recorder start failed:/);

// Document preservation, metadata redundancy, and local copy integrity.
assert.match(storage, /new Directory\(Paths\.document, 'LectureAI'\)/);
assert.match(storage, /new Directory\(root, 'Recordings'\)/);
assert.match(storage, /writeLibraryBackup\(clean\);[\s\S]*Storage\.setItem\(LIBRARY_KEY/);
assert.match(storage, /newestUpdate\(backup\) > newestUpdate\(parsed\)/);
assert.match(storage, /source\.info\(\{ md5: true \}\)/);
assert.match(storage, /sourceMd5\.toLowerCase\(\) !== destinationMd5\.toLowerCase\(\)/);
assert.match(storage, /audioVerification: 'needs-listen-check'/);
assert.match(storage, /audioPlaybackChecks/);
assert.match(storage, /markAudioPlaybackPoint/);
assert.match(storage, /Verify playback at the beginning, middle, and end/);
assert.match(app, /Play beginning/);
assert.match(app, /Play middle/);
assert.match(app, /Play end/);
assert.match(app, /I listened to all three — audio is clear/);

// Imports and sharing must use the actual selected URI/type.
assert.match(app, /const file = new File\(asset\.uri\)/);
assert.match(app, /function audioMime/);
assert.match(app, /mimeType: audioMime\(lecture\.audioFilename\)/);
assert.match(app, /audioSource !== 'imported'/);
assert.match(app, /durationMs: Math\.round\(duration \* 1000\)/);

// Export hub must live in Settings instead of floating over bottom navigation.
assert.match(root, /<App onOpenExports=/);
assert.doesNotMatch(root, /exportFab/);
assert.match(app, /Export lecture files/);
assert.match(exportsSource, /editedText \|\| segment\?\.originalText/);
assert.match(exportsSource, /Notes are missing or stale/);
assert.match(exportsSource, /Study material is missing or stale/);
assert.match(exportsSource, /Original audio is exported separately/);
assert.match(exportsSource, /Sharing\.shareAsync/);

// Uncertain imported ASR must not become trusted study material.
assert.match(study, /segment\?\.uncertain === true/);
assert.match(study, /representativeSegments\(all, 7, 2\)/);
assert.match(study, /not a claim that the professor promised it will be on an exam/);

// Recovery journal remains a pointer to surviving audio, never fake byte checkpoints.
assert.match(journal, /JOURNAL_FILENAME = 'active-recording\.json'/);
assert.match(journal, /recoverInterruptedRecording/);
assert.match(journal, /source\.exists/);
assert.match(journal, /interrupted-recorder-recovery/);
assert.match(journal, /listen to the beginning, middle, and end/i);

// Windows helper stays private, authenticated, integrity-checked, and bounded.
assert.match(computer, /private local IPv4 address/);
assert.match(computer, /Authorization: `Bearer \$\{token\}`/);
assert.match(computer, /MAX_UPLOAD_TIMEOUT_MS/);
assert.match(computer, /MAX_JOB_WAIT_MS/);
assert.match(computer, /three-hour safety window/);
assert.match(computer, /form\.append\('audioMd5'/);
assert.match(server, /PairingStore/);
assert.match(server, /request_authorized/);
assert.match(server, /normalize_expected_md5/);
assert.match(server, /received_md5 != expected_md5/);
assert.match(pairing, /secrets\.compare_digest/);
assert.match(pairing, /MAX_PAIRING_ATTEMPTS_PER_WINDOW/);
assert.match(app, /not end-to-end encrypted/);

console.log('✓ Expo SDK57 recording, unexpected-stop preservation, storage integrity, playback gate, imports/exports, secure Windows transcription, and study safeguards are present');
