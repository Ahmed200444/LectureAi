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
const serviceWorkerRegister = readFileSync(new URL('../components/ServiceWorkerRegister.tsx', import.meta.url), 'utf8');
const recordingSession = readFileSync(new URL('../lib/recording-session.ts', import.meta.url), 'utf8');
const manifest = readFileSync(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8');
const mobileCss = readFileSync(new URL('../styles/mobile-ios.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

// Microphone truth comes from a real live track plus actual encoded/signal evidence,
// never Safari's transient MediaStreamTrack.muted flag alone.
assert.match(validation, /track\.muted/);
assert.match(validation, /verifyMicrophoneCapture/);
assert.match(validation, /waitForAudibleInput/);
assert.match(validation, /captured sample is silent/);
assert.match(validation, /decoded\.numberOfChannels/);
assert.match(validation, /selectedChannel/);
assert.match(validation, /strongest/);
assert.match(device, /iPhone\|iPod/);
assert.match(device, /touchMac/);
assert.match(device, /audio\/mp4;codecs=mp4a\.40\.2/);
assert.match(device, /MediaRecorder\.isTypeSupported/);

// The pre-class sample is encoded, replayed, and explicitly confirmed.
assert.match(micTest, /lectureAudioConstraints\(\)/);
assert.match(micTest, /applyLectureAudioPreferences\(track\)/);
assert.match(micTest, /I can hear it clearly/);
assert.match(flow, /disabled=\{!micVerified \|\| controlsBusy\}/);
assert.match(flow, /Verify saved lecture audio/);

// Recording checkpoints are progressive; transition guards prevent double start/stop.
assert.match(recorder, /recorder\.start\(5_000\)/);
assert.match(recorder, /startingRef/);
assert.match(recorder, /finishingRef/);
assert.match(recorder, /already starting or active/);
assert.match(recorder, /already finishing this recording/);
assert.match(recorder, /checkpointFailureRef/);
assert.match(recorder, /setRecordingSessionActive\(true\)/);
assert.match(recorder, /setRecordingSessionActive\(false\)/);
assert.match(flow, /RecordingOperation/);
assert.match(flow, /controlsBusy/);
assert.doesNotMatch(recorder, /track\.enabled = false/);

// A successful final save must wait for the real MediaRecorder stop event. Timeout is
// recoverable and must never be treated as permission to assemble a possibly incomplete file.
assert.match(recorder, /recorderStoppedRef\.current\.then\(\(\) => true\)/);
assert.match(recorder, /wait\(5_000\)\.then\(\(\) => false\)/);
assert.match(recorder, /did not confirm the recorder’s final stop event/);
assert.match(recorder, /kept all completed checkpoints for recovery/);
assert.match(database, /new Blob\(chunks\.map\(\(chunk\) => chunk\.blob\)/);
assert.match(recorder, /validatePlayableAudio\(blob\)/);
assert.match(recorder, /deleteAudioChunks/);

// Long sessions have no LectureAI-imposed duration quota and storage failure stays a failure.
assert.match(recorder, /audioBitsPerSecond: 192_000/);
assert.match(recorder, /delayed a recording checkpoint/);
assert.match(recorder, /did not mark this lecture as safely saved/);
assert.doesNotMatch(app, /8 GB local safety limit/);
assert.match(app, /no artificial recording-duration, transcript-length, segment-count, or monthly-minute quota/);
assert.doesNotMatch(helper, /MAX_UPLOAD_BYTES|8 GB local safety limit/);
assert.match(helper, /ensure_upload_space/);

// Multilingual browser transcription keeps automatic language handling and the existing
// stronger-to-lighter model recovery path without forcing English.
assert.match(worker, /onnx-community\/whisper-small/);
assert.match(worker, /onnx-community\/whisper-base/);
assert.match(worker, /onnx-community\/whisper-tiny/);
assert.match(worker, /device: 'wasm'/);
assert.match(phone, /normalizeSpeechForTranscriptionInPlace/);
assert.match(phone, /MAX_FAR_FIELD_GAIN = 16/);
assert.match(phone, /transcribeWindowWithRecovery/);
assert.match(phone, /return isIOSDevice\(\) \? 1 : 0/);
assert.match(worker, /IOS_MEMORY_SAFE_DTYPE/);
assert.match(worker, /chunk_length_s: iosMemorySafe \? 15 : 30/);
assert.match(phone, /text: '\[inaudible\]'/);
assert.doesNotMatch(worker, /language:\s*['"]english['"]/i);
assert.doesNotMatch(transcript, /100_000|too many segments/i);
assert.match(transcript, /engineConfidenceIsUncalibrated/);
assert.doesNotMatch(engine, /confidence_from_logprob|\"confidence\": confidence/);

// Export and deletion remain deliberate and local.
assert.match(exporter, /nav\.share/);
assert.match(exporter, /LectureAI original recording/);
assert.match(detail, /Delete lecture/);
assert.match(detail, /deleteLectureData\(lecture\.id\)/);
assert.match(detail, /bookmarks, checkpoints, and attachments/);

// Windows helper remains loopback/local and production-host aware.
assert.match(app, /detectDeviceKind\(\) === 'windows' && await windowsHelperAvailable\(\)/);
assert.match(transcription, /loopback was not contacted/);
assert.match(helper, /https:\/\/lecture-ai-blush\.vercel\.app/);
assert.match(hostedLauncher, /https:\/\/lecture-ai-blush\.vercel\.app/);

// Installed PWA: updates may download in the background but cannot auto-activate over
// an active lecture. Activation is explicit after the recording session becomes idle.
assert.match(manifest, /"display": "standalone"/);
assert.match(manifest, /"scope": "\/"/);
assert.match(serviceWorker, /lectureai-shell-v10/);
assert.match(serviceWorker, /event\.data\?\.type === 'SKIP_WAITING'/);
assert.match(serviceWorker, /self\.skipWaiting\(\)/);
assert.doesNotMatch(serviceWorker, /cache\.addAll\(CORE\)\)\.then\(\(\) => self\.skipWaiting\(\)\)/);
const serviceWorkerCode = serviceWorker.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
assert.doesNotMatch(serviceWorkerCode, /clients\.claim\(\)/);
assert.match(serviceWorkerRegister, /isRecordingSessionActive/);
assert.match(serviceWorkerRegister, /onRecordingSessionChange/);
assert.match(serviceWorkerRegister, /worker\.postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
assert.match(serviceWorkerRegister, /disabled=\{recordingActive \|\| applying\}/);
assert.match(recordingSession, /lectureai-recording-session-change/);
assert.match(main, /mobile-ios\.css/);
assert.match(mobileCss, /safe-area-inset-top/);
assert.match(mobileCss, /safe-area-inset-bottom/);

console.log('✓ production recording, encoded-audio proof, final-chunk recovery, multilingual transcription, safe PWA updates, privacy, and Windows safeguards are present');
