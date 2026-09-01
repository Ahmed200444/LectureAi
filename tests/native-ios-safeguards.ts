import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recorder = readFileSync(new URL('../ios/LectureAIRecorder/Sources/RecorderStore.swift', import.meta.url), 'utf8');
const recorderDelete = readFileSync(new URL('../ios/LectureAIRecorder/Sources/RecorderStore+Delete.swift', import.meta.url), 'utf8');
const preflight = readFileSync(new URL('../ios/LectureAIRecorder/Sources/MicrophonePreflightStore.swift', import.meta.url), 'utf8');
const view = readFileSync(new URL('../ios/LectureAIRecorder/Sources/ContentView.swift', import.meta.url), 'utf8');
const detail = readFileSync(new URL('../ios/LectureAIRecorder/Sources/LectureDetailView.swift', import.meta.url), 'utf8');
const lectureStore = readFileSync(new URL('../ios/LectureAIRecorder/Sources/NativeLectureStore.swift', import.meta.url), 'utf8');
const audioPreparer = readFileSync(new URL('../ios/LectureAIRecorder/Sources/TranscriptionAudioPreparer.swift', import.meta.url), 'utf8');
const project = readFileSync(new URL('../ios/LectureAIRecorder/project.yml', import.meta.url), 'utf8');

// Native recording stays local, high-quality, interruption-aware, uncapped, and neutral for lecture pickup.
assert.match(recorder, /AVAudioRecorder/);
assert.match(recorder, /setCategory\(\.record, mode: \.default\)/);
assert.doesNotMatch(recorder, /setCategory\(\.record, mode: \.videoRecording\)/);
assert.match(recorder, /setPreferredSampleRate\(48_000\)/);
assert.match(recorder, /AVSampleRateKey: 48_000\.0/);
assert.match(recorder, /AVNumberOfChannelsKey: 1/);
assert.match(recorder, /AVEncoderBitRateKey: 192_000/);
assert.match(recorder, /portType == \.builtInMic/);
assert.doesNotMatch(recorder, /setPreferredPolarPattern\(\.cardioid\)/);
assert.match(recorder, /AVAudioSession\.interruptionNotification/);
assert.match(recorder, /AVAudioSession\.routeChangeNotification/);
assert.match(recorder, /AVAudioSession\.mediaServicesWereResetNotification/);
assert.match(recorder, /UIApplication\.didEnterBackgroundNotification/);
assert.match(recorder, /\.lectureai-in-progress\.json/);
assert.match(recorder, /recoverInterruptedRecordingIfNeeded\(\)/);
assert.match(recorder, /recoverOrphanedAudioFiles\(\)/);
assert.match(recorder, /guard recorder\.record\(\)/);
assert.match(recorder, /UIApplication\.shared\.isIdleTimerDisabled/);
assert.doesNotMatch(recorder, /record\(forDuration:/);
assert.doesNotMatch(recorder, /maximumDuration|maxDuration|minuteQuota|monthlyQuota/i);

// Permission alone can never unlock a lecture. A temporary AAC sample is encoded,
// decoded from the saved file, checked for non-silent PCM, played back, and confirmed.
// The preflight busy state is set before the permission await so double taps cannot
// create competing microphone tests.
assert.match(preflight, /AVAudioRecorder/);
assert.match(preflight, /kAudioFormatMPEG4AAC/);
assert.match(preflight, /guard !isTesting else \{ return \}/);
assert.match(preflight, /isTesting = true/);
assert.match(preflight, /defer \{ isTesting = false \}/);
assert.match(preflight, /validateEncodedSample/);
assert.match(preflight, /AVAudioFile\(forReading:/);
assert.match(preflight, /peakAmplitude >= 0\.0001/);
assert.match(preflight, /sampleReady = true/);
assert.match(preflight, /func playSample\(\)/);
assert.match(preflight, /func confirmAudibleSample\(\)/);
assert.match(preflight, /Microphone verified with real encoded, audible audio/);
assert.match(preflight, /reason == \.categoryChange/);
assert.match(preflight, /Audio route changed · test the microphone again before recording/);
assert.match(view, /guard preflight\.verified, !startingNativeRecording else \{ return \}/);
assert.match(view, /startingNativeRecording = true/);
assert.match(view, /Task \{ @MainActor in/);
assert.match(view, /disabled\(transcriptionActive \|\| !preflight\.verified[\s\S]*startingNativeRecording\)/);
assert.match(view, /I can hear it clearly/);
assert.match(view, /real encoded sample/);

// The unified app owns import, background capture, playback, deletion confirmation, and lecture opening.
assert.match(view, /Import recording/);
assert.match(view, /Locking the screen or switching apps does not intentionally stop the recorder/);
assert.match(view, /Open lecture/);
assert.match(view, /confirmationDialog\(/);
assert.match(view, /deleteSafely\(item\)/);
assert.doesNotMatch(view, /lecture-ai-blush\.vercel\.app/);
assert.match(recorderDelete, /Could not delete the original recording\. Nothing else was removed/);

// Native transcription uses pinned WhisperKit, file-based incremental loading, multilingual detection,
// no forced language, and never the live streaming transcriber or an English-only hard-coded model.
assert.match(lectureStore, /import WhisperKit/);
assert.match(lectureStore, /WhisperKit\.recommendedModels\(\)\.default/);
assert.match(lectureStore, /task: \.transcribe/);
assert.match(lectureStore, /language: nil/);
assert.match(lectureStore, /detectLanguage: true/);
assert.match(lectureStore, /audioLoadingMode: \.incremental/);
assert.match(lectureStore, /suppressTokens: \[\]/);
assert.match(lectureStore, /concurrentWorkerCount: 1/);
assert.doesNotMatch(lectureStore, /AudioStreamTranscriber/);
assert.doesNotMatch(lectureStore, /whisper-[^"\n]*\.en/);

// Compressed originals are preserved; transcription works from a temporary 16 kHz mono copy.
assert.match(audioPreparer, /sampleRate = 16_000\.0/);
assert.match(audioPreparer, /outputChannels: AVAudioChannelCount = 1/);
assert.match(audioPreparer, /static func cleanup\(/);
assert.match(detail, /The original audio is never modified by transcription or translation/);
assert.match(detail, /translationTask\(/);

// User-controlled exports remain local until the iOS share/save sheet is invoked.
assert.match(detail, /LectureTextExport: Transferable/);
assert.match(detail, /FileRepresentation\(exportedContentType: \.plainText\)/);
assert.match(detail, /Export recording/);
assert.match(detail, /Export transcript/);
assert.match(detail, /Export notes/);
assert.match(detail, /LectureAI transcript/);
assert.match(detail, /NativeNotesGenerator\.timestamp\(segment\.startTime\)/);
assert.match(detail, /LectureAI notes/);

// Project-level iPhone/iPad and background-audio configuration.
assert.match(project, /NSMicrophoneUsageDescription/);
assert.match(project, /UIBackgroundModes:/);
assert.match(project, /- audio/);
assert.match(project, /iOS: "17\.0"/);
assert.match(project, /TARGETED_DEVICE_FAMILY: "1,2"/);
assert.match(project, /exactVersion: 1\.1\.0/);
assert.match(project, /product: WhisperKit/);

console.log('✓ unified native LectureAI safeguards are present');
