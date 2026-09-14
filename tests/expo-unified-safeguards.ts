import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../expo-recorder/App.js', import.meta.url), 'utf8');
const root = readFileSync(new URL('../expo-recorder/Root.js', import.meta.url), 'utf8');
const storage = readFileSync(new URL('../expo-recorder/src/storage.js', import.meta.url), 'utf8');
const study = readFileSync(new URL('../expo-recorder/src/study.js', import.meta.url), 'utf8');
const exportsSource = readFileSync(new URL('../expo-recorder/src/exports.js', import.meta.url), 'utf8');
const journal = readFileSync(new URL('../expo-recorder/src/recording-journal.js', import.meta.url), 'utf8');
const computer = readFileSync(new URL('../expo-recorder/src/computer.js', import.meta.url), 'utf8');
const qrPairing = readFileSync(new URL('../expo-recorder/src/qr-pairing.js', import.meta.url), 'utf8');
const pairingScanner = readFileSync(new URL('../expo-recorder/src/PairingScanner.js', import.meta.url), 'utf8');
const backgroundRecording = readFileSync(new URL('../expo-recorder/src/background-recording.js', import.meta.url), 'utf8');
const lectureMetadata = readFileSync(new URL('../expo-recorder/src/lecture-metadata.js', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../local-ai/engine.py', import.meta.url), 'utf8');
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
assert.match(packageJson.dependencies?.['expo-camera'] || '', /^~57\./, 'QR scanning must use the Expo Go-compatible SDK 57 camera package');
assert.ok(!packageJson.scripts?.postinstall, 'Expo install must not rewrite App.js at runtime');

assert.match(appJson, /"supportsTablet"\s*:\s*true/);
assert.match(appJson, /"requireFullScreen"\s*:\s*false/);
assert.match(appJson, /"targetAppleDevices"\s*:\s*\["iPhone",\s*"iPad"\]/);
assert.match(appJson, /"enableBackgroundRecording"\s*:\s*true/);
assert.match(appJson, /"UIBackgroundModes"\s*:\s*\["audio"\]/);
assert.match(root, /allowsBackgroundRecording:\s*true/);
assert.match(app, /allowsBackgroundRecording:\s*true/);
assert.match(packageJson.scripts?.['build:ios:preview'] || '', /eas-cli@latest build --platform ios --profile preview/);

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
assert.match(app, /unexpectedStopTimerRef/);
assert.match(app, /appStateRef\.current !== 'active'/);
assert.match(app, /foregroundReconcileRef\.current/);
assert.match(app, /Recording · native recorder confirmed after app switch/);
assert.match(backgroundRecording, /return isRecording \? 'recording' : 'stopped'/);
assert.match(app, /recordingActiveRef\.current/);
assert.match(app, /pausedRef\.current/);
assert.match(app, /liveRecorder && styles\.statusDotLive/);
assert.match(app, /The native recorder did not confirm that the paused session resumed/);
assert.match(app, /unexpected-recorder-stop/);
assert.match(app, /preserveRecorderOutput\(\{ unexpected: true \}\)/);
assert.match(app, /allowsBackgroundRecording:\s*true/);
assert.match(app, /Stock Expo Go cannot guarantee background recording/);

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
assert.match(storage, /await source\.copy\(destination\)/);
assert.match(storage, /preserved = new File\(destination\.uri\)/);
assert.match(storage, /if \(!info\.exists \|\| destinationSize < 1024\)/);
assert.match(storage, /destinationSize !== sourceSize/);
assert.match(storage, /const partial = preserved \|\| new File\(destination\.uri\)/);
assert.match(storage, /sourceMd5\.toLowerCase\(\) !== destinationMd5\.toLowerCase\(\)/);
assert.match(storage, /recoveredRows\.map\(migrateLectureMetadata\)/);
assert.match(storage, /sortLibrary\(\(lectures \|\| \[\]\)\.map\(migrateLectureMetadata\)\)/);
assert.match(lectureMetadata, /Untitled Lecture/);
assert.match(lectureMetadata, /Lecture Name cannot be blank/);
assert.match(lectureMetadata, /Audio identity,[\s\S]*Windows job IDs are retained/);
assert.match(app, /Edit Lecture Name/);
assert.match(app, /Find by Lecture Name/);
assert.match(app, /renameLectureTitle\(lecture, requestedTitle\)/);
assert.match(app, /You can name it before or during recording, or rename it later/);
assert.match(computer, /lecture\?\.title/);
assert.match(computer, /lecture\?\.professor/);
assert.match(storage, /audioVerification: 'needs-listen-check'/);
assert.match(storage, /audioPlaybackChecks/);
assert.match(storage, /markAudioPlaybackPoint/);
assert.match(storage, /Verify playback at the beginning, middle, and end/);
assert.match(app, /Play beginning/);
assert.match(app, /Play middle/);
assert.match(app, /Play end/);
assert.match(app, /I listened to all three — audio is clear/);
assert.match(app, /startingRef\.current = true/);
assert.match(app, /recorderStatus\?\.isRecording/);
assert.match(app, /player\.currentTime/);
assert.match(app, /playback sample did not advance/);
assert.match(app, /stripWhisperControlTokens/);

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
assert.match(exportsSource, /buildEnglishTranscriptText/);
assert.match(exportsSource, /buildSourceTranscriptText/);
assert.match(exportsSource, /sourceTranscript: lecture\.sourceTranscript/);
assert.match(exportsSource, /englishTranscript: lecture\.englishTranscript/);
assert.match(exportsSource, /Notes are missing or stale/);
assert.match(exportsSource, /Study material is missing or stale/);
assert.match(exportsSource, /Original audio is exported separately/);
assert.match(exportsSource, /Sharing\.shareAsync/);
assert.match(exportsSource, /exportTranscript/);
assert.match(exportsSource, /exportEnglishTranscript/);
assert.match(exportsSource, /exportSourceTranscript/);
assert.match(exportsSource, /lectureExportFilename/);
assert.match(app, /Share \/ Export Transcript/);
assert.match(app, /Share current transcript/);
assert.match(app, /Share English transcript/);
assert.match(app, /Share original-language transcript/);
assert.match(app, /onShareTranscript/);
assert.match(app, /transcript and original audio are unchanged/);

// Windows faster-whisper publishes the source transcript first. Translation is
// deferred so it cannot double the full-audio ASR cost or block source recovery.
assert.match(engine, /task="transcribe"/);
assert.doesNotMatch(engine, /task="translate"/);
assert.match(engine, /"source_segments": source_segments/);
assert.match(engine, /"english_segments": english_segments/);
assert.match(engine, /"segments": current_segments/);
assert.match(engine, /best_of=1/);
assert.match(engine, /condition_on_previous_text=False/);
assert.match(engine, /word_timestamps=True/);
assert.match(engine, /vad_filter=True/);
assert.match(engine, /\[uncertain\]/);
assert.match(engine, /def sanitize_transcript_text/);
assert.match(computer, /lecture\.sourceTranscript = sourceTranscript/);
assert.match(computer, /lecture\.englishTranscript = englishTranscript/);
assert.match(computer, /lecture\.sourceLanguage =/);

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
assert.match(computer, /MAX_FOREGROUND_POLL_MS/);
assert.match(computer, /Transcription was cancelled on this device/);
assert.match(computer, /reconnect to this saved job later/);
assert.match(computer, /resumeComputerJob/);
assert.match(computer, /onJobUpdate/);
assert.match(computer, /form\.append\('audioMd5'/);
assert.match(server, /PairingStore/);
assert.match(server, /request_authorized/);
assert.match(server, /normalize_expected_md5/);
assert.match(server, /received_md5 != expected_md5/);
assert.match(server, /MAX_UPLOAD_BYTES/);
assert.match(server, /total > MAX_UPLOAD_BYTES/);
assert.match(pairing, /secrets\.compare_digest/);
assert.match(pairing, /MAX_PAIRING_ATTEMPTS_PER_WINDOW/);
assert.match(app, /not end-to-end encrypted/);
assert.match(app, /Scan laptop QR/);
assert.match(app, /Advanced: enter address and code manually/);
assert.match(app, /computerLastConnectedAt/);
assert.match(app, /Offline does not erase a secure pairing/);
assert.match(pairingScanner, /from 'expo-camera'/);
assert.match(pairingScanner, /barcodeTypes: \['qr'\]/);
assert.match(pairingScanner, /onBarcodeScanned/);
assert.match(pairingScanner, /Camera could not read a QR code yet/);
assert.match(pairingScanner, /if \(!accepted\) consumedRef\.current = false/);
assert.match(qrPairing, /LAPTOP_PAIRING_QR_PREFIX/);
assert.match(qrPairing, /parts\.length !== 3/);
assert.match(qrPairing, /normalizeComputerAddress/);
assert.match(qrPairing, /PAIRING_CODE/);
assert.match(pairing, /PAIRING_QR_PREFIX/);
assert.match(pairing, /laptop_pairing_qr/);
assert.match(server, /write_pairing_qr/);
assert.match(app, /QR read successfully, but it is not a usable LectureAI pairing code/);
assert.match(server, /computer_name/);
assert.match(server, /--host/);

console.log('✓ Expo SDK57 recording, native background mode, dual English/source transcription, async storage integrity, playback gate, imports/exports, secure Windows transcription, and study safeguards are present');
