import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../expo-recorder/App.js', import.meta.url), 'utf8');
const storage = readFileSync(new URL('../expo-recorder/src/storage.js', import.meta.url), 'utf8');
const study = readFileSync(new URL('../expo-recorder/src/study.js', import.meta.url), 'utf8');
const journal = readFileSync(new URL('../expo-recorder/src/recording-journal.js', import.meta.url), 'utf8');
const computer = readFileSync(new URL('../expo-recorder/src/computer.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../local-ai/server.py', import.meta.url), 'utf8');
const pairing = readFileSync(new URL('../local-ai/pairing.py', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../expo-recorder/package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> };
const appJson = readFileSync(new URL('../expo-recorder/app.json', import.meta.url), 'utf8');

// App Store Expo Go on iPhone currently targets SDK 54; do not silently move the
// physical-device project to a newer SDK that the store app cannot open.
assert.match(packageJson.dependencies?.expo || '', /^~54\./);
assert.match(packageJson.dependencies?.['expo-audio'] || '', /^~1\./);
assert.ok(packageJson.dependencies?.['expo-file-system']);
assert.ok(packageJson.dependencies?.['expo-sqlite']);
assert.match(packageJson.dependencies?.['expo-secure-store'] || '', /^~15\./);
assert.ok(packageJson.dependencies?.['expo-sharing']);
assert.ok(packageJson.dependencies?.['expo-document-picker']);

// Recording must use native Expo audio rather than browser MediaRecorder/Safari.
assert.match(app, /from 'expo-audio'/);
assert.match(app, /useAudioRecorder\(RECORDING_OPTIONS\)/);
assert.match(app, /sampleRate: 48_000/);
assert.match(app, /numberOfChannels: 1/);
assert.match(app, /bitRate: 192_000/);
assert.match(app, /isMeteringEnabled: true/);
assert.doesNotMatch(app, /directory:\s*['"]document['"]/i, 'SDK 54 RecordingOptions does not support a project-controlled directory field');
assert.match(app, /recorder\.prepareToRecordAsync\(\)/);
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

// The completed recorder output is copied into LectureAI/Recordings, checked, and
// left unverified until the user actually listens. SDK54 does not promise the live
// temporary recorder file itself is under our chosen directory.
assert.match(app, /immediately copies the original into its document library/i);
assert.match(storage, /new Directory\(Paths\.document, 'LectureAI'\)/);
assert.match(storage, /new Directory\(root, 'Recordings'\)/);
assert.match(storage, /source\.copy\(destination\)/);
assert.match(storage, /destination\.size < 1024/);
assert.match(storage, /info\(\{ md5: true \}\)/);
assert.match(storage, /audioVerification: 'needs-listen-check'/);
assert.match(storage, /audioVerification: 'user-playback-confirmed'/);
assert.match(app, /I listened — audio is clear/);

// preserveAudioFile writes before metadata on purpose. The authoritative upsert must
// remove any orphan-recovery placeholder for that same physical audio file, and
// deletion must remove duplicate metadata aliases for the same URI/name as well.
assert.match(storage, /item\.audioUri !== lecture\.audioUri/);
assert.match(storage, /item\.audioFilename !== lecture\.audioFilename/);
assert.match(storage, /every physical audio file appears exactly once in the library/);
assert.match(storage, /recoveryNotice: undefined/);

// An active-session journal never pretends to be encoded-audio checkpointing. It
// remembers the latest file URL Expo exposes and only copies a real surviving file.
assert.match(journal, /JOURNAL_FILENAME = 'active-recording\.json'/);
assert.match(journal, /saveActiveRecordingJournal/);
assert.match(journal, /recoverInterruptedRecording/);
assert.match(journal, /source\.exists/);
assert.match(journal, /source\.size < MIN_RECOVERABLE_BYTES/);
assert.match(journal, /interrupted-recorder-recovery/);
assert.match(journal, /listen to the beginning, middle, and end/i);
assert.match(app, /persistRecordingJournal/);
assert.match(app, /stopped-awaiting-preservation/);
assert.match(app, /clearActiveRecordingJournal/);

// Metadata has a second document-directory copy, and an orphan scan can surface an
// original audio file even when the primary SQLite library metadata is unreadable.
assert.match(storage, /LIBRARY_BACKUP_FILENAME = 'library-backup\.json'/);
assert.match(storage, /writeLibraryBackup/);
assert.match(storage, /readLibraryBackup/);
assert.match(storage, /recordings\.list\(\)/);
assert.match(storage, /recovered-document-file/);
assert.match(storage, /recoveryNotice/);
assert.match(app, /Recovered audio — verify/);
assert.match(app, /Recovered original audio/);

// Large metadata belongs in local persistent storage; the audio remains a file.
assert.match(storage, /expo-sqlite\/kv-store/);
assert.doesNotMatch(storage, /base64\(/);
assert.doesNotMatch(storage, /bytes\(\)[\s\S]*Storage\.setItem/);

// The short-lived Windows pairing bearer token is still a credential. Keep it out
// of ordinary SQLite settings/metadata backups and put it in Expo SecureStore.
assert.match(storage, /expo-secure-store/);
assert.match(storage, /COMPUTER_TOKEN_KEY/);
assert.match(storage, /SecureStore\.setItemAsync/);
assert.match(storage, /SecureStore\.getItemAsync/);
assert.match(storage, /SecureStore\.deleteItemAsync/);
assert.match(storage, /computerToken: _secureOnly/);
assert.match(storage, /legacyToken/);
assert.match(storage, /withoutToken/);

// Transcript edits must invalidate derived material instead of silently leaving
// stale notes/translations behind.
assert.match(storage, /transcriptVersion/);
assert.match(storage, /staleDerivedContent: true/);
assert.match(storage, /studyPackSourceVersion/);
assert.match(storage, /translations: \{ en: \[\], ar: \[\] \}/);
assert.match(storage, /translationsSourceVersion: null/);
assert.match(study, /derivedContentIsFresh/);
assert.match(app, /Transcript changed/);
assert.match(app, /Update derived content/);

// Source-grounded notes use the whole transcript and exclude uncertain/inaudible
// text instead of treating questionable ASR output as trusted lecture facts.
assert.match(study, /representativeSegments\(all, 7, 2\)/);
assert.ok(study.includes('(?:inaudible|uncertain)'), 'Study generator must exclude uncertain and inaudible source text.');
assert.match(study, /possibleExamTopics/);
assert.match(study, /not a claim that the professor promised it will be on an exam/);
assert.match(app, /source audio/);
assert.match(app, /Lecture emphasis/);

// Paired Windows transcription is explicit, private-LAN scoped, authenticated, and
// actually wired into the Expo UI rather than existing as an unused helper module.
assert.match(app, /from '\.\/src\/computer'/);
assert.match(app, /pairWithComputer/);
assert.match(app, /computerHealth/);
assert.match(app, /transcribeOnComputer/);
assert.match(app, /Transcribe on paired computer/);
assert.match(app, /start-helper-for-phone\.bat/);
assert.match(computer, /private local IPv4 address/);
assert.match(computer, /Authorization: `Bearer \$\{token\}`/);
assert.match(computer, /\/pair/);
assert.match(computer, /\/jobs/);
assert.match(server, /--lan/);
assert.match(server, /PairingStore/);
assert.match(server, /request_authorized/);
assert.match(server, /host="0\.0\.0\.0"/);
assert.match(pairing, /secrets\.compare_digest/);
assert.match(pairing, /MAX_PAIRING_ATTEMPTS_PER_WINDOW/);
assert.match(app, /trusted private\/home Wi-Fi/);
assert.match(app, /not end-to-end encrypted/);

// When Expo exposes an MD5 for the protected original, the phone sends it and the
// Windows helper hashes the received bytes before accepting the transcription job.
assert.match(computer, /form\.append\('audioMd5'/);
assert.match(computer, /created\.integrity_checked !== true/);
assert.match(server, /normalize_expected_md5/);
assert.match(server, /hashlib\.md5\(\)/);
assert.match(server, /received_md5 != expected_md5/);
assert.match(server, /integrity_checked/);
assert.match(server, /phone original was not modified/i);

// Do not fake the browser Whisper worker as a React Native transcription engine.
assert.doesNotMatch(app, /@huggingface\/transformers/);
assert.match(app, /does not pretend the browser Whisper worker is a native React Native engine/);
assert.match(app, /Import transcript JSON/);

console.log('✓ Expo Go recording, recovery, secure paired Windows transcription, transfer integrity, transcript freshness, and source-grounded study safeguards are present');
