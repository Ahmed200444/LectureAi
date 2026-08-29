# Mobile acceptance matrix

Do not claim a microphone or accuracy pass until the physical device test is completed. Automated CI verifies code paths; real iPhone/iPad hardware verifies microphone routing, PWA behavior, and OS share destinations.

## Recording / PWA
- iPhone Safari: mic sample playback confirmed; long recording checkpoints; finish/reload/playback verified.
- iPhone installed PWA: same checks; keep app visible; verify update banner/reload.
- iPad Safari: same checks.
- iPad installed PWA: same checks.
- Confirm the 12-second mic test and the real lecture use the same clean capture profile: mono preference, AGC off, noise suppression off, echo cancellation off where iOS/iPadOS honors those preferences.
- Verify speech is continuous with no pumping, clipping, repeated micro-cutouts, or false “microphone muted” state.
- Pause/continue: confirm live audio returns and the same lecture is extended.
- Low storage: warning appears without an artificial LectureAI time limit.
- Backgrounding: warning appears; do not promise uninterrupted iOS background recording.

## Distance / classroom placement
- Test close speech and realistic professor distance separately.
- Rows 1–3: phone/iPad on desk, normal professor speaking level, normal classroom noise.
- Rows 4–5: same test with lower speech level and realistic room reflections.
- Confirm the original saved recording remains natural and intelligible; do not alter the source audio to chase transcription accuracy.
- Confirm the disposable transcription copy reports/uses capped quiet-speech normalization when appropriate.
- Include one test where the professor turns away or walks several metres farther from the device.
- Include one test with HVAC/projector noise so normalization does not simply amplify background noise into clipping.

## Sharing / transfer
- Share original .m4a/.mp4/.webm via iOS/iPadOS share sheet to AirDrop, Files, Gmail, WhatsApp when those destinations accept the file.
- Share transcript .txt through the same system share sheet.
- Transfer iPhone/iPad recording to Windows, import it, preserve the original, and run Maximum Accuracy.
- Verify Windows helper/media decoder can handle a transferred file even when the browser preview decoder cannot.

## Transcription reliability
- Prepare/cache the multilingual phone/iPad model before class.
- Confirm Small is preferred, with automatic Base/Tiny fallback when the stronger model cannot initialize or finish inference.
- Test a normal short recording, a 30–60 minute lecture, and the longest practical lecture the test device can process.
- Force/reproduce a model-memory failure if possible and verify the original recording remains safe and a useful recovery message is shown.
- Verify no transcript job creates a duplicate lecture record.

## Transcription quality
Evaluate English, Egyptian Arabic (Masri), MSA, English technical terms inside Arabic, and code-switching. Include rows 1–3, rows 4–5, and realistic classroom noise. Measure WER/CER/manual review separately for phone/iPad and Windows. Never publish an accuracy percentage without measurements.

## Long sessions
LectureAI has no application-imposed recording duration or monthly-minute quota. Practical limits are free device/browser storage, battery, iOS/iPadOS suspension behavior, and available RAM for on-device model inference. Original audio remains the source of truth.
