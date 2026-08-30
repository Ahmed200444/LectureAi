import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recorder = readFileSync(new URL('../hooks/use-recorder.ts', import.meta.url), 'utf8');
const validation = readFileSync(new URL('../lib/audio-validation.ts', import.meta.url), 'utf8');
const device = readFileSync(new URL('../lib/device.ts', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../lib/phone-transcriber.worker.ts', import.meta.url), 'utf8');
const phone = readFileSync(new URL('../lib/phone-transcription.ts', import.meta.url), 'utf8');
const transcript = readFileSync(new URL('../lib/transcript.ts', import.meta.url), 'utf8');
const transcription = readFileSync(new URL('../lib/transcription.ts', import.meta.url), 'utf8');
const engine = readFileSync(new URL('../local-ai/engine.py', import.meta.url), 'utf8');
const micTest = readFileSync(new URL('../components/MicTest.tsx', import.meta.url), 'utf8');
const flow = readFileSync(new URL('../components/RecordingFlow.tsx', import.meta.url), 'utf8');
const detail = readFileSync(new URL('../components/LectureDetail.tsx', import.meta.url), 'utf8');
const exporter = readFileSync(new URL('../lib/export.ts', import.meta.url), 'utf8');
const database = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const helper = readFileSync(new URL('../local-ai/server.py', import.meta.url), 'utf8');
const hostedLauncher = readFileSync(new URL('../start-helper-for-hosted-site.bat', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const manifest = readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
const mobileCss = readFileSync(new URL('../styles/mobile-ios.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

// iPhone/iPad microphone truth comes from a live track plus actual audio signal,
// never Safari's transient muted flag alone.
assert.match(validation, /track\.muted/);
assert.match(validation, /waitForAudibleInput/);
assert.match(validation, /verifyMicrophoneCapture/);
assert.match(validation, /preferredRecordingMimeType/);
assert.match(validation, /captured sample is silent/);
assert.match(device, /iPhone\|iPod/);
assert.match(device, /touchMac/);
assert.match(device, /isStandaloneApp/);
assert.match(device, /standalone\?: boolean/);
assert.match(device, /display-mode: standalone/);
assert.match(device, /autoGainControl: \{ ideal: ios \}/);
assert.match(device, /noiseSuppression: \{ ideal: ios \}/);
assert.match(device, /echoCancellation: \{ ideal: false \}/);
assert.match(device, /applyLectureAudioPreferences/);
assert.match(device, /track\.applyConstraints/);
assert.match(device, /audio\/mp4;codecs=mp4a\.40\.2/);

// Long recording is checkpointed with no app-imposed duration quota, and a failed
// IndexedDB checkpoint cannot be silently treated as a successful save.
assert.match(recorder, /lectureAudioConstraints\(\)/);
assert.match(recorder, /applyLectureAudioPreferences\(track\)/);
assert.match(recorder, /verifyMicrophoneCapture\(stream, 1800\)/);
assert.match(recorder, /audioBitsPerSecond: 192_000/);
assert.match(recorder, /recorder\.start\(5_000\)/);
assert.match(recorder, /delayed a recording checkpoint/);
assert.match(recorder, /checkpointFailureRef/);
assert.doesNotMatch(recorder, /waitForAudibleInput/);
assert.doesNotMatch(recorder, /track\.enabled = false/);
assert.match(recorder, /if \(verified\.duration\) elapsedRef\.current = verified\.duration/);
assert.match(recorder, /did not mark this lecture as safely saved/);
assert.match(database, /new Blob\(chunks\.map\(\(chunk\) => chunk\.blob\)/);
assert.doesNotMatch(database, /decodeAudioData|OfflineAudioContext|AudioBufferSourceNode/);

// A real encoded sample must be replayable and explicitly confirmed before class.
assert.match(micTest, /lectureAudioConstraints\(\)/);
assert.match(micTest, /applyLectureAudioPreferences\(track\)/);
assert.match(micTest, /I can hear it clearly/);
assert.match(flow, /disabled=\{!micVerified\}/);
assert.match(flow, /Verify saved lecture audio/);

// Multilingual on-device transcription has stronger-to-lighter fallback, far-field
// speech preparation, and no LectureAI minute/segment quota.
assert.match(worker, /onnx-community\/whisper-small/);
assert.match(worker, /onnx-community\/whisper-base/);
assert.match(worker, /onnx-community\/whisper-tiny/);
assert.match(worker, /device: 'wasm'/);
assert.match(worker, /for \(;;\)/);
assert.match(worker, /Retrying automatically with/);
assert.match(phone, /normalizeSpeechForTranscriptionInPlace/);
assert.match(phone, /MAX_FAR_FIELD_GAIN = 16/);
assert.match(phone, /makeSpeechMonoBuffer/);
assert.match(phone, /return \{ buffer: decoded, selectedChannel: 0/);
assert.doesNotMatch(phone, /new Float32Array\(rendered\.getChannelData/);
assert.match(phone, /strongest\.rms > Math\.max\(0\.00001, second\.rms \* 3\)/);
assert.match(phone, /percentilePeak/);
assert.match(phone, /highPassCoefficient = 0\.97/);
assert.match(phone, /targetRms = 0\.05/);
assert.match(phone, /WINDOW_SECONDS = 180/);
assert.match(phone, /OVERLAP_SECONDS = 5/);
assert.match(phone, /transcribeWindowWithRecovery/);
assert.match(phone, /const modelIndexes = preferredPhoneModelStartIndex\(\) === 1 \? \[1, 2\] : \[0, 1, 2\]/);
assert.match(phone, /return isIOSDevice\(\) \? 1 : 0/);
assert.match(phone, /iosMemorySafe: isIOSDevice\(\)/);
assert.match(worker, /IOS_MEMORY_SAFE_DTYPE = \{ encoder_model: 'q8', decoder_model_merged: 'q8' \}/);
assert.match(worker, /chunk_length_s: iosMemorySafe \? 15 : 30/);
assert.match(worker, /stride_length_s: iosMemorySafe \? 3 : 5/);
assert.match(phone, /section could not be processed after automatic retries/);
assert.match(phone, /text: '\[inaudible\]'/);
assert.match(phone, /preparePhoneTranscriptionModel/);
assert.match(phone, /preparationPromise/);
assert.match(phone, /Preparing audio first to reduce iPhone\/iPad memory pressure/);
assert.match(phone, /if \(isIOS\)/);
assert.match(phone, /releasePhoneTranscriptionWorker/);
assert.match(phone, /audio\.size > 250 \* 1024 \* 1024/);
assert.doesNotMatch(phone, /250 \* 1024 \* 1024[^\n]{0,120}throw/i);
assert.doesNotMatch(transcript, /100_000|too many segments/i);
assert.doesNotMatch(transcript, /0\.86|Math\.exp\(logProbability\)/);
assert.match(transcript, /engineConfidenceIsUncalibrated/);
assert.doesNotMatch(worker, /confidence: 0/);
assert.doesNotMatch(phone, /confidence: raw\.confidence \?\? 0/);
assert.doesNotMatch(engine, /confidence_from_logprob|\"confidence\": confidence/);
assert.doesNotMatch(detail, /Math\.max\(segment\.confidence, \.9\)/);

// English is the preferred completed view when available, without forcing Whisper's language.
assert.match(detail, /completed\.englishTranslation\.length \? 'english' : 'original'/);
assert.match(detail, /Original multilingual transcript is preserved/);
assert.doesNotMatch(worker, /language:\s*['"]english['"]/i);
assert.doesNotMatch(detail, /50 MB safety limit/i);

// iPhone/iPad share sheet: file first, text fallback for targets that reject .txt/.md.
assert.match(exporter, /nav\.share/);
assert.match(exporter, /blob\.type\.startsWith\('text\/'\)/);
assert.match(exporter, /\{ title, text \}/);
assert.match(exporter, /LectureAI original recording/);

// Users can reclaim local storage manually after listening.
assert.match(detail, /Delete lecture/);
assert.match(detail, /deleteLectureData\(lecture\.id\)/);
assert.match(detail, /bookmarks, checkpoints, and attachments/);

// The removed laptop mode stays removed from the app while legacy settings migrate.
assert.doesNotMatch(app, /Maximum Accuracy/);
assert.doesNotMatch(detail, /Maximum Accuracy/);
assert.doesNotMatch(flow, /Maximum accuracy/i);
assert.match(app, /preferredMode: 'computer'/);
assert.match(app, /detectDeviceKind\(\) === 'windows' && await windowsHelperAvailable\(\)/);
assert.match(transcription, /loopback was not contacted/);
assert.match(transcription, /recordingFileExtension\(mimeType\)/);
assert.doesNotMatch(app, /Recording safely saved/);
assert.doesNotMatch(detail, /Recording safely saved/);
assert.doesNotMatch(database, /Recording safely saved/);
assert.match(database, /preferredMode === 'maximum'/);
assert.match(database, /preferredMode: 'computer'/);

// No artificial recording/import cap and Windows FFmpeg can validate transferred iOS audio.
assert.doesNotMatch(app, /8 GB local safety limit/);
assert.match(app, /no artificial recording-duration, transcript-length, segment-count, or monthly-minute quota/);
assert.match(app, /Windows helper\/FFmpeg will validate and transcribe it/);
assert.doesNotMatch(helper, /MAX_UPLOAD_BYTES|8 GB local safety limit/);
assert.match(helper, /ensure_upload_space/);
assert.match(helper, /https:\/\/lecture-ai-blush\.vercel\.app/);
assert.doesNotMatch(helper, /lectureai-ahmed\.ahmedalkadi02\.chatgpt\.site/);
assert.match(helper, /warm_configured_model/);
assert.match(helper, /load_model\(model, MODELS_DIR\)/);
assert.match(hostedLauncher, /https:\/\/lecture-ai-blush\.vercel\.app/);
assert.doesNotMatch(hostedLauncher, /lectureai-ahmed\.ahmedalkadi02\.chatgpt\.site/);

// Installed PWA and iPhone/iPad screen-safe layout.
assert.match(manifest, /"display": "standalone"/);
assert.match(manifest, /"scope": "\/"/);
assert.match(serviceWorker, /lectureai-shell-v9/);
assert.match(main, /mobile-ios\.css/);
assert.match(mobileCss, /safe-area-inset-top/);
assert.match(mobileCss, /safe-area-inset-bottom/);
assert.match(mobileCss, /\.audio-player/);
assert.match(mobileCss, /\.lecture-actions/);

console.log('✓ iPhone/iPad recording, far-field capture, encoded mic proof, unlimited-policy transcription, sharing, deletion, PWA layout, recovery, and Windows-transfer safeguards are present');
