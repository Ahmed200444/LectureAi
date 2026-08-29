import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const recorder = readFileSync(new URL('../hooks/use-recorder.ts', import.meta.url), 'utf8');
const validation = readFileSync(new URL('../lib/audio-validation.ts', import.meta.url), 'utf8');
const worker = readFileSync(new URL('../lib/phone-transcriber.worker.ts', import.meta.url), 'utf8');
const phone = readFileSync(new URL('../lib/phone-transcription.ts', import.meta.url), 'utf8');
const flow = readFileSync(new URL('../components/RecordingFlow.tsx', import.meta.url), 'utf8');
const exporter = readFileSync(new URL('../lib/export.ts', import.meta.url), 'utf8');

assert.match(validation, /verifyMicrophoneCapture/);
assert.match(validation, /captured sample is silent/);
assert.match(recorder, /await verifyMicrophoneCapture\(stream\)/);
assert.match(recorder, /echoCancellation: true/);
assert.match(recorder, /noiseSuppression: true/);
assert.match(recorder, /audioBitsPerSecond: 160_000/);
assert.match(recorder, /recorder\.start\(5_000\)/);
assert.match(flow, /disabled=\{!micVerified\}/);
assert.match(flow, /Verify saved lecture audio/);
assert.match(worker, /whisper-small/);
assert.match(worker, /whisper-base/);
assert.match(worker, /whisper-tiny/);
assert.match(worker, /loadModel\(PRIMARY_MODEL, 'q4'\)/);
assert.match(phone, /preparePhoneTranscriptionModel/);
assert.match(phone, /audio\.size > 250 \* 1024 \* 1024/);
assert.match(exporter, /nav\.share/);

console.log('✓ iPhone/iPad recorder, transcription, PWA sharing safeguards are present');
