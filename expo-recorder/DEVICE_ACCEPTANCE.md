# LectureAI Expo physical-device acceptance

This checklist is the final gate before PR #28 may leave draft status or be called production-proven.

## Devices

Test the same branch on **both** an iPhone and an iPad in the App Store version of Expo Go. `app.json` must keep `ios.supportsTablet: true`. Do not treat an iPhone-only pass as an iPad pass or vice versa.

## Recording on each device

- 20-second start → pause → continue → add mark → finish.
- Confirm the level meter responds to speech.
- Confirm the stored original plays from the beginning, middle, and end.
- Close/reopen Expo Go and reopen LectureAI; confirm the preserved original still plays.
- Confirm the original remains unchanged after transcription/study generation.
- Confirm Share / Save to Files works.
- Confirm microphone/input routing with and without Bluetooth/headphones where available.
- Test a disposable interruption/background scenario and verify LectureAI never falsely labels questionable audio as verified.
- Test 30 / 60 / 90 / 120 minute recordings where battery/storage permit.
- Confirm low-storage blocking/warnings.
- Confirm delete removes LectureAI's protected original and metadata only after explicit confirmation.

## iPad-specific UI

- Portrait and landscape layouts are usable without clipped controls.
- Record, Lectures, Study, Settings and lecture detail tabs remain reachable.
- Transcript editing works with the on-screen keyboard and an external keyboard if available.
- Large-screen layouts do not stretch text/controls into unreadable full-width rows.
- Share sheet and Files destination work on iPadOS.

## Import/export

Before this checklist can pass, the Expo app must support and physically verify:

- Original audio: share / Save to Files.
- Transcript: export corrected timestamped transcript as `.txt` and structured `.json`.
- Notes: export current source-grounded notes as `.md`.
- Study guide: export concepts, review topics and study questions as `.md`.
- Lecture data: export a structured `.json` metadata/transcript/study bundle that references the original audio filename/hash but does not silently duplicate or alter the original audio.
- Import an existing audio recording from Files and preserve a separate original copy.
- Import timestamped transcript JSON.

Exports must prefer the corrected transcript and current study-pack source version. If the transcript changes and derived content is stale, LectureAI must not export stale notes as though they were current without an explicit warning.

## Windows transcription round trip

On trusted private Wi-Fi, test on both iPhone and iPad:

- Pair with `start-helper-for-phone.bat`.
- Transfer a short and a larger recording.
- Confirm MD5 transfer verification when the phone exposes a hash.
- Confirm faster-whisper returns timestamped text.
- Confirm transcript correction invalidates derived content.
- Regenerate study content and confirm timestamp links seek the original audio.
- Confirm forgetting the computer removes the usable pairing from the device.

## Not part of the Expo Go promise

Stock Expo Go cannot guarantee project-specific locked-screen/background recording. Keep Expo Go visible for important lectures. On-device Whisper is not claimed until an Expo-Go-compatible engine is implemented and benchmarked on real devices.
