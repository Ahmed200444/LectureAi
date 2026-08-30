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
assert.match(flow, /Finish & save recovered recording/);
assert.match(flow, /Microphone session ended — the audio already checkpointed is preserved/);
assert.match(flow, /Finish & save/);
assert.doesNotMatch(flow, />Stop recording</);
assert.doesNotMatch(flow, /Continue current recording/);

console.log('✓ recording interruption/finalization safeguards are present');
