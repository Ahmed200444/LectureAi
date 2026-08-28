# Mobile acceptance matrix

Do not claim a microphone or accuracy pass until the physical device test is completed. Automated CI verifies code paths; real iPhone/iPad hardware verifies microphone routing, PWA behavior, and OS share destinations.

## Recording / PWA
- iPhone Safari: mic sample playback confirmed; long recording checkpoints; finish/reload/playback verified.
- iPhone installed PWA: same checks; keep app visible; verify update banner/reload.
- iPad Safari: same checks.
- iPad installed PWA: same checks.
- Pause/continue: confirm live audio returns and the same lecture is extended.
- Low storage: warning appears without an artificial LectureAI time limit.
- Backgrounding: warning appears; do not promise uninterrupted iOS background recording.

## Sharing / transfer
- Share original .m4a/.mp4/.webm via iOS/iPadOS share sheet to AirDrop, Files, Gmail, WhatsApp when those destinations accept the file.
- Share transcript .txt through the same system share sheet.
- Transfer iPhone/iPad recording to Windows, import it, preserve the original, and run Maximum Accuracy.
- Verify Windows helper/FFmpeg can handle a transferred file even when the browser preview decoder cannot.

## Transcription quality
Evaluate English, Egyptian Arabic (Masri), MSA, English technical terms inside Arabic, and code-switching. Include rows 1–3, rows 4–5, and realistic classroom noise. Measure WER/CER/manual review separately for phone/iPad and Windows. Never publish an accuracy percentage without measurements.

## Long sessions
LectureAI has no application-imposed recording duration or monthly-minute quota. Practical limits are free device/browser storage, battery, iOS/iPadOS suspension behavior, and available RAM for on-device model inference. Original audio remains the source of truth.
