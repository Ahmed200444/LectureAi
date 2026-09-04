# LectureAI Expo Go app

This directory is the unified **LectureAI** target for Expo Go on iPhone and iPad. It is intentionally kept separate from the stable production web/PWA while the native-feeling workflow is physically validated.

## Current target

The project targets **Expo SDK 57**, matching the current App Store Expo Go generation used by this branch. The Windows launcher checks the Expo SDK and also verifies that Expo CLI is signed into an Expo account before starting Metro.

## Free testing flow

1. Install Expo Go from the App Store on the iPhone/iPad.
2. On Windows, double-click `start-expo-go.bat` from the repository root.
3. If Expo CLI is not signed in, run `npx expo login` and use the same Expo account that is signed into Expo Go.
4. Scan the QR code with the iPhone/iPad camera and open LectureAI in Expo Go.
5. Keep Expo Go visible during important recording. Stock Expo Go cannot promise locked-screen/background recording.
6. If campus/public Wi-Fi blocks LAN loading, run `npx expo start --clear --tunnel` from `expo-recorder` instead.

No USB cable or paid Apple Developer membership is required for this testing path.

## Recording and original-audio safety

- Native recording through `expo-audio`.
- SDK 57 `directory: 'document'` is used for the live recorder output instead of relying on cache storage.
- 48 kHz, mono, 192 kbps lecture-capture preferences layered over Expo's high-quality preset.
- Audio-level metering, pause/continue, and important-moment marks.
- Optional current-input label when Expo exposes that API; failure to obtain the label never blocks recording.
- Keep-awake support is feature-detected so an unavailable keep-awake function cannot prevent microphone start.
- Recording start is blocked below 500 MB available storage; critically low storage is warned about during an active session.
- Finished audio is copied into `Paths.document/LectureAI/Recordings` and checked for existence/minimum size.
- When source and destination MD5 values are available, LectureAI compares them and rejects a mismatched permanent copy.
- Metadata is stored through `expo-sqlite/kv-store` with a second `library-backup.json` document copy. The newer backup can repair an older primary metadata record.
- The protected recordings directory is scanned for orphaned audio if metadata is missing or unreadable.
- An active recording journal stores recovery metadata/pointers. It is **not** fake encoded-audio checkpointing.
- If the underlying recorder unexpectedly changes from active to stopped (for example after an audio-route change), LectureAI attempts to preserve the exposed file automatically and marks it for careful verification.

## Playback verification gate

A file existing is not enough to call a lecture verified. LectureAI requires playback checks at the **beginning, middle, and end**, followed by explicit user confirmation that the samples were clear. Recovered/interrupted files keep a warning until this gate passes.

## Library, import, share, and export

- Record and import existing audio files.
- Imported audio is preserved as a separate local original; its duration is populated once the player exposes metadata.
- Audio sharing chooses MIME type from the actual preserved filename rather than pretending every import is M4A.
- Timestamped transcript JSON import reads the selected document URI directly.
- Transcript editing/versioning invalidates stale derived study material.
- Segments explicitly marked `uncertain`, or containing `[uncertain]` / `[inaudible]`, are excluded from trusted study generation.
- The Export hub is opened from **Settings → Export lecture files** instead of floating over bottom navigation.
- Original audio, corrected transcript `.txt`, notes `.md`, study guide `.md`, and structured LectureAI `.json` can use the iOS/iPadOS share sheet.
- Notes/study exports are blocked when they are stale relative to the corrected transcript.
- Delete removes the selected protected audio file and its LectureAI metadata after confirmation.

## Free paired Windows transcription

1. Run `setup-windows.bat` once if needed.
2. Double-click `start-helper-for-phone.bat`.
3. The helper deliberately enables LAN mode and prints a private IPv4 address plus an 8-character pairing code.
4. In LectureAI → Settings, enter the address/code and pair.
5. Open a lecture → Transcript → **Transcribe on paired computer**.

Safeguards:

- Normal helper mode remains loopback-only; phone access requires deliberate `--lan` mode.
- Only private/local network clients are accepted.
- Pairing attempts are rate-limited and the code is compared using a constant-time function.
- Bearer tokens are bound to the paired client address, expire after 12 hours, and are stored in Expo SecureStore rather than ordinary lecture/settings metadata.
- When an original MD5 is available, Windows verifies the uploaded bytes before accepting the job.
- Upload timeouts scale with recording size, while job polling has a three-hour safety window so a broken job cannot leave the phone waiting forever.
- Use this only on a trusted private/home Wi-Fi network. The transport is authenticated HTTP and is **not end-to-end encrypted**.
- faster-whisper uses neutral `Speaker` labels because ASR is not speaker diarization.
- Lecture-level detected-language metadata is returned; it must not be described as true per-segment code-switch classification.

## Transcript / notes / study integrity

- The original audio remains the source of truth.
- Transcript edits increment the source version and make older derived material stale.
- Study generation samples material across the lecture rather than only the first few segments.
- Uncertain/inaudible source text is excluded from trusted study facts.
- Possible exam topics are review suggestions only, not claims about what a professor promised will appear on an exam.
- The Expo study generator is source-grounded/extractive; do not describe it as a fully semantic LLM summary engine.

## Deliberately not claimed

### Locked-screen/background recording

A custom signed application can configure native iOS background audio. Stock Expo Go cannot apply LectureAI-specific native background configuration, so this free testing target does **not** promise uninterrupted locked-screen/background recording.

### Expo-native on-device Whisper

The stable web client has browser worker/Transformers.js transcription. That browser implementation is not mislabeled as a React Native Expo engine. Expo transcription currently uses the authenticated local Windows helper or timestamped transcript JSON import.

### Accuracy percentages

The repository contains WER/CER benchmark tooling, Arabic-normalized metrics, technical-term recall, number recall, hallucination counts, and manual-review measurements. Do not publish an accuracy percentage until actual human-verified classroom samples have been measured.

## Physical acceptance gate

PR #28 must stay draft until the same branch passes on **both iPhone and iPad**:

- 20-second start → meter → pause → continue → mark → finish;
- beginning/middle/end playback gate and explicit confirmation;
- close/reopen Expo Go and replay the preserved file;
- Share / Save to Files and text/data exports;
- microphone/input routing with and without Bluetooth/headphones where available;
- disposable interruption/unexpected-stop recovery test;
- 30 / 60 / 90 / 120-minute recordings where storage/battery permit;
- low-storage behavior;
- audio and transcript JSON imports;
- real paired-Windows short and larger transcription round trips;
- transcript edit → stale-derived warning → regeneration → timestamp seeking;
- delete removes the intended protected original and metadata.

Automated iOS/Android bundling, Expo Doctor, root web tests/build, Python checks, pairing tests, and static safeguards are necessary but **do not replace this physical gate**.
