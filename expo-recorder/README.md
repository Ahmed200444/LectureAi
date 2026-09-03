# LectureAI Expo Go app

This directory is the unified LectureAI app target for **Expo Go on iPhone/iPad**. It is intentionally separate from the production web app while the native-feeling workflow is built and physically tested.

## Why Expo Go

The goal is a free, cable-free recording experience:

1. Install Expo Go from the App Store.
2. Open the LectureAI Expo project.
3. Record and preserve the original lecture inside the Expo project's document storage.
4. Review/play the original before trusting derived AI content.
5. Add a timestamped transcript, then generate source-grounded notes/study material.

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
- Low-storage warning using `Paths.availableDiskSpace`.
- iOS media-services-reset warning.
- Foreground/background warning.
- Finished audio is copied into the Expo project's **document** directory rather than left only in temporary/cache storage.
- File existence + minimum-size validation after preservation.
- MD5 metadata when the file-system API exposes it.
- A recording is **not** called verified just because a file exists. The user must listen and explicitly confirm playback.
- Share / Save to Files through the iOS share sheet.

### Library

- Persistent local lecture metadata backed by `expo-sqlite/kv-store`.
- Original audio remains as a normal file, not a giant value in SQLite/key-value storage.
- Record and imported-audio sources.
- Delete removes the original audio plus LectureAI metadata for that lecture.
- Audio verification state, marks, transcript state, and derived-content version state are kept per lecture.

### Transcript / study integrity

- Timestamped JSON transcript import is available as a real working bridge while native/free transcription is being validated.
- Original transcript/audio stays separate from edits.
- Editing a transcript increments its source version and marks translations/notes/study content stale.
- Study material regenerates from the current transcript rather than silently keeping stale content.
- `[uncertain]` and `[inaudible]` sections are excluded from trusted study generation.
- The local fallback study generator samples/scans the **whole lecture**, not just the first few transcript segments.
- Notes keep source timestamps so the user can jump back to the original audio.
- Possible exam topics are explicitly study suggestions, never claims that a professor promised something will be on an exam.

## Deliberately not faked

### Locked-screen/background recording in Expo Go

`expo-audio` can support background recording in a custom app binary when the native iOS `audio` background mode is configured. Stock Expo Go cannot apply LectureAI's project-specific native config plugin changes, so this build does **not** promise uninterrupted locked-screen/background recording. Keep Expo Go visible for important lectures.

### On-device Whisper

The existing web phone transcriber relies on browser Web Workers, WebAssembly, `AudioContext`, and Transformers.js. That code is not simply copied into React Native and labeled working. A phone-only transcription button will be enabled only after an Expo-Go-compatible local engine is implemented and physically benchmarked.

### Wireless Windows transcription

The current Windows faster-whisper helper is intentionally loopback-only (`127.0.0.1`) for privacy. It will not be exposed to the LAN without authenticated pairing, request authorization, and explicit user controls. Until that secure bridge exists, timestamped transcript import remains the working Expo transcription bridge.

## Run

```bash
cd expo-recorder
npm install
npm start
```

Then open the project in the App Store version of Expo Go on the iPhone/iPad.

## Acceptance gate before trusting a full lecture

Do not rely on this branch for an important class until all of these pass on the exact target iPhone/iPad:

- 20-second test recording: start → pause → continue → mark → finish → playback.
- Verify the stored file still plays after closing/reopening Expo Go and reopening the project.
- Verify Save to Files / share sheet.
- Verify microphone/input routing with and without Bluetooth/headphones connected.
- Verify interruption behavior for a phone call / Siri / another microphone user where practical.
- Verify 30, 60, 90, and 120 minute recordings as storage/battery permit.
- Verify low-storage warning.
- Verify device/background warning.
- Verify imported audio preservation.
- Verify transcript JSON import, transcript edit, stale-study warning, regeneration, and timestamp seeking.
- Verify deletion removes the audio file and lecture metadata.

No transcription accuracy percentage should be published until the repository benchmark protocol is completed on human-verified classroom audio.
