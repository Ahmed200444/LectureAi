import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const translation = readFileSync(new URL('../lib/translation.ts', import.meta.url), 'utf8');
const translationWorker = readFileSync(new URL('../lib/translation.worker.ts', import.meta.url), 'utf8');
const transcript = readFileSync(new URL('../lib/transcript.ts', import.meta.url), 'utf8');
const phoneWorker = readFileSync(new URL('../lib/phone-transcriber.worker.ts', import.meta.url), 'utf8');
const windowsEngine = readFileSync(new URL('../local-ai/engine.py', import.meta.url), 'utf8');
const windowsServer = readFileSync(new URL('../local-ai/server.py', import.meta.url), 'utf8');

assert.match(translation, /function splitScriptRuns/);
assert.match(translation, /charScript/);
assert.match(translation, /piece\.script === 'neutral' \|\| piece\.script === target/);
assert.match(translation, /preserveMixedEnglish/);
assert.match(translation, /target === 'ar' && segment\.detectedLanguage === 'mixed'/);
assert.match(translation, /preserveMixedEnglish && piece\.script === 'en'/);
assert.match(translation, /rebuildPlan/);
assert.doesNotMatch(translation, /const texts = candidates\.map/);

assert.match(translationWorker, /const BATCH_SIZE = 12/);
assert.match(translationWorker, /for \(let start = 0; start < texts\.length; start \+= BATCH_SIZE\)/);
assert.match(translationWorker, /await new Promise\(\(resolve\) => setTimeout\(resolve, 0\)\)/);

assert.match(windowsEngine, /"speaker": "Speaker"/);
assert.doesNotMatch(windowsEngine, /"speaker": "Professor"/);
assert.match(windowsEngine, /"language": detected_language/);
assert.match(windowsEngine, /"language_scope": "lecture"/);
assert.match(phoneWorker, /speaker: 'Speaker'/);
assert.doesNotMatch(phoneWorker, /speaker: 'Professor'/);
assert.match(transcript, /: 'Speaker'/);
assert.doesNotMatch(transcript, /: 'Professor'/);

assert.match(windowsServer, /transcription_slot = threading\.Semaphore\(1\)/);
assert.match(windowsServer, /JOB_RETENTION_SECONDS = 60 \* 60/);
assert.match(windowsServer, /def cleanup_jobs/);
assert.match(windowsServer, /finished_at=time\.time\(\)/);
assert.match(windowsServer, /with transcription_slot:/);
assert.match(windowsServer, /max_concurrent_transcriptions/);

console.log('✓ code-switch translation, speaker truthfulness, language metadata, and Windows helper resource safeguards are present');
