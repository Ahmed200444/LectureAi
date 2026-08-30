# LectureAI Recorder for iPhone

This folder contains the native iPhone recording companion for LectureAI.

## Why it exists

The web/PWA recorder is still supported, but Safari controls the microphone session and can interrupt it. The native recorder uses Apple's AVFoundation audio APIs directly so LectureAI can control the recording session, microphone choice, interruption recovery, pause/continue behavior, screen-awake behavior, and local file handling more reliably.

The native recorder does **not** claim that an iPhone can recover speech that never reaches the microphones clearly. Its goal is to preserve the best signal the phone can capture and make long classroom recording more dependable.

## Current native recording policy

- local-only by default; no cloud upload
- Apple `AVAudioRecorder`
- 48 kHz AAC (`.m4a`)
- mono lecture capture
- 192 kbps encoder target
- `AVAudioSession` record category with `videoRecording` signal processing
- built-in iPhone microphone preferred
- front microphone data source + cardioid pattern requested when the specific iPhone exposes them
- no artificial duration/minute quota
- screen kept awake during an active recording session
- Pause / Continue keeps the same recorder and file
- iOS audio interruptions are detected and recovered when the system allows it
- route changes and media-service resets are surfaced without silently deleting captured audio
- original recording remains untouched
- saved recordings can be listened to locally and explicitly shared

Apple documents that microphone data sources on supported devices may expose orientation and polar-pattern/directivity controls, including spatial filtering or beamforming. Those controls are best-effort and vary by iPhone hardware.

## Getting a recording into the existing LectureAI library

The Safari/PWA library and a native iOS app do not share the same private IndexedDB container. For the first native version, use the explicit local handoff:

1. Finish & save the native recording.
2. Tap **Send to LectureAI** and save the `.m4a` to Files (or use another explicit share destination you control).
3. Open `https://lecture-ai-blush.vercel.app/`.
4. Choose **Import Recording** and select the `.m4a`.
5. LectureAI preserves the imported original audio and queues the existing on-device/Windows transcription flow.

The filename is based on the lecture title, so the imported lecture keeps a useful title automatically.

A later native-library bridge can remove this manual import step, but it must not fake direct access to Safari's private storage.

## Generate the Xcode project

The project is described with XcodeGen so the project file is reproducible rather than hand-edited.

```bash
brew install xcodegen
cd ios/LectureAIRecorder
xcodegen generate
open LectureAIRecorder.xcodeproj
```

In Xcode, select your iPhone and your personal development team, then Run. A free Apple account can be used for personal-device development/testing; App Store/TestFlight distribution requires the relevant Apple developer membership.

## CI

`.github/workflows/ios-native.yml` generates the project and performs a no-signing iPhone Simulator build on macOS. The main JavaScript test suite also contains static native-recorder safeguards so accidental removal of the no-time-limit, pause/continue, interruption, local-only, and far-field settings is caught on the normal LectureAI CI path.
