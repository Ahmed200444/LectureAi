# LectureAI

**Record → Verify → Transcribe → Review → Study**

LectureAI is a local-first progressive web app for university lectures, with **iPhone and iPad as primary recording targets**. It preserves the original recording, supports local multilingual transcription, links transcript segments back to audio timestamps, creates editable study notes, and lets you export or share your work without requiring a paid speech API.

LectureAI does **not** claim perfect transcription accuracy. The original audio is always the source of truth, and uncertain speech should be checked against it.

## Core guarantees

- Original audio is preserved separately from transcription/notes processing.
- Five-second recording checkpoints are written to IndexedDB during a lecture.
- A finished recording is not marked safely saved until the assembled audio can be reloaded for playback.
- A failed checkpoint write is not silently treated as a successful save; successful checkpoints remain available for recovery.
- There is **no LectureAI-imposed recording duration, transcript length, segment-count, file-size, or monthly-minute quota**.
- Practical limits still exist: device/browser storage, battery, iOS/iPadOS foreground suspension, and available RAM for on-device decoding/model inference.
- Production starts with an empty library; no fake/demo lecture is seeded.
- Recordings, transcripts, notes, bookmarks, and course information stay local by default.
- No paid runtime speech API is required.

## Primary devices

### iPhone

- Safari and installed **Add to Home Screen** PWA are supported targets.
- Microphone setup records a real 12-second sample and requires playback confirmation before the Start button unlocks.
- LectureAI does not trust Safari's transient `MediaStreamTrack.muted` flag as proof that the microphone is actually silent. Actual encoded audio/live signal is authoritative.
- The app feature-detects the recording format and prefers supported iOS AAC/MP4 recording formats while retaining fallback formats.
- Safe-area layout keeps controls clear of the status area and Home indicator.

### iPad

The same recording, microphone verification, transcription, sharing, deletion, and installed-PWA safeguards apply to iPad. The interface expands for the larger display and supports portrait/landscape layouts.

### Windows

Windows can run the included loopback-only faster-whisper helper. The browser sends a saved recording only to `127.0.0.1:8765` on that same Windows computer. The helper uses the locally configured/recommended multilingual Whisper model.

There is no separate **Maximum Accuracy** product mode. The normal laptop action is **Transcribe on Computer**.

## Recording workflow on iPhone/iPad

1. Open LectureAI in Safari or from the installed Home Screen app.
2. Tap **Start a new recording**.
3. Acknowledge recording consent the first time.
4. Record the 12-second microphone sample from the position you expect to use in class.
5. Play the sample and tap **I can hear it clearly**.
6. Start the lecture recording.
7. Keep LectureAI visible during the important part of the class. iOS/iPadOS may suspend a web app in the background.
8. Use **Mark moment** for important timestamps.
9. **Stop recording** can pause the current lecture; **Continue current recording** resumes the same lecture.
10. Choose **Finish & save current lecture** when finished.
11. Listen to the saved-audio preview before relying on the transcript.

LectureAI requests a mono lecture-capture profile and asks the browser to disable call-style echo cancellation, noise suppression, and automatic gain control where supported. These are best-effort preferences; iOS/iPadOS may ignore some constraints. Diagnostics and the microphone test show the capture settings the browser actually granted when available.

## Long recordings

`MediaRecorder.start(5000)` keeps one continuous recording session and emits frequent blobs. Each non-empty blob is written to IndexedDB with a monotonic checkpoint index.

When the lecture finishes, LectureAI waits for pending checkpoint writes, assembles the blobs in order, stores the original audio, verifies browser playback, and only then deletes temporary checkpoint records.

There is no timer in LectureAI that stops a lecture after 30, 60, 90, 120 minutes, or any other fixed duration. Long-session success depends on the real device.

## On-device transcription on iPhone/iPad

**Transcribe on This Device** uses multilingual Whisper through `@huggingface/transformers` in a dedicated browser worker.

Current model strategy:

1. Whisper Small multilingual is preferred.
2. If the stronger model cannot initialize or complete inference, LectureAI retries with Base.
3. If needed, it retries with Tiny.

The worker uses a Safari-compatible WASM path. You can prepare/cache the model before class from Settings so the app does not need to begin a large model download after the lecture.

LectureAI processes the decoded transcription copy in overlapping sections and keeps successful sections even if another section fails. A failed section is marked for review instead of inventing speech.

The original recording is never overwritten by transcription normalization. Quiet/distant-speech gain is applied only to a disposable transcription copy.

### Long-transcription limitation

LectureAI has no artificial transcript quota, but iPhone/iPad browsers have finite RAM. The current on-device path must decode the saved recording before windowed inference, so a very long lecture can still exceed real device memory. If that happens, the original audio remains intact and can be retried or transferred to Windows for **Transcribe on Computer**.

Do not describe an iOS/iPadOS memory failure as a LectureAI minute/file quota.

## English, Egyptian Arabic, MSA, and code-switching

LectureAI is designed for lectures containing:

- English;
- Egyptian Arabic / Masri;
- Modern Standard Arabic;
- English technical terms inside Arabic speech;
- natural English/Arabic code-switching.

The raw transcript preserves the spoken language rather than translating it automatically. Course glossary terms can guide recognition, but they must not replace what the audio supports.

## Sharing from iPhone/iPad

LectureAI uses the iOS/iPadOS system share sheet when supported.

You can export/share:

- original audio;
- transcript text;
- transcript Markdown;
- Word/DOCX notes + transcript.

For transcript sharing, LectureAI first tries to share the actual `.txt`/`.md` file. If an iOS share target rejects that file type, it can fall back to sharing the transcript body as plain text before falling back to a local download.

WhatsApp, Gmail, AirDrop, Messages, Save to Files, and other destinations are controlled by iOS/iPadOS. LectureAI can open the system share sheet but cannot force a specific installed app to appear.

## Sending an iPhone/iPad recording to Windows

An iPhone/iPad cannot directly access a Windows helper at `127.0.0.1`; localhost always means the device running the browser.

Use this workflow:

1. On iPhone/iPad, share/export **Original audio**.
2. Transfer the file with AirDrop/Files/Gmail/WhatsApp/USB/another user-controlled method as appropriate.
3. Open LectureAI on the Windows computer.
4. Choose **Import recording from phone/iPad**.
5. Start `start-lectureai.bat` (or `start-helper-for-hosted-site.bat` when using the hosted Vercel UI) if the computer transcription helper is not ready.
6. Choose **Transcribe on Computer**.

Transferred `.m4a`, `.mp4`, `.aac`, `.wav`, `.webm`, `.mp3`, `.ogg`, and `.flac` recordings are preserved locally. If Chrome/Edge cannot preview-decode a valid transferred iPhone container, LectureAI allows the local FFmpeg/faster-whisper helper to perform the authoritative decode instead of rejecting the original file.

The helper has no fixed LectureAI upload-size ceiling; it checks available disk space while receiving the recording.

## Delete lectures to reclaim storage

Every lecture screen includes **Delete lecture**.

After one confirmation, deletion removes that lecture's:

- original audio;
- lecture record, including transcript, notes, bookmarks, and note history;
- checkpoint chunks;
- attachments.

This is manual only. LectureAI never automatically deletes a lecture after playback.

Deleting data removes it from LectureAI's IndexedDB immediately. iOS/iPadOS decides when its system-wide storage display reflects/reclaims that space.

## Playback and transcript review

- Click/tap a transcript timestamp or sentence to seek the original audio.
- Active transcript highlighting follows playback.
- Optional **Follow transcript** keeps the current segment in view.
- Audio controls include play/pause, ±5/±10 seconds, seek bar, and 0.75×/1×/1.25×/1.5×/2× speed.
- Low-confidence/`[inaudible]` sections appear in the review workflow.
- **Corrected transcript** edits never modify the original audio.

## Notes

Generated study notes are editable and keep the generated version separate from the current edited version. Notes include the product's study sections such as summary, detailed notes, key concepts, definitions, examples, technical information, important professor notes, possible exam topics, and study questions.

Regeneration should preview changes rather than silently overwrite edited notes.

## Search and organization

Library structure is Semester/Course/Lecture. Courses can store a professor name and terminology glossary. Search can match lecture metadata, transcripts, notes, and glossary/course information.

## PWA / offline behavior

The manifest uses standalone display mode, and the service worker caches the application shell. LectureAI also detects installed PWA mode and checks for app updates.

Offline-first means the local library, saved recordings, transcript editing, notes, and playback can continue from already stored resources. On-device speech transcription requires the model to have been downloaded/cached first.

### Important iOS/iPadOS limitation

A PWA cannot promise indefinite background recording. Keep LectureAI visible and avoid locking the screen or switching apps during an important lecture. Screen Wake Lock is requested where available, but it is best effort.

## Windows setup

Requirements:

- Windows 10/11;
- Python 3.11/3.12;
- Node.js 22.x;
- enough disk/RAM for the chosen model and recordings;
- optional compatible NVIDIA GPU for faster processing.

Initial setup:

```text
setup-windows.bat
```

Normal local use:

```text
start-lectureai.bat
```

Using the hosted Vercel interface with the private local helper:

```text
start-helper-for-hosted-site.bat
```

The hosted production UI is currently configured for:

```text
https://lecture-ai-blush.vercel.app
```

The helper remains loopback-only and does not expose lecture audio to the LAN.

## Local models

The Windows setup can use:

| Label | Model | Approx. download | Typical memory target |
|---|---|---:|---|
| Fast | `small` multilingual | ~500 MB | 4+ GB RAM |
| Balanced | `medium` multilingual | ~1.5 GB | 8+ GB RAM or suitable GPU VRAM |
| Large | `large-v3` multilingual | ~3.1 GB | 16+ GB RAM or higher VRAM preferred |

These are local model choices, not separate LectureAI product modes. Benchmark them with real classroom audio instead of assuming a larger model guarantees a particular accuracy percentage.

## Storage architecture

IndexedDB stores:

- `courses`;
- `lectures`;
- `audioChunks`;
- `audioFiles`;
- `attachments`;
- `settings`.

Large audio does not use `localStorage`. LectureAI requests persistent browser storage when available and displays the browser's storage estimate when exposed.

## Diagnostics

Settings → Diagnostics reports non-sensitive technical state such as:

- detected iPhone/iPad/Windows device type;
- browser/PWA mode;
- microphone permission;
- MediaRecorder availability and selected format;
- IndexedDB availability;
- on-device transcription support;
- Windows helper state/model/version.

Diagnostics should never include lecture audio or transcript contents.

## Development

```bash
npm install
npm run dev
```

Quality gates:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

The GitHub Actions workflow runs those checks plus production-output validation, Windows-helper Python syntax, and a built-site smoke test.

## Physical iPhone/iPad acceptance gate

Automated CI cannot prove real microphone routing, audible classroom quality, iOS share destinations, background suspension behavior, or real transcript WER/CER. Before claiming a production mobile pass, run `benchmarks/mobile-acceptance.md` on physical iPhone and iPad hardware in Safari and installed-PWA mode.

The acceptance matrix includes:

- real mic sample + lecture playback;
- iPhone Safari + installed PWA;
- iPad Safari + installed PWA;
- portrait/landscape safe areas;
- long recordings/checkpoint recovery;
- share to real installed apps;
- delete/reclaim-storage behavior;
- 30–60 minute and long on-device transcription;
- English/Masri/MSA/code-switching/classroom-noise benchmarks;
- iPhone/iPad → Windows import/transcription.

Never publish an accuracy percentage without measured results.

## Privacy

LectureAI is local-first. It does not automatically upload recordings, transcripts, or notes to a cloud speech service. Manual exports/backups are user-controlled.

## License

See `LICENSE`.