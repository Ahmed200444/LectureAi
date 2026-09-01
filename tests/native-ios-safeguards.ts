import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recorder = readFileSync(new URL('../ios/LectureAIRecorder/Sources/RecorderStore.swift', import.meta.url), 'utf8');
const recorderDelete = readFileSync(new URL('../ios/LectureAIRecorder/Sources/RecorderStore+Delete.swift', import.meta.url), 'utf8');
const preflight = readFileSync(new URL('../ios/LectureAIRecorder/Sources/MicrophonePreflightStore.swift', import.meta.url), 'utf8');
const view = readFileSync(new URL('../ios/LectureAIRecorder/Sources/ContentView.swift', import.meta.url), 'utf8');
const app = readFileSync(new URL('../ios/LectureAIRecorder/Sources/LectureAIRecorderApp.swift', import.meta.url), 'utf8');
const recoveryView = readFileSync(new URL('../ios/LectureAIRecorder/Sources/RecoveryResolutionView.swift', import.meta.url), 'utf8');
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

// Locking the iPhone/iPad sends the app to background. The background handler may persist
// its recovery checkpoint, but it must never pause/stop the recorder, deactivate the audio
// session, or mutate the recording state. Together with UIBackgroundModes=audio, this is
// the code/configuration gate that allows an active native recording to continue with the
// screen locked, subject only to normal iOS interruptions or the app/device being terminated.
const backgroundStart = recorder.indexOf('@objc private func handleDidEnterBackground');
const terminateStart = recorder.indexOf('@objc private func handleWillTerminate', backgroundStart);
assert.ok(backgroundStart >= 0 && terminateStart > backgroundStart, 'Background lifecycle handlers must remain present');
const backgroundHandler = recorder.slice(backgroundStart, terminateStart);
assert.match(backgroundHandler, /persistInProgressCheckpoint\(\)/);
assert.doesNotMatch(backgroundHandler, /\.stop\(\)|\.pause\(\)|deactivateAudioSession\(\)|setActive\(false|state\s*=(?!=)/);

// RecorderStore itself owns a MainActor startup gate before the first await. The UI also
// flips its immediate guard before creating the Task, so both data and presentation layers
// reject duplicate Start taps during permission/session setup.
assert.match(recorder, /@Published private\(set\) var isStartingRecording = false/);
assert.match(recorder, /@MainActor\s+func startRecording\(\) async/);
assert.match(recorder, /guard !isStartingRecording,[\s\S]*state != \.interrupted else \{ return \}/);
assert.match(recorder, /isStartingRecording = true/);
assert.match(recorder, /defer \{ isStartingRecording = false \}/);
assert.match(view, /guard preflight\.verified,[\s\S]*!recorder\.isStartingRecording,[\s\S]*!recorder\.hasUnresolvedRecovery else \{ return \}/);
assert.match(view, /startingNativeRecording = true/);
assert.match(view, /Task \{ @MainActor in/);

// Interrupted-file recovery is truthful in both launch and live-save paths. A nonzero but
// undecodable AAC is never promoted to a normal lecture, and metadata failure cannot erase
// the only checkpoint carrying its title/marks.
assert.match(recorder, /@Published private\(set\) var hasUnresolvedRecovery = false/);
assert.match(recorder, /@Published private\(set\) var unresolvedRecoveryURL: URL\?/);
assert.match(recorder, /guard let decodedDuration = audioDuration\(at: url\) else/);
assert.doesNotMatch(recorder, /audioDuration\(at: url\) \?\? lastKnownDuration/);
assert.match(recorder, /guard let recoveredDuration = audioDuration\(at: audioURL\) else/);
assert.doesNotMatch(recorder, /audioDuration\(at: audioURL\) \?\? checkpoint\.lastKnownDuration/);
assert.match(recorder, /guard saveMetadata\(item\) else/);
assert.match(recorder, /hasUnresolvedRecovery = true/);
assert.match(recorder, /unresolvedRecoveryURL = url/);
assert.match(recorder, /unresolvedRecoveryURL = audioURL/);
assert.match(view, /recorder\.hasUnresolvedRecovery/);

// A preserved undecodable capture can never permanently trap the user. It is exposed only
// through an explicit recovery gate with export, retry, and confirmed discard controls.
assert.match(recorder, /func retryUnresolvedRecovery\(\)/);
assert.match(recorder, /func discardUnresolvedRecovery\(\)/);
assert.match(app, /if recorder\.hasUnresolvedRecovery/);
assert.match(app, /RecoveryResolutionView\(\)/);
assert.match(recoveryView, /ShareLink\(item: url\)/);
assert.match(recoveryView, /Export preserved audio/);
assert.match(recoveryView, /Retry recovery/);
assert.match(recoveryView, /Discard preserved recovery/);
assert.match(recoveryView, /confirmationDialog\(/);
assert.match(recoveryView, /Nothing is deleted automatically/);

// Permission alone can never unlock a lecture. A temporary AAC sample is encoded,
// decoded from the saved file, checked for non-silent PCM, played fully, and confirmed.
// The preflight busy state is set before the permission await so double taps cannot
// create competing microphone tests.
assert.match(preflight, /AVAudioRecorder/);
assert.match(preflight, /kAudioFormatMPEG4AAC/);
assert.match(preflight, /guard !isTesting else \{ return \}/);
assert.match(preflight, /isTesting = true/);
assert.match(preflight, /private var activeTestID: UUID\?/);
assert.match(preflight, /activeTestID = testID/);
assert.match(preflight, /ensureActiveTest\(testID\)/);
assert.match(preflight, /validateEncodedSample/);
assert.match(preflight, /AVAudioFile\(forReading:/);
assert.match(preflight, /peakAmplitude >= 0\.0001/);
assert.match(preflight, /sampleReady = true/);
assert.match(preflight, /@Published private\(set\) var samplePlaybackCompleted = false/);
assert.match(preflight, /func playSample\(\)/);
assert.match(preflight, /samplePlaybackCompleted = false/);
assert.match(preflight, /audioPlayerDidFinishPlaying/);
assert.match(preflight, /samplePlaybackCompleted = true/);
assert.match(preflight, /guard sampleReady, samplePlaybackCompleted else \{ return \}/);
assert.match(preflight, /Microphone verified with real encoded, audible audio/);
assert.match(preflight, /reason == \.categoryChange/);
assert.match(preflight, /if isTesting \{[\s\S]*activeTestID = nil[\s\S]*testRecorder\?\.stop\(\)/);
assert.match(preflight, /Audio route changed during the microphone test/);
assert.doesNotMatch(preflight, /func resetForRouteChange\(\) \{\s*guard !isTesting else \{ return \}/);
assert.match(view, /!preflight\.samplePlaybackCompleted/);
assert.match(view, /Listen fully first/);
assert.match(view, /successfully plays that saved sample to completion/);

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
