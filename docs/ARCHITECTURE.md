# Architecture

LectureAI Open Source Core deliberately starts small so contributors can understand the full recording path without a large framework dependency graph.

## Modules

- `index.html` — accessible application shell.
- `styles.css` — responsive UI styling.
- `src/app.js` — UI orchestration and event handling.
- `src/recorder.js` — microphone access, `MediaRecorder`, audio chunks, and input-level monitoring.
- `src/diagnostics.js` — device/browser capability and microphone diagnostics.
- `src/storage.js` — locally persisted lecture title and notes.
- `src/utils.js` — small pure helpers covered by unit tests.
- `sw.js` — minimal offline cache for the static application shell.

## Data flow

1. The user explicitly requests microphone access.
2. The browser returns a `MediaStream` if permission and platform support allow it.
3. `LectureRecorder` records chunks with `MediaRecorder` and keeps the recording in browser memory.
4. Stopping creates a `Blob` for local playback and explicit export.
5. Lecture title and notes are saved to `localStorage` independently of the audio.

The current core intentionally does not upload recordings to a server.

## Future transcription boundary

Automatic transcription should be added behind a clear interface rather than mixed into the recorder. That separation should allow local models, user-provided backends, or other implementations to be evaluated without making one paid service mandatory for the core project.

Any transcription integration should document:

- where audio is processed
- what data leaves the device
- whether a paid service is required
- supported languages and limitations
- evaluation method and known failure cases

## Testing philosophy

Pure helper behavior is covered with Node's built-in test runner. Browser/device behavior should be tested separately because microphone permissions, Safari lifecycle behavior, and media-container support cannot be reliably inferred from desktop-only unit tests.
