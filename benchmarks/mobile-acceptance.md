# Mobile acceptance matrix

Do not claim a microphone, recording, translation, or accuracy pass until the physical device test is completed. Automated CI verifies code paths; real iPhone/iPad hardware verifies microphone routing, Safari/PWA behavior, Expo Go behavior, OS share destinations, and practical memory limits.

## Recording / stable web PWA
- iPhone Safari: mic sample playback confirmed; long recording checkpoints; finish/reload/playback verified.
- iPhone installed PWA: same checks; keep app visible; verify update banner/reload.
- iPad Safari: same checks.
- iPad installed PWA: same checks.
- Confirm the installed app upgrades to the current service-worker shell and does not keep an older recorder/transcription bundle cached.
- Confirm the installed app keeps navigation, lecture actions, recording header, toast messages, and the fixed audio player clear of the notch/status area and Home indicator in portrait and landscape.
- Confirm the 12-second mic test and the real lecture use the same current capture preferences: mono/48 kHz preference, echo cancellation off where supported, and iOS/iPadOS AGC + noise suppression preferred for far-field classroom speech.
- Read the granted capture settings shown by the mic test. Record what iOS/iPadOS actually grants instead of claiming unsupported constraints were enforced.
- Verify speech is continuous with no pumping, whooshing/swish, clipping, repeated micro-cutouts, or false “microphone muted” state.
- Pause/continue: confirm live audio returns and the same lecture is extended.
- Low storage: warning appears without an artificial LectureAI time limit.
- Backgrounding: warning appears; do not promise uninterrupted iOS web background recording.

## Recording / Expo Go target
- Run the complete `expo-recorder/README.md` acceptance gate on the same iPhone/iPad models used for classroom recording.
- Verify the Expo project opens in the current App Store Expo Go build and does not require Safari for recording.
- 20-second test: start → meter movement → mark → pause → continue → finish → permanent document copy → playback.
- Close/reopen Expo Go, reopen the LectureAI project, and confirm the saved lecture metadata and original audio still exist and play.
- Confirm the app does not call audio verified until the user has actually listened and selected the playback-confirmation control.
- Confirm current input/routing with built-in mic, Bluetooth connected/disconnected, and wired input where available.
- Trigger or simulate an iOS audio-services/interruption event where practical and record the resulting behavior.
- Keep Expo Go visible during important tests. Stock Expo Go cannot apply LectureAI-specific background-audio native configuration, so locked-screen/background recording is not a pass requirement and must not be promised.
- Verify 30, 60, 90, and 120 minute recordings as battery/storage permit, including file size, duration, reopen persistence, marks, playback near start/middle/end, and share to Files.
- Verify low-storage warning from real available disk space.

## Distance / classroom placement
- Test close speech and realistic professor distance separately.
- Rows 1–3: phone/iPad on desk, normal professor speaking level, normal classroom noise.
- Rows 4–5: same test with lower speech level and realistic room reflections.
- Confirm the original saved recording remains natural and intelligible; do not alter the source audio to chase transcription accuracy.
- Confirm the disposable web transcription copy reports/uses capped quiet-speech normalization when appropriate.
- Include one test where the professor turns away or walks several metres farther from the device.
- Include one test with HVAC/projector noise so normalization does not simply amplify background noise into clipping.

## Sharing / transfer
- Share original `.m4a`/`.mp4`/`.webm` via iOS/iPadOS share sheet to AirDrop, Files, Gmail, WhatsApp when those destinations accept the file.
- Share transcript `.txt` through the stable web system share sheet.
- If a share target rejects the transcript file attachment, verify the stable web client offers/shares the transcript body as plain text before falling back to a local download.
- From Expo, verify Share / Save to Files opens the iOS share sheet for the preserved original file.
- Transfer an iPhone/iPad recording to Windows, import it, preserve the original, and choose Transcribe on Computer.
- Verify Windows helper/media decoder can handle a transferred file even when the browser preview decoder cannot.
- Launch `start-helper-for-hosted-site.bat` and confirm it opens `https://lecture-ai-blush.vercel.app`, reports the computer transcription helper as ready, and can create a transcription job from the hosted page.
- Confirm the helper accepts the Vercel origin and uses available disk space rather than a fixed LectureAI upload-size quota.
- Do not expose the loopback helper to the LAN merely to support Expo transfer; future wireless transfer requires explicit authenticated pairing first.

## Storage cleanup / deletion
- Stable web: after listening to a completed lecture on iPhone, tap Delete lecture, confirm once, and verify the lecture disappears from the library.
- Repeat stable web deletion on iPad.
- Verify the original audio, transcript/notes/bookmarks stored in the lecture record, checkpoint chunks, and attachments are removed from stable web local storage together.
- Re-open the stable web library after deletion and confirm the deleted lecture does not reappear or get reseeded.
- Compare `navigator.storage.estimate()` before and after deleting a large stable web test lecture when the browser exposes it. iOS/iPadOS may update its system-wide storage display later, so do not require an immediate Settings-app number change.
- Expo: delete a lecture and verify both its document audio file and SQLite-backed lecture metadata are removed.
- Confirm neither client automatically deletes a lecture after playback; deletion must remain an explicit user action.

## Stable web transcription reliability
- Prepare/cache the multilingual iPhone/iPad model before class.
- On iPhone/iPad, confirm **audio preparation completes before Whisper model warm-up begins**. This serialization is deliberate to reduce simultaneous WebKit memory pressure.
- Repeat transcription in the same app session and confirm reusable cached model files do not require a full network download again.
- Confirm iPhone/iPad begins with **Whisper Base**, with automatic Tiny fallback if Base cannot initialize/finish. Do not claim Small-first behavior on iOS/iPadOS.
- On less constrained supported browser devices, confirm the Small → Base → Tiny fallback strategy behaves as configured.
- Test a normal short recording, a 30–60 minute lecture, and the longest practical lecture the test device can process.
- Verify there is no LectureAI transcript minute, segment-count, file-size, or monthly quota. A failure caused by actual iPhone/iPad RAM must be reported as a device-memory limitation, not as a quota.
- Force/reproduce a model-memory failure if possible and verify the original recording remains safe and a useful recovery message is shown.
- Verify successful transcription windows remain useful if another window fails; failed audio is marked for review instead of silently invented.
- Verify no transcript job creates a duplicate lecture record.
- On Windows, launch the helper before transcription and confirm the configured faster-whisper model warms in the background so the first job does not pay the full model-startup delay after the click.

## Expo transcription honesty gate
- Do not label the existing browser Web Worker/Transformers.js transcriber as an Expo-native engine.
- Timestamped transcript JSON import must work before any Expo-only ASR claims are made.
- A phone-only Expo ASR button may be enabled only after an Expo-Go-compatible local engine has been implemented and benchmarked on physical hardware.
- A wireless Windows transcription button may be enabled only after the loopback helper has a secure authenticated pairing design; do not bind the current unauthenticated helper to the LAN.

## Notes / transcript consistency
- Generate notes from a long transcript whose key concept appears near the end and confirm that late concept can appear in the source-grounded notes.
- Include a segment prefixed with `[uncertain]` plus plausible-looking text and confirm that content is not silently promoted into trusted summary/notes/definitions/exam topics.
- Correct a transcript term and confirm the Expo target marks derived notes/study material stale until regenerated.
- Confirm generated note items with source links seek the correct original-audio timestamp.

## Transcription quality
Evaluate English, Egyptian Arabic (Masri), MSA, English technical terms inside Arabic, and code-switching. Include rows 1–3, rows 4–5, and realistic classroom noise. Measure WER/CER/manual review separately for phone/iPad web transcription and Windows. If a future Expo-native engine is added, benchmark it as its own engine rather than borrowing web/Windows scores. Never publish an accuracy percentage without measurements.

## Translation quality
- Evaluate Arabic→English and English→Arabic derived views separately.
- Include Masri, MSA, mixed English technical terms in Arabic sentences, numbers, proper nouns, and course glossary terminology.
- Record cases where generic translation changes an English technical term unnecessarily.
- Do not treat a translated view as the source transcript.

## Long sessions
LectureAI has no application-imposed recording duration, transcript length, segment count, file-size, or monthly-minute quota. Practical limits are free storage, battery, iOS/iPadOS foreground/background behavior, and available RAM for local decoding/model inference. Original audio remains the source of truth. If an iPhone/iPad cannot finish a very long on-device transcription because of real memory pressure, the recording must remain intact for retry or transfer to Windows.
