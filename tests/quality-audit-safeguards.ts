import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const translation = readFileSync(new URL('../lib/translation.ts', import.meta.url), 'utf8');
const translationWorker = readFileSync(new URL('../lib/translation.worker.ts', import.meta.url), 'utf8');
const transcript = readFileSync(new URL('../lib/transcript.ts', import.meta.url), 'utf8');
const phoneWorker = readFileSync(new URL('../lib/phone-transcriber.worker.ts', import.meta.url), 'utf8');
const windowsEngine = readFileSync(new URL('../local-ai/engine.py', import.meta.url), 'utf8');
const windowsServer = readFileSync(new URL('../local-ai/server.py', import.meta.url), 'utf8');

// Mixed Arabic/English must be translated by script span instead of handing the
// entire code-switched sentence to one one-way model.
assert.match(translation, /function splitScriptRuns/);
assert.match(translation, /charScript/);
assert.match(translation, /piece\.script === 'neutral' \|\| piece\.script === target/);
assert.match(translation, /rebuildPlan/);
assert.doesNotMatch(translation, /const texts = candidates\.map/);

// Long lecture translation should be bounded in batches rather than one giant model call.
assert.match(translationWorker, /const BATCH_SIZE = 12/);
assert.match(translationWorker, /for \(let start = 0; start < texts\.length; start \+= BATCH_SIZE\)/);
assert.match(translationWorker, /await new Promise\(\(resolve\) => setTimeout\(resolve, 0\)\)/);

// ASR without diarization must not silently attribute all voices/student questions
// to the professor. Neutral labels remain editable/importable.
assert.match(windowsEngine, /"speaker": "Speaker"/);
assert.doesNotMatch(windowsEngine, /"speaker": "Professor"/);
assert.match(phoneWorker, /speaker: 'Speaker'/);
assert.doesNotMatch(phoneWorker, /speaker: 'Professor'/);
assert.match(transcript, /: 'Speaker'/);
assert.doesNotMatch(transcript, /: 'Professor'/);

// The local faster-whisper helper must not let many heavy jobs fight for the same
// RAM/GPU forever, and completed result objects must expire from memory.
assert.match(windowsServer, /transcription_slot = threading\.Semaphore\(1\)/);
assert.match(windowsServer, /JOB_RETENTION_SECONDS = 60 \* 60/);
assert.match(windowsServer, /def cleanup_jobs/);
assert.match(windowsServer, /finished_at=time\.time\(\)/);
assert.match(windowsServer, /with transcription_slot:/);
assert.match(windowsServer, /max_concurrent_transcriptions/);

console.log('✓ translation, speaker-truthfulness, and Windows helper resource safeguards are present');
