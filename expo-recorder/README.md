# LectureAI Expo Go app

This directory is the unified LectureAI app target for **Expo Go on iPhone/iPad**. It is intentionally separate from the production web app while the native-feeling workflow is built and physically tested.

## Why Expo Go

The goal is a free, cable-free recording experience:

1. Install Expo Go from the App Store.
2. On Windows, double-click `start-expo-go.bat` in the LectureAI folder. It installs the Expo project dependencies on first use and starts a LAN QR code.
3. Scan the QR code with the iPhone camera or Expo Go. No USB cable or paid Apple Developer account is needed.
4. Record through native `expo-audio` rather than Safari `MediaRecorder`.
5. When recording stops, LectureAI immediately copies the original into its own document-storage recording library.
6. Listen to the preserved original before trusting transcript/notes.
7. Optionally pair a Windows laptop on trusted private Wi-Fi for free local faster-whisper transcription.
8. Review/correct the timestamped transcript and generate source-grounded notes/study material.

The App Store version of Expo Go supports Expo SDK 54, so this project targets SDK 54 until the distribution strategy changes.

## Current implemented features

### Recording

- `expo-audio` native recording through Expo Go.
- 48 kHz, mono, 192 kbps lecture-capture preferences layered over Expo's high-quality preset.
- Audio-level metering.
- Pause / continue in the same recorder session.
- Important-moment marks.
- Current recording-input label when Expo/iOS exposes it.
- Keep-screen-awake option.
- Recording start is blocked below 500 MB available storage; critically low storage is warned about during an active session.
- iOS media-services-reset warning.
- Foreground/background warning.
- Finished audio is immediately copied into `Paths.document/LectureAI/Recordings` and validated for existence/minimum size.
- MD5 metadata when the file-system API exposes it.
- An **active recording journal** is updated while recording. If an interrupted Expo session leaves a real file URL that still exists, the next launch attempts to copy that file into the protected recording library and labels it as recovered/unverified.
- The journal is deliberately not described as encoded-audio checkpointing: SDK 54 does not let this project choose the live `expo-audio` recorder directory, and an interrupted M4A may not have finalized cleanly.
- A recording is **not** called verified just because a file exists. The user must listen and explicitly confirm playback.
- Share / Save to Files through the iOS share sheet.

### Library and recovery

- Persistent local lecture metadata backed by `expo-sqlite/kv-store`.
- A second `library-backup.json` metadata copy lives in the LectureAI document directory.
- Original audio remains as a normal file, not a giant value in SQLite/key-value storage.
- On launch, LectureAI scans `LectureAI/Recordings` for orphaned original audio files and surfaces them as **Recovered audio — verify** instead of silently hiding them if metadata was lost.
- New protected audio is de-duplicated against temporary recovery placeholders so one physical recording appears once in the lecture library.
- Record and imported-audio sources.
- Delete removes the original audio plus LectureAI metadata aliases for that lecture/file.
- Audio verification state, marks, transcript state, and derived-content version state are kept per lecture.

### Free paired Windows transcription

The Expo app includes an explicit authenticated private-LAN path to the existing faster-whisper helper.

1. Finish/save the original recording first.
2. On Windows, run `setup-windows.bat` once if needed.
3. Double-click `start-helper-for-phone.bat`.
4. The helper starts LAN mode deliberately and prints a private IPv4 address plus an 8-character pairing code.
5. In LectureAI Expo → Settings, enter the address/code and pair.
6. Open a lecture → Transcript → **Transcribe on paired computer**.
7. The protected original audio is transferred to the paired Windows PC. When Expo exposes an MD5 for the preserved file, Windows verifies the received bytes match before accepting the job.
8. The configured faster-whisper model transcribes locally and the timestamped transcript returns to LectureAI.

Safeguards:

- Normal Windows helper mode remains loopback-only. LAN access happens only with `--lan` / the phone launcher.
- LAN mode accepts explicit RFC1918/loopback/link-local ranges rather than treating every non-global/reserved IP as trusted.
- Transcription/job endpoints require a bearer session token.
- The token is bound to the paired client address and expires after 12 hours.
- Pairing attempts are rate limited and the pairing code is compared with a constant-time function.
- The app accepts only private IPv4 helper addresses.
- When an original MD5 is available, transfer corruption is detected before transcription; a mismatch never modifies the phone original.
- Use this feature only on a **trusted private/home Wi-Fi network**. The current LAN transport is plain HTTP and is **not end-to-end encrypted**. Public/campus Wi-Fi may also isolate devices and prevent direct peer connections.
- On iOS, Expo Go must have **Local Network** permission for direct LAN access.

### Transcript / study integrity

- Paired Windows faster-whisper transcription is the preferred free high-accuracy Expo route.
- Timestamped JSON transcript import remains a working fallback/advanced bridge.
- Original transcript/audio stays separate from edits.
- Editing a transcript increments its source version and clears older translation views so stale translations are not mistaken for current text.
- Notes/study material is marked stale after transcript changes and regenerates from the current transcript.
- `[uncertain]` and `[inaudible]` sections are excluded from trusted study generation.
- The local fallback study generator samples/scans the **whole lecture**, not just the first few transcript segments.
- Notes keep source timestamps so the user can jump back to the original audio.
- Possible exam topics are explicitly study suggestions, never claims that a professor promised something will be on an exam.
- faster-whisper output uses the neutral label **Speaker** until real diarization exists.

## Deliberately not faked

### Locked-screen/background recording in Expo Go

`expo-audio` can support background recording in a custom app binary when the native iOS `audio` background mode is configured. Stock Expo Go cannot apply LectureAI's project-specific native config plugin changes, so this build does **not** promise uninterrupted locked-screen/background recording. Keep Expo Go visible for important lectures.

### On-device Whisper inside Expo Go

The existing web phone transcriber relies on browser Web Workers, WebAssembly, `AudioContext`, and Transformers.js. That code is not copied into React Native and labeled working. A phone-only local transcription button will be enabled only if an Expo-Go-compatible engine is implemented and physically benchmarked.

### Accuracy claims

The repository includes a benchmark protocol and WER/CER tooling, including Arabic-normalized metrics, technical-term recall, number recall, hallucination counts, and manual correction time. No transcription accuracy percentage is published until human-verified classroom recordings are actually measured.

## Run the Expo project

Easiest on Windows: double-click `start-expo-go.bat` from the repository root and scan its QR code.

Manual equivalent:

```bash
cd expo-recorder
npm install
npx expo start --lan
```

The Windows computer and iPhone/iPad need to be reachable on the same LAN while Expo Go initially loads the development project. This removes the USB/AltStore/IPA requirement, but it is still an Expo development project until it is published through an Expo account or another distribution path.

## Acceptance gate before trusting a full lecture

Do not rely on this branch for an important class until all of these pass on the exact target iPhone/iPad:

- 20-second test recording: start → pause → continue → mark → finish → playback.
- Verify the stored file still plays after closing/reopening Expo Go and reopening the project.
- Verify Save to Files / share sheet.
- Verify microphone/input routing with and without Bluetooth/headphones connected.
- Verify interruption behavior for a phone call / Siri / another microphone user where practical.
- Force-close/reopen after a disposable test recording and verify the recovery journal never falsely labels missing/unplayable audio as safe.
- Verify 30, 60, 90, and 120 minute recordings as storage/battery permit.
- Verify low-storage blocking/warnings.
- Verify foreground/background warning.
- Verify imported audio preservation.
- Verify Windows pairing on trusted private Wi-Fi, token expiry/re-pairing, checksum behavior when available, and a real audio upload/transcription round trip.
- Verify transcript edit → stale-study warning → regeneration → timestamp seeking.
- Verify deletion removes the protected audio file and lecture metadata.

The GitHub iOS/Android bundles, Expo Doctor, static safeguards, web tests/build, Python syntax checks, pairing tests, and benchmark unit tests are automated. Physical iPhone/iPad microphone, interruption, long-duration, local-network, and playback behavior cannot be certified by CI and remain the final merge gate.
