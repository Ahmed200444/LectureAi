# LectureAI

**Record → Verify → Transcribe → Review → Study**

LectureAI is a local-first university lecture recorder and study workspace. The stable production client is a progressive web app; the `expo-unified-lectureai` branch also contains a free **Expo Go** iPhone/iPad app target so recording can happen through native Expo audio instead of Safari. Both architectures preserve the original recording separately from transcript, translation, notes, and study processing.

LectureAI does **not** claim perfect transcription accuracy. The original audio is always the source of truth, and uncertain speech should be checked against it.

## Core guarantees

- Original audio is preserved separately from transcription/notes processing.
- The production web recorder writes five-second recovery checkpoints to IndexedDB during a lecture.
- A web recording is not marked safely saved until the assembled audio passes playback validation.
- A failed checkpoint write is not silently treated as a successful save; successful checkpoints remain available for recovery.
- The Expo Go target copies finished/imported audio into the project's document storage and requires a user playback check before calling it verified.
- There is **no LectureAI-imposed recording duration, transcript length, segment-count, file-size, or monthly-minute quota**.
- Practical limits still exist: device/browser storage, battery, iOS/iPadOS foreground/background behavior, and available RAM for local model inference.
- Production starts with an empty library; no fake/demo lecture is seeded.
- Recordings, transcripts, notes, bookmarks, and course information stay local by default.
- No paid runtime speech API is required.
- Never publish an accuracy percentage without a measured, human-verified benchmark.

## Clients

### Stable web/PWA

The production web interface supports Safari/Add to Home Screen on iPhone/iPad and Windows/desktop browsers. It includes recording checkpoints, saved-audio verification, browser transcription, Windows faster-whisper integration, transcript review/editing, notes, translations, organization, and exports.

### Free Expo Go target

`expo-recorder/` is the unified Expo target under active development. It is designed to run **inside the App Store Expo Go application**, not Safari. It currently provides native Expo recording, pause/continue, audio metering, important-moment marks, document-storage preservation, local lecture metadata, playback verification, audio import/share, timestamped transcript JSON import/editing, and source-grounded notes/study material.

Stock Expo Go cannot apply LectureAI's project-specific iOS background-audio entitlement/configuration, so this free build does **not** promise uninterrupted locked-screen/background recording. Keep Expo Go visible during an important lecture. See `expo-recorder/README.md` for its physical acceptance gate.

## Primary devices

### iPhone

For the stable web client:

- Safari and installed **Add to Home Screen** PWA are supported targets.
- Microphone setup records a real 12-second sample and requires playback confirmation before the Start button unlocks.
- LectureAI does not trust Safari's transient `MediaStreamTrack.muted` flag as proof that the microphone is actually silent. Actual encoded audio/live signal is authoritative.
- The app feature-detects the recording format and prefers supported iOS AAC/MP4 recording formats while retaining fallback formats.
- Safe-area layout keeps controls clear of the status area and Home indicator.

For the Expo target, recording is performed through `expo-audio` inside Expo Go rather than WebKit `MediaRecorder`.

### iPad

The same web recording, microphone verification, transcription, sharing, deletion, and installed-PWA safeguards apply to iPad. The Expo target also supports iPad and uses the same free Expo Go architecture.

### Windows

Windows can run the included loopback-only faster-whisper helper. The browser sends a saved recording only to `127.0.0.1:8765` on that same Windows computer. The helper uses the locally configured/recommended multilingual Whisper model.

There is no separate **Maximum Accuracy** product mode. The normal laptop action is **Transcribe on Computer**.

## Recording workflow on the stable web client

1. Open LectureAI in Safari or from the installed Home Screen app.
2. Tap **Start a new recording**.
3. Acknowledge recording consent the first time.
4. Record the 12-second microphone sample from the position you expect to use in class.
5. Play the sample and tap **I can hear it clearly**.
6. Start the lecture recording.
7. Keep LectureAI visible during the important part of the class. iOS/iPadOS may suspend a web app in the background.
8. Use **Mark moment** for important timestamps.
9. **Pause recording** keeps the same microphone/MediaRecorder session; **Continue recording** resumes it.
10. Choose **Finish & save** when finished.
11. Listen to the saved-audio preview before relying on the transcript.

Current iPhone/iPad web capture preferences request mono/48 kHz where available, disable echo cancellation where supported, and **prefer iOS automatic gain control plus noise suppression for far-field classroom speech**. These are best-effort ideals; Safari/iOS may ignore or change them. Diagnostics and the microphone test report the settings the browser actually granted when exposed.

## Long web recordings

`MediaRecorder.start(5000)` keeps one continuous recording session and emits frequent blobs. Each non-empty blob is written to IndexedDB with a monotonic checkpoint index.

When the lecture finishes, LectureAI waits for pending checkpoint writes, assembles the blobs in order, stores the original audio, verifies browser playback with fresh media probes, and only then deletes temporary checkpoint records.

There is no timer in LectureAI that stops a lecture after 30, 60, 90, 120 minutes, or any other fixed duration. Long-session success depends on the real device, storage, battery, and OS behavior.

## On-device web transcription on iPhone/iPad

**Transcribe on This Device** in the stable web client uses multilingual Whisper through `@huggingface/transformers` in a dedicated browser worker.

The worker contains Small, Base, and Tiny multilingual Whisper fallbacks. **On iPhone/iPad specifically, LectureAI starts with Base and can fall back to Tiny** because loading Small first caused unacceptable WebKit memory risk. On less constrained browser devices the model strategy can begin with Small before Base/Tiny.

The worker uses a Safari-compatible WASM path. You can prepare/cache the model before class from Settings so the app does not need to begin a large model download after the lecture.

On iPhone/iPad, LectureAI deliberately prepares the audio **before** warming the speech model instead of doing both memory-heavy operations simultaneously. This favors process survival over a small startup-time improvement.

LectureAI processes the prepared transcription copy in overlapping sections and keeps successful sections even if another section fails. A failed section is marked for review instead of inventing speech.

The original recording is never overwritten by transcription normalization. Quiet/distant-speech gain is applied only to a disposable transcription copy.

### Long-transcription limitation

LectureAI has no artificial transcript quota, but iPhone/iPad browsers have finite RAM. The current web on-device path must decode the saved recording before windowed inference, so a very long lecture can still exceed real device memory. If that happens, the original audio remains intact and can be retried or transferred to Windows for **Transcribe on Computer**.

Do not describe an iOS/iPadOS memory failure as a LectureAI minute/file quota.

## English, Egyptian Arabic, MSA, and code-switching

LectureAI is intentionally optimized around lectures containing:

- English;
- Egyptian Arabic / Masri;
- Modern Standard Arabic;
- English technical terms inside Arabic speech;
- natural English/Arabic code-switching.

The raw transcript preserves the spoken language rather than translating it automatically. Course glossary terms can guide recognition, but they must not replace what the audio supports.

The current product should **not** be described as a fully validated all-languages transcription system. Its first-class benchmark matrix is English/MSA/Masri/English-Arabic mixed speech.

## Windows transcription

The local helper supports faster-whisper `small`, `medium`, and `large-v3` models. It can use a course glossary in both its context prompt and hotwords, requests word timestamps, uses VAD, and applies conservative hallucination/low-confidence review heuristics.

The prompt tells the model to expect university English, Egyptian Arabic, MSA, and English technical terms inside Arabic, while preserving the original spoken language instead of translating the source transcript.

The helper is intentionally loopback-only. Do **not** expose it to the LAN merely to make Expo-to-Windows transfer convenient. A future wireless workflow must add explicit authenticated pairing and request authorization first.

## Sharing from iPhone/iPad

LectureAI uses the iOS/iPadOS system share sheet when supported.

The stable web client can export/share:

- original audio;
- transcript text;
- transcript Markdown;
- Word/DOCX notes + transcript.

For transcript sharing, LectureAI first tries to share the actual `.txt`/`.md` file. If an iOS share target rejects that file type, it can fall back to sharing the transcript body as plain text before falling back to a local download.

WhatsApp, Gmail, AirDrop, Messages, Save to Files, and other destinations are controlled by iOS/iPadOS. LectureAI can open the system share sheet but cannot force a specific installed app to appear.

## Sending an iPhone/iPad recording to Windows

An iPhone/iPad cannot directly access a Windows helper at `127.0.0.1`; localhost always means the device running the client.

Current stable workflow:

1. On iPhone/iPad, share/export **Original audio**.
2. Transfer the file with AirDrop/Files/Gmail/WhatsApp/USB/another user-controlled method as appropriate.
3. Open LectureAI on the Windows computer.
4. Choose **Import recording from phone/iPad**.
5. Start `start-lectureai.bat` (or `start-helper-for-hosted-site.bat` when using the hosted Vercel UI) if the computer transcription helper is not ready.
6. Choose **Transcribe on Computer**.

Transferred `.m4a`, `.mp4`, `.aac`, `.wav`, `.webm`, `.mp3`, `.ogg`, and `.flac` recordings are preserved locally. If Chrome/Edge cannot preview-decode a valid transferred iPhone container, LectureAI allows the local FFmpeg/faster-whisper helper to perform the authoritative decode instead of rejecting the original file.

The helper has no fixed LectureAI upload-size ceiling; it checks available disk space while receiving the recording.

## Delete lectures to reclaim storage

Every stable web lecture screen includes **Delete lecture**.

After one confirmation, deletion removes that lecture's:

- original audio;
- lecture record, including transcript, notes, bookmarks, and note history;
- checkpoint chunks;
- attachments.

This is manual only. LectureAI never automatically deletes a lecture after playback.

Deleting web data removes it from LectureAI's IndexedDB immediately. iOS/iPadOS decides when its system-wide storage display reflects/reclaims that space.

The Expo target similarly deletes the original document file and its LectureAI metadata when the user explicitly deletes a lecture.

## Playback and transcript review

- Click/tap a transcript timestamp or sentence to seek the original audio.
- Active transcript highlighting follows playback in the stable web client.
- Optional **Follow transcript** keeps the current segment in view.
- Stable web audio controls include play/pause, ±5/±10 seconds, seek bar, and 0.75×/1×/1.25×/1.5×/2× speed.
- Low-confidence/`[inaudible]` sections appear in the review workflow.
- **Corrected transcript** edits never modify the original audio.
- A model score such as faster-whisper log probability is not presented as a fake accuracy percentage.

## Notes and study material

Generated study notes are editable in the stable web client and keep the generated version separate from the current edited version. Regeneration previews changes rather than silently overwriting edits.

The source-grounded fallback notes generator now samples important material **across the whole lecture** instead of only the first few transcript segments. It excludes segments prefixed with `[uncertain]` or `[inaudible]` from trusted factual study material and retains source timestamp links for selected notes.

Study sections include summary, detailed notes, key concepts, definitions, examples, technical information, important lecture/professor emphasis, possible exam review topics, and study questions. Possible exam topics are explicitly review suggestions, not claims that a professor promised they will appear on an exam.

The Expo target additionally versions the transcript source so transcript edits mark derived study material stale until it is regenerated.

## Translation

The stable phone path can create local English/Arabic transcript views using separate local translation workers. The original multilingual transcript remains preserved.

Current translation is a **derived convenience view**, not a replacement for the source transcript. Generic Arabic↔English translation models can be less reliable on Egyptian Arabic and mixed technical speech. Mixed-language span preservation and longer-lecture batching remain improvement areas and must be benchmarked before stronger quality claims are made.

## Search and organization

Stable web library structure is Semester/Course/Lecture. Courses can store a professor name and terminology glossary. Search can match lecture metadata, transcripts, notes, and glossary/course information.

## PWA / offline behavior

The stable manifest uses standalone display mode, and the service worker caches the application shell. LectureAI also detects installed PWA mode and checks for app updates.

Offline-first means the local library, saved recordings, transcript editing, notes, and playback can continue from already stored resources. On-device web speech transcription requires the model to have been downloaded/cached first.

### Important iOS/iPadOS limitation

A PWA cannot promise indefinite background recording. Keep LectureAI visible and avoid locking the screen or switching apps during an important lecture. Screen Wake Lock is requested where available, but it is best effort.

The free Expo Go target has a similar product-level warning: although it records through native Expo audio rather than Safari, stock Expo Go cannot apply LectureAI-specific background-audio configuration.

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

Stable web IndexedDB stores:

- `courses`;
- `lectures`;
- `audioChunks`;
- `audioFiles`;
- `attachments`;
- `settings`.

Large web audio does not use `localStorage`. LectureAI requests persistent browser storage when available and displays the browser's storage estimate when exposed.

The Expo target stores metadata through `expo-sqlite/kv-store` and keeps original audio as files under the project document directory instead of encoding large audio into key-value storage.

## Backup scope

The current stable web JSON backup contains course/lecture/settings metadata, transcript text, and notes stored in lecture records. It does **not** include original audio files or attachment blobs. Treat it as a metadata/text backup, not a complete lecture archive. A future full archive should include audio and attachments explicitly.

## Diagnostics

Settings → Diagnostics in the stable web app reports non-sensitive technical state such as:

- detected iPhone/iPad/Windows device type;
- browser/PWA mode;
- microphone permission;
- MediaRecorder availability and selected format;
- IndexedDB availability;
- on-device transcription support;
- Windows helper state/model/version.

Diagnostics should never include lecture audio or transcript contents.

## Development

Stable web:

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

Expo target:

```bash
cd expo-recorder
npm install
npm start
```

The branch includes separate GitHub Actions checks that bundle the Expo app for iOS and Android in addition to the stable web quality gates.

## Physical iPhone/iPad acceptance gate

Automated CI cannot prove real microphone routing, audible classroom quality, actual Expo Go behavior, iOS share destinations, background interruption behavior, or real transcript WER/CER.

Before claiming a production mobile pass:

- run `benchmarks/mobile-acceptance.md` for stable Safari/PWA behavior;
- run the acceptance gate in `expo-recorder/README.md` for the Expo Go target;
- test real mic routing and playback;
- test long recording and interruption/recovery behavior;
- test sharing to real installed apps;
- test delete/reclaim-storage behavior;
- benchmark English/Masri/MSA/code-switching/classroom noise against human-verified references;
- compare phone/iPad and Windows transcription separately.

Never publish an accuracy percentage without measured results.

## Privacy

LectureAI is local-first. It does not automatically upload recordings, transcripts, or notes to a cloud speech service. Manual exports/backups are user-controlled.

## License

See `LICENSE`.
