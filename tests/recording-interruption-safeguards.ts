import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recorder = readFileSync(new URL('../hooks/use-recorder.ts', import.meta.url), 'utf8');
const flow = readFileSync(new URL('../components/RecordingFlow.tsx', import.meta.url), 'utf8');

assert.match(recorder, /const \[isInterrupted, setIsInterrupted\]/);
assert.match(recorder, /track\.addEventListener\('ended'/);
assert.match(recorder, /Your saved checkpoints are preserved — finish and save this lecture now/);
assert.match(recorder, /if \(recorder\.state !== 'inactive'\)/);
assert.match(recorder, /Promise\.race\(\[recorderStoppedRef\.current, wait\(1_200\)\]\)/);
assert.match(recorder, /finalizeAudio\(lectureIdRef\.current/);
assert.match(recorder, /document\.visibilityState === 'hidden'/);
assert.match(recorder, /window\.addEventListener\('pagehide'/);
assert.match(recorder, /recorder\.requestData\(\)/);

// Long visible recordings get an independent health watchdog. Distance/silence is
// only an audio-quality warning and must never be treated as a recording failure.
assert.match(recorder, /healthIntervalRef/);
assert.match(recorder, /Distance, silence, and low audio level are deliberately NOT failure signals/);
assert.match(recorder, /Quiet\/far-away speech is never a stop condition/);
assert.match(recorder, /Audio is very quiet\. Recording is still running/);
assert.match(recorder, /currentTrack\.readyState !== 'live'/);
assert.match(recorder, /checkpointAge > 12_000/);
assert.match(recorder, /requested an immediate recovery checkpoint/);
assert.match(recorder, /document\.visibilityState === 'visible' && !wakeLockRef\.current/);
assert.doesNotMatch(recorder, /rms\s*<[^\n]+\n[^\n]*(?:recorder\.stop|recorder\.pause|track\.stop|track\.enabled\s*=\s*false)/);

// Pause/continue must stay inside the same MediaRecorder and microphone session.
// Pausing flushes a checkpoint but never stops or disables the microphone track;
// resuming revalidates the live stream and restarts timing/checkpoint health.
const pauseStart = recorder.indexOf('const pause = useCallback');
const resumeStart = recorder.indexOf('const resume = useCallback');
const stopStart = recorder.indexOf('const stop = useCallback');
assert.ok(pauseStart >= 0 && resumeStart > pauseStart && stopStart > resumeStart);
const pauseBlock = recorder.slice(pauseStart, resumeStart);
const resumeBlock = recorder.slice(resumeStart, stopStart);
assert.match(pauseBlock, /recorder\.requestData\(\)/);
assert.match(pauseBlock, /recorder\.pause\(\)/);
assert.match(pauseBlock, /Promise\.allSettled\(Array\.from\(pendingWritesRef\.current\)\)/);
assert.doesNotMatch(pauseBlock, /\.stop\(\)/);
assert.doesNotMatch(pauseBlock, /\.enabled\s*=/);
assert.match(resumeBlock, /assertLiveMicrophoneStream\(stream\)/);
assert.match(resumeBlock, /recorder\.resume\(\)/);
assert.match(resumeBlock, /activeStartedRef\.current = Date\.now\(\)/);
assert.match(resumeBlock, /lastChunkAtRef\.current = Date\.now\(\)/);
assert.match(resumeBlock, /requestWakeLock\(\)/);
assert.doesNotMatch(resumeBlock, /\.stop\(\)/);
assert.doesNotMatch(resumeBlock, /\.enabled\s*=/);

assert.match(flow, /Pause recording/);
assert.match(flow, /Continue recording/);
assert.match(flow, /same microphone session/);
assert.match(flow, /Finish & save recovered recording/);
assert.match(flow, /Microphone session ended — the audio already checkpointed is preserved/);
assert.match(flow, /Finish & save/);
assert.doesNotMatch(flow, />Stop recording</);

console.log('✓ recording interruption, long-session watchdog, pause/continue, and finalization safeguards are present');
