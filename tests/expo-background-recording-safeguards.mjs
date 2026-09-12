import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../expo-recorder/App.js', import.meta.url), 'utf8');
const root = readFileSync(new URL('../expo-recorder/Root.js', import.meta.url), 'utf8');
const appConfig = JSON.parse(readFileSync(new URL('../expo-recorder/app.json', import.meta.url), 'utf8'));
const decisionSource = readFileSync(new URL('../expo-recorder/src/background-recording.js', import.meta.url), 'utf8');
const decide = Function(`${decisionSource.replaceAll('export ', '')}\nreturn foregroundRecorderDecision;`)();

assert.equal(appConfig.expo.plugins[0][0], 'expo-audio');
assert.equal(appConfig.expo.plugins[0][1].enableBackgroundRecording, true);
assert.deepEqual(appConfig.expo.ios.infoPlist.UIBackgroundModes, ['audio']);
assert.match(root, /allowsBackgroundRecording:\s*true/);
assert.match(app, /setAudioModeAsync\(\{[^}]*allowsBackgroundRecording:\s*true/s);

const appStateStart = app.indexOf("AppState.addEventListener('change'");
const mediaResetStart = app.indexOf('recorderState.mediaServicesDidReset', appStateStart);
assert.ok(appStateStart >= 0 && mediaResetStart > appStateStart);
const appStateBlock = app.slice(appStateStart, mediaResetStart);
assert.doesNotMatch(appStateBlock, /recorder\.(?:stop|pause|prepareToRecordAsync|record)\(/, 'ordinary AppState transitions must not mutate the recorder');
assert.match(appStateBlock, /recorder\.getStatus\(\)/);
assert.match(appStateBlock, /foregroundRecorderDecision/);
assert.match(appStateBlock, /setSessionDurationMs/);
assert.match(appStateBlock, /setNativeRecordingConfirmed\(true\)/);
assert.match(appStateBlock, /setForegroundRecorderChecking\(true\)/);
assert.match(appStateBlock, /preserveUnexpectedRecorderStop/);
assert.match(app, /appStateRef\.current !== 'active'/, 'unexpected-stop watchdog must be suspended while backgrounded');
assert.match(app, /foregroundReconcileRef\.current/, 'watchdog must wait for foreground reconciliation');
assert.match(app, /foregroundRecorderChecking \? 'CHECKING RECORDER'/, 'stale hook state must not show RECORDING during reconciliation');
assert.match(app, /Math\.max\(sessionDurationMs \|\| 0, recorderState\.durationMillis \|\| 0\)/);
assert.match(app, /Stock Expo Go cannot guarantee background recording/);

// Photos, WhatsApp, Safari, Settings, then multiple switches all reconcile to
// native truth. Ordinary app names are irrelevant; microphone ownership is what matters.
for (const appName of ['Photos', 'WhatsApp', 'Safari', 'Settings', 'Photos', 'Safari']) {
  assert.equal(decide({ sessionActive: true, paused: false, statusAvailable: true, isRecording: true }), 'recording', `${appName} return should restore RECORDING when native capture continued`);
}
assert.equal(decide({ sessionActive: true, paused: true, statusAvailable: true, isRecording: false }), 'paused');
assert.equal(decide({ sessionActive: true, paused: false, statusAvailable: true, isRecording: false }), 'stopped');
assert.equal(decide({ sessionActive: true, paused: false, statusAvailable: false, isRecording: false }), 'unconfirmed');
assert.equal(decide({ sessionActive: false, paused: false, statusAvailable: true, isRecording: true }), 'idle');

console.log('✓ Expo native background recording configuration and foreground reconciliation safeguards passed');
