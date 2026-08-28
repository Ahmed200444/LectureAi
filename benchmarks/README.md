# LectureAI accuracy benchmark

LectureAI does not claim an accuracy percentage without measurements. Build a consented, private benchmark set and compare `small`, `medium`, and `large-v3` on the same original audio.

## Required conditions

Record at least three clips per condition:

- English speech
- Egyptian Arabic / Masri
- Modern Standard Arabic
- English → Egyptian Arabic switching
- Egyptian Arabic → English switching
- English technical terminology inside Arabic
- quiet professor and professor facing the board
- air conditioning, typing, chair noise, coughing, and overlapping speech
- phone on a desk in approximate rows 1–3
- phone on a desk in approximate rows 4–5

Keep names and private student speech out of a shared benchmark. Do not commit recordings or transcripts.

## Procedure

1. Make a human-verified reference transcript from the original audio.
2. Run every selected model/configuration on the exact same file.
3. Copy reference and hypothesis text into a private manifest based on `sample-manifest.json`.
4. Run `python benchmarks/evaluate.py path-to-private-manifest.json`.
5. Record Word Error Rate, Character Error Rate, technical-term errors, missed quiet speech, hallucinations, and manual-review time.
6. Prefer the configuration that performs best on the user’s real course conditions, not a generic public benchmark.

Never commit the private benchmark manifest. The repository `.gitignore` excludes `benchmarks/private/`.

## Real iPhone reliability checklist

- [ ] Test 1: phone on desk, speaker several meters away
- [ ] Test 2: approximate row 1–3 conditions
- [ ] Test 3: approximate row 4–5 conditions
- [ ] Test 4: English speech
- [ ] Test 5: Egyptian Arabic
- [ ] Test 6: mixed English/Egyptian Arabic
- [ ] Test 7: technical university terminology
- [ ] Test 8: realistic background noise
- [ ] Test 9: 60-minute recording
- [ ] Test 10: 90-minute recording
- [ ] Test 11: 120-minute recording
- [ ] Test 12: longer recording where storage/battery permit
- [ ] Test 13: force-close and recovery from saved chunks
- [ ] Test 14: timestamps, sentence seeking, highlight, and seeking sync

For every duration test, verify chunk count growth, IndexedDB usage, final audio duration, playback near the start/middle/end, bookmarks, and recovery after interruption.
