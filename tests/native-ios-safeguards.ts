import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const recorder = readFileSync(new URL('../ios/LectureAIRecorder/Sources/RecorderStore.swift', import.meta.url), 'utf8');
const view = readFileSync(new URL('../ios/LectureAIRecorder/Sources/ContentView.swift', import.meta.url), 'utf8');
const project = readFileSync(new URL('../ios/LectureAIRecorder/project.yml', import.meta.url), 'utf8');

const importButtons = app.match(/<button className=\"secondary-button\" onClick=\{onImport\}><Upload size=\{17\} \/> Import recording<\/button>/g) || [];
assert.equal(importButtons.length, 2, 'Home and Lectures must both expose Import recording on iPhone/iPad and Windows');
assert.doesNotMatch(app, /detectDeviceKind\(\) === 'windows' && <button className=\"secondary-button\" onClick=\{onImport\}/);

assert.match(recorder, /AVAudioRecorder/);
assert.match(recorder, /setCategory\(\.record, mode: \.videoRecording\)/);
assert.match(recorder, /setPreferredSampleRate\(48_000\)/);
assert.match(recorder, /AVSampleRateKey: 48_000\.0/);
assert.match(recorder, /AVNumberOfChannelsKey: 1/);
assert.match(recorder, /AVEncoderBitRateKey: 192_000/);
assert.match(recorder, /portType == \.builtInMic/);
assert.match(recorder, /orientation == \.front/);
assert.match(recorder, /supportedPolarPatterns\?\.contains\(\.cardioid\)/);
assert.match(recorder, /AVAudioSession\.interruptionNotification/);
assert.match(recorder, /AVAudioSession\.routeChangeNotification/);
assert.match(recorder, /AVAudioSession\.mediaServicesWereResetNotification/);
assert.match(recorder, /recorder\.pause\(\)/);
assert.match(recorder, /guard recorder\.record\(\)/);
assert.match(recorder, /UIApplication\.shared\.isIdleTimerDisabled/);
assert.doesNotMatch(recorder, /record\(forDuration:/);
assert.doesNotMatch(recorder, /maximumDuration|maxDuration|minuteQuota|monthlyQuota/i);

assert.match(view, /Pause/);
assert.match(view, /Continue recording/);
assert.match(view, /Finish & save/);
assert.match(view, /Quiet or distant audio never stops the recorder/);
assert.match(view, /ShareLink\(item: recording\.audioURL\)/);
assert.match(view, /lecture-ai-blush\.vercel\.app/);

assert.match(project, /NSMicrophoneUsageDescription/);
assert.match(project, /UIBackgroundModes:/);
assert.match(project, /- audio/);
assert.match(project, /iOS: "17\.0"/);

console.log('✓ native iPhone recorder safeguards are present');
