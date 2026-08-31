import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const worker = readFileSync(new URL('../lib/phone-transcriber.worker.ts', import.meta.url), 'utf8');
const phone = readFileSync(new URL('../lib/phone-transcription.ts', import.meta.url), 'utf8');
const translationWorker = readFileSync(new URL('../lib/translation.worker.ts', import.meta.url), 'utf8');
const translation = readFileSync(new URL('../lib/translation.ts', import.meta.url), 'utf8');
const transcription = readFileSync(new URL('../lib/transcription.ts', import.meta.url), 'utf8');
const serviceWorker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

// Keep multilingual Whisper automatic: English is the main use case, but Arabic,
// Egyptian Arabic, MSA, and mixed speech must not be forced into English.
assert.match(worker, /task: 'transcribe'/);
assert.doesNotMatch(worker, /language:\s*['"]english['"]/i);
assert.match(worker, /automatic English\/Arabic language detection/);

// The encoder is quantized for faster iPhone/iPad startup while retaining the
// stronger Small -> Base -> Tiny fallback and a q4 decoder for memory pressure.
assert.match(worker, /whisper-small/);
assert.match(worker, /whisper-base/);
assert.match(worker, /whisper-tiny/);
assert.match(worker, /encoder_model: 'q8'/);
assert.match(worker, /decoder_model_merged: 'q4'/);

// Stereo/imported media becomes a mono 16 kHz transcription copy. If one channel
// is effectively dead, keep the stronger channel instead of averaging speech down.
assert.match(phone, /decoded\.numberOfChannels === 1/);
assert.match(phone, /new OfflineAudioContext\(1, outputLength, SAMPLE_RATE\)/);
assert.match(phone, /makeSpeechMonoBuffer/);
assert.match(phone, /return \{ buffer: decoded, selectedChannel: 0/);
assert.doesNotMatch(phone, /new Float32Array\(rendered\.getChannelData/);
assert.match(phone, /useStrongestOnly/);
assert.match(phone, /second\.rms \* 3/);
assert.match(phone, /MAX_FAR_FIELD_GAIN = 16/);
assert.match(phone, /percentilePeak/);

// iPhone and iPad transcription favor process survival over loading Whisper Small first.
// Audio decode and model initialization are serialized on iOS/iPadOS, and Whisper is released
// before the separate English/Arabic translation workers are created.
assert.match(phone, /return isIOSDevice\(\) \? 1 : 0/);
assert.match(phone, /preferredPhoneModelStartIndex\(\) === 1 \? \[1, 2\] : \[0, 1, 2\]/);
assert.match(phone, /Preparing audio first to reduce iPhone\/iPad memory pressure/);
assert.match(phone, /loading the memory-safer multilingual model on iPhone\/iPad/);
assert.match(worker, /IOS_MEMORY_SAFE_DTYPE = \{ encoder_model: 'q8', decoder_model_merged: 'q8' \}/);
assert.match(worker, /chunk_length_s: iosMemorySafe \? 15 : 30/);
assert.match(phone, /releasePhoneTranscriptionWorker\(\)/);
assert.match(phone, /releasing speech model memory before translation/);

// Translation stays local and lazy in a Web Worker with browser caching.
assert.match(translationWorker, /Xenova\/opus-mt-en-ar/);
assert.match(translationWorker, /Xenova\/opus-mt-ar-en/);
assert.match(translationWorker, /dtype: 'q8'/);
assert.match(translationWorker, /env\.useBrowserCache = true/);
assert.doesNotMatch(translationWorker, /fetch\(|https:\/\//);
assert.match(translation, /detectedLanguage === 'ar'/);
assert.match(translation, /detectedLanguage === 'en'/);
assert.match(translation, /detectedLanguage === 'mixed'/);
assert.match(phone, /englishTranslation/);
assert.match(phone, /arabicTranslation/);
assert.match(transcription, /englishTranslation/);
assert.match(transcription, /arabicTranslation/);

// The current PWA generation must replace the previous cached shell on installed iPhones.
assert.match(serviceWorker, /lectureai-shell-v10/);

console.log('✓ multilingual transcription, far-field stereo audio preparation, local translation, and PWA refresh safeguards are present');