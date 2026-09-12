# LectureAI accuracy benchmark

LectureAI does **not** claim an accuracy percentage without measurements. Build a consented, private benchmark set and compare the relevant model/configurations on the exact same original audio.

`sample-manifest.json` is a **schema example only**. Its `hypothesis` is intentionally blank, so `evaluate.py` refuses to score it. Never present a score from the sample file as measured LectureAI performance.

## Required conditions

Record at least three clips per condition, and preferably more once the workflow is stable:

- English speech;
- Egyptian Arabic / Masri;
- Modern Standard Arabic;
- English → Egyptian Arabic switching;
- Egyptian Arabic → English switching;
- English technical terminology inside Arabic;
- numbers, dates, equations, acronyms, API/class/function names, and proper technical terminology;
- quiet professor and professor facing the board;
- air conditioning, typing, chair noise, coughing, and overlapping speech;
- phone on a desk in approximate rows 1–3;
- phone on a desk in approximate rows 4–5.

Keep names and private student speech out of a shared benchmark. Do not commit recordings or private reference transcripts.

## Private manifest fields

Each record supports:

- `model`: model/build identifier, for example `large-v3` or an Expo/on-device model name;
- `language`: benchmark language bucket such as `en`, `msa`, `egyptian-ar`, or `en-egyptian-ar-code-switch`;
- `condition`: placement/noise condition such as `row-1-3`, `row-4-5`, `hvac`, or `professor-facing-away`;
- `reference`: human-verified transcript from the original audio;
- `hypothesis`: the **real** model transcript for the same clip;
- `technical_terms`: optional list of exact important terms that should be preserved, such as `pointer`, `Dijkstra`, `eigenvalue`, or `memory address`;
- `manual_review_seconds`: optional measured time needed to turn the model output into a trusted transcript;
- `hallucination_count`: optional manually counted unsupported/invented spans for the clip;
- `notes`: optional private testing notes.

Example structure:

```json
[
  {
    "model": "large-v3",
    "language": "en-egyptian-ar-code-switch",
    "condition": "row-1-3",
    "reference": "human-verified transcript here",
    "hypothesis": "real model transcript here",
    "technical_terms": ["pointer", "memory address"],
    "manual_review_seconds": 21.4,
    "hallucination_count": 0
  }
]
```

## Procedure

1. Record one original clip and keep that exact file immutable.
2. Make a careful human-verified reference transcript while listening to the source audio.
3. Run every selected model/configuration on the **same file**.
4. Put the real reference and model hypothesis into a private manifest based on `sample-manifest.json`.
5. Record technical terms that matter for the class. Where practical, time how long manual correction takes and count obvious hallucinated spans.
6. Run:

```text
python benchmarks/evaluate.py path-to-private-manifest.json
```

7. Compare the results by language and classroom condition rather than collapsing everything into one flattering percentage.
8. Prefer the configuration that works best on the user's real course conditions, not merely a generic public benchmark.

Never commit the private benchmark manifest. The repository `.gitignore` excludes `benchmarks/private/`.

## Metrics reported

The evaluator reports:

- **WER** — strict normalized Word Error Rate;
- **CER** — strict normalized Character Error Rate;
- **ArabicNormWER / ArabicNormCER** — a second Arabic-friendly view that removes Arabic diacritics/tatweel, normalizes common Alef/Ya variants, and normalizes Arabic/Persian digits before scoring;
- **TechTermRecall** — fraction of explicitly listed technical terms found in the hypothesis;
- **NumberRecall** — fraction of numeric expressions from the reference preserved in the hypothesis;
- **AvgReviewSec** — average manual correction/review time when supplied;
- **AvgHallucinations** — average manually counted hallucinated spans when supplied.

The Arabic-normalized metrics are **additional diagnostics**, not a replacement for strict WER/CER. They help distinguish meaningful recognition errors from some orthographic variation. They also do not prove semantic correctness.

Technical-term and number recall are deliberately separate because a transcript can have an acceptable overall WER while still getting the exact exam-relevant term, variable, date, or number wrong.

## What not to call “accuracy”

Do not turn `1 - WER` into a universal LectureAI accuracy percentage and publish it as if it covered every language, classroom, device, and lecture. WER, CER, technical-term preservation, hallucinations, missed quiet speech, and correction time answer different questions.

A useful release report should instead say something like:

- which device and microphone placement were tested;
- which model/build was used;
- number and duration of clips;
- English/Masri/MSA/code-switch results separately;
- strict and Arabic-normalized WER/CER;
- technical-term/number preservation;
- hallucination observations;
- median/average human correction time.

## Real iPhone / Expo Go reliability checklist

For the Expo Go target, recording reliability must be tested separately from transcription quality. Automated bundling cannot prove real microphone routing or long-session survival.

- [ ] Test 1: phone on desk, speaker several meters away
- [ ] Test 2: approximate row 1–3 conditions
- [ ] Test 3: approximate row 4–5 conditions
- [ ] Test 4: English speech
- [ ] Test 5: Egyptian Arabic
- [ ] Test 6: MSA
- [ ] Test 7: mixed English/Egyptian Arabic
- [ ] Test 8: technical university terminology and numbers
- [ ] Test 9: realistic background noise
- [ ] Test 10: short recording + pause/continue + marks + playback confirmation
- [ ] Test 11: reopen Expo Go and confirm the lecture remains in the local library
- [ ] Test 12: Share / Save to Files and re-open the exported original
- [ ] Test 13: 30-minute recording
- [ ] Test 14: 60-minute recording
- [ ] Test 15: 90-minute recording
- [ ] Test 16: 120-minute recording where storage/battery permit
- [ ] Test 17: interruption / media-services-reset behavior where reproducible
- [ ] Test 18: deliberately background Expo Go and confirm the app warns rather than promising background reliability
- [ ] Test 19: delete a test lecture and confirm its original document file and metadata are removed

For every long-duration test, verify final duration, file size growth, playback near the start/middle/end, marked moments, reopen persistence, and export of the preserved original.

## Web/PWA regression checklist

The stable web/PWA recorder still uses checkpoint recovery. For its duration tests, verify checkpoint count growth, IndexedDB usage, final audio duration, start/middle/end playback validation, bookmarks, and recovery after interruption.

## Release gate

Do not publish an accuracy percentage or call the unified Expo build production-ready until the relevant physical-device and human-verified benchmark rows are complete. The original audio remains the source of truth throughout testing.
