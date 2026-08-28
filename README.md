# LectureAI

**Record → Transcribe → Verify → Create notes → Study**

LectureAI is a local-first progressive web app for real university lectures. It records long classes in recoverable chunks, preserves the original audio, accepts high-accuracy local English/Egyptian Arabic transcripts, synchronizes every transcript segment to audio, generates editable study notes automatically, and exports the current edited work to Microsoft Word.

LectureAI does not claim 100% transcription accuracy. Its design makes the remaining errors easy to find and verify against the original audio.

## What LectureAI is

The app is built around this source hierarchy:

1. **Original audio** — immutable source of truth.
2. **Original machine transcript** — text and timestamps returned by the recognition model.
3. **Corrected transcript** — student edits that never modify audio or timestamp boundaries.
4. **Generated notes** — editable study material grounded in transcript segments.

Core features:

- no artificial recording-duration limit or monthly transcription quota;
- five-second recording checkpoints in IndexedDB;
- crash/interruption recovery from completed chunks;
- original audio playback and export;
- English, Egyptian Arabic / Masri, MSA, and mixed-language transcript display;
- clickable timestamp **and** clickable sentence seeking;
- active-segment highlighting and optional Follow Transcript;
- low-confidence review queue with audio verification;
- corrected transcript kept separately from machine text;
- fully editable, autosaving notes with headings, lists, bold, italic, highlight, undo, redo, versions, and source timestamps;
- local course/semester organization, terminology glossaries, and full-library search;
- real DOCX export using the current edited notes;
- print-quality browser view for Save as PDF;
- installable PWA and offline access after the application shell has been cached;
- local Windows transcription using faster-whisper with no paid API.

## Supported devices

- **iPhone:** touch-first recording and review UI, Home Screen installation, safe-area-aware bottom navigation, and foreground-recording warnings.
- **iPad:** bottom navigation in portrait and a wider document workspace in landscape; all recording, transcript, note, search, and export features remain available.
- **Laptop/desktop:** persistent side navigation, wider transcript/note layouts, keyboard focus controls, local Windows transcription, and hardware-aware model selection.

The same local library format is used on every device. Browser storage is device-local, so moving a lecture between devices requires exporting audio/backup/transcript files; LectureAI does not silently cloud-sync private recordings.

## Cross-device Maximum Accuracy

`127.0.0.1` always means the device that is currently running the browser. An iPhone or iPad therefore cannot directly call the private Windows helper running on a laptop. LectureAI now treats this correctly:

1. Record and verify the lecture on iPhone/iPad.
2. Tap **Maximum Accuracy / Export for Windows** to export the original recording.
3. Transfer the audio file to the Windows laptop using your normal local file-transfer method.
4. Open LectureAI on Windows and choose **Import recording from phone/iPad**.
5. Start `start-lectureai.bat` if the Maximum Accuracy Engine is not already marked **Ready**.
6. The imported recording is queued and processed locally by faster-whisper.

The Windows helper remains loopback-only; this avoids exposing private lecture audio over the local network.

## Microphone safety and saved-audio validation

Before a real recording begins, LectureAI now verifies that the browser returned a live, enabled, unmuted microphone track and briefly confirms that real audio input is present. iPhone/iPad prefer MP4/AAC when Safari supports it; other devices choose the best supported format dynamically.

The recording timer starts only after microphone preflight succeeds. At the end of a lecture, the assembled recording is loaded back through the browser before the app says it is safely saved. Checkpoint chunks are kept until that playback validation succeeds, so a codec/load failure does not destroy the recovery source.

The microphone test records a real sample and only shows a confirmed working state after the user listens and confirms the sample is audible.

## Diagnostics

Open **Settings → Diagnostics** to see non-sensitive information including:

- detected device (iPhone, iPad, Windows, etc.);
- microphone permission state;
- MediaRecorder availability and selected recording MIME type;
- IndexedDB availability;
- on-device transcription support;
- Windows helper connection, model, and helper version;
- secure-context and installed-PWA state.

**Copy diagnostics** never includes lecture audio or transcript text.

## Architecture

| Layer | Implementation | Failure boundary |
|---|---|---|
| Recording | `MediaRecorder`, mono input, 128 kbps target, 5-second chunks | Finished chunks remain recoverable if the page closes |
| Persistent data | IndexedDB through `idb` | Audio, transcripts, and notes are separate records |
| Playback sync | Native `<audio>` time events and sentence-level timestamps | Seeking never changes transcript boundaries |
| Transcription | Local Python + faster-whisper | A failed job leaves original audio untouched |
| Notes | Deterministic, extractive local generator | A failed regeneration never overwrites edited notes |
| Export | `docx`, Markdown/text, browser print/PDF | Export failure does not mutate stored notes |
| Offline shell | Web app manifest + service worker runtime cache | Existing local library remains readable offline |
| Hosted UI | React/Vite with a non-recursive static Cloudflare Worker entry | Hosting is optional; the local app remains usable |

The IndexedDB schema contains `courses`, `lectures`, `audioChunks`, `audioFiles`, `attachments`, and `settings`. Transcript segments, translations, bookmarks, note versions, and processing state live in each lecture record. Large binary content never uses `localStorage`.

## Installation

### Windows beginner setup

Requirements:

- Windows 10/11;
- Python 3.11 or 3.12, with **Add Python to PATH** selected;
- Node.js 22 or newer;
- enough free space for recordings and the selected model;
- optional NVIDIA GPU for much faster transcription.

Double-click:

```text
setup-windows.bat
```

The setup creates a private Python environment, installs open-source dependencies, detects hardware, shows model download/storage requirements, and asks before downloading a model. It does not silently download `large-v3`.

For normal use, double-click:

```text
start-lectureai.bat
```

This starts the web app at `http://localhost:3000` and the loopback-only transcription helper at `http://127.0.0.1:8765`.

If you prefer to keep using the hosted `chatgpt.site` UI on your Windows laptop, double-click:

```text
start-helper-for-hosted-site.bat
```

That starts only the private loopback transcription engine and opens the hosted LectureAI URL, avoiding accidental switching between the hosted browser library and the separate `localhost` browser library.

### Developer setup

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Microphone access works on `localhost`; a non-local phone URL must use HTTPS.

## Running locally

1. Start LectureAI.
2. Create a course and add technical terms to its glossary.
3. Select **Start a new recording**.
4. Acknowledge recording consent once.
5. Run the 12-second microphone test from the phone’s intended desk position.
6. Keep LectureAI visible, tap **Start a new recording**, and mark important moments as needed.
7. Tap **Stop recording** whenever you need a break. This stops capture but keeps the current lecture open; **Continue current recording** resumes into the same lecture ID and does not create a second library item.
8. Use **Finish & save current lecture** when the lecture is over. A separate lecture is created only after you explicitly choose **Start a new recording**.
9. Wait for the successful-save screen before closing the app.

There is no 30-, 60-, 90-, or 120-minute application limit. Available storage, battery, browser behavior, and operating-system restrictions are the real limits.

## Installing on iPhone or iPad

1. Open the HTTPS LectureAI URL in Safari on the iPhone or iPad.
2. Tap **Share**.
3. Tap **Add to Home Screen**, then **Add**.
4. Open LectureAI from the new Home Screen icon.
5. Grant microphone access when asked.

Safari 26 allows any site to be saved as a web app; earlier versions rely more heavily on manifest/site configuration. LectureAI includes both a manifest and Apple web-app metadata. See Apple’s [Safari 26 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes).

## Recording lectures

- Prefer rows 1–3; rows 4–5 are a secondary target.
- Put the phone on a stable desk with its microphone opening unobstructed.
- Aim the microphone end generally toward the professor.
- Do not cover the phone with paper or place it against a vibrating laptop/fan.
- Use the microphone test and listen to the sample before an important class.
- Keep enough battery and several gigabytes of free storage for long sessions.
- Tap **Mark moment** instead of interacting with the full app during class.

LectureAI requests unprocessed microphone capture where possible and leaves browser automatic gain enabled. It does not aggressively remove noise or overwrite audio. Any future enhancement must create a derived copy and must be benchmarked against the raw recording.

## iOS limitations

MediaRecorder is supported by modern Safari, and Safari 18.4 added WebM/Opus support; LectureAI feature-detects formats and falls back to MP4/AAC where appropriate. See [WebKit’s MediaRecorder documentation](https://webkit.org/blog/11353/mediarecorder-api/) and Apple’s [WWDC25 Safari media update](https://developer.apple.com/videos/play/wwdc2025/233/?time=558).

The important limitation is background execution. iOS normally suspends apps in the background, and native background capabilities require an Xcode app entitlement; a PWA cannot promise the same indefinite background recording behavior as a purpose-built native recorder. Apple documents that native apps are normally suspended and only approved modes continue in the background in [Configuring background execution modes](https://developer.apple.com/documentation/Xcode/configuring-background-execution-modes?changes=__8).

Therefore:

- keep LectureAI open and visible while recording;
- do not lock the screen or switch apps during an important class;
- LectureAI requests Screen Wake Lock when the browser supports it;
- the app warns on visibility changes and guards navigation;
- completed five-second chunks are recoverable, but iOS can still stop the capture process;
- test 60, 90, and 120 minutes on the exact iPhone/iOS version before relying on it.

If foreground PWA recording is not reliable enough on the target device, use the built-in iPhone Voice Memos app for capture, preserve that original file, and import/export it through the Maximum Accuracy workflow. A future native build is the strongest route for guaranteed iOS background audio, but it requires Apple’s native toolchain and distribution choices.

## Long recording architecture

`MediaRecorder.start(5000)` emits approximately five-second chunks. Every non-empty chunk is written immediately to IndexedDB with the lecture ID and monotonic index. The lecture itself is marked `recording`. On next launch, unfinished recordings become `interrupted` and expose **Recover recording**.

Normal stop waits for the recorder’s final event and all pending writes, combines chunks in index order into an immutable original audio blob, then deletes only the temporary chunks. A crash can lose the in-progress browser buffer and any operating-system write not completed, but it should not lose all prior class time.

The architecture has no duration counter that stops the recording. Long-duration success still depends on browser quota, remaining disk, battery, thermal state, memory pressure, and iOS foreground behavior.

## Local storage

- Audio blobs: IndexedDB `audioFiles`.
- Recovery chunks: IndexedDB `audioChunks`.
- Courses, lectures, transcripts, notes, bookmarks, and settings: IndexedDB object stores.
- PWA shell: Cache Storage through `public/sw.js`.
- Downloaded Whisper models: local `models/` folder on Windows.

The browser decides its storage quota. LectureAI requests persistent storage when available, displays the browser’s storage estimate, warns during checkpoint failure, and never automatically deletes lectures.

Private recordings, transcripts, exports, backups, benchmarks, local models, and Python environments are excluded by `.gitignore`.

## Transcription engine

Maximum Accuracy mode uses [faster-whisper](https://github.com/SYSTRAN/faster-whisper), a CTranslate2 implementation of multilingual Whisper. It runs locally and does not call the OpenAI API or another paid speech service.

Default accuracy-oriented settings include:

- multilingual language detection instead of forcing English or generic Arabic;
- beam search (`beam_size=8`, `best_of=8`);
- original-transcript task, not translation;
- word timestamps;
- conservative voice-activity filtering with speech padding;
- course glossary and context terms in the initial prompt;
- low-confidence marking based on model log probability;
- no destructive preprocessing of the source audio.

The app accepts sentence/phrase segments with start/end time, original text, edited text, language, confidence, review status, and optional speaker.

## English + Egyptian Arabic

LectureAI deliberately uses a multilingual model and an instruction prompt that expects English, Egyptian Arabic / Masri, MSA, and natural code-switching. It asks the model to preserve English technical terms inside Arabic speech. A glossary supplies likely course terms as context; it never replaces the acoustic evidence.

Do not force `language="ar"` for a mixed lecture. That can damage English terminology. The model still makes mistakes, especially with quiet far-field speech, overlapping students, reverberation, names, and rare terminology. Review every low-confidence segment against audio.

## Maximum Accuracy mode

### Direct local connection

1. Run `start-lectureai.bat` on the computer containing the recording.
2. Record and finish a lecture. LectureAI automatically creates a transcription job when the helper is available.
3. LectureAI sends the saved audio only to `127.0.0.1:8765` on that computer and displays live job progress.
4. The helper uses the strongest configured multilingual model, returns timestamped segments, and LectureAI generates editable notes automatically.

**Maximum accuracy** remains available as an explicit retry or device choice when automatic helper detection is unavailable.

The helper binds to loopback only and rejects unsupported filename extensions. Uploads go to a generated temporary directory, have an 8 GB local safety ceiling, are deleted after processing, and cannot select arbitrary filesystem paths.

### Advanced file transfer fallback

1. In the lecture, export **Original audio**.
2. Move it to the Windows computer using a cable, AirDrop-to-Mac then USB/network, or another user-controlled transfer.
3. Drag the audio file onto `transcribe-lecture.bat`.
4. Select `large-v3` for important lectures when hardware permits.
5. Import the generated `.lectureai.json` from the lecture’s **Advanced: Import Transcript JSON** action.
6. LectureAI validates every segment, keeps original/corrected text separately, and creates notes automatically.

This is a recovery/advanced workflow, not the normal post-recording experience.

## Windows setup

`setup-windows.bat` performs hardware detection and shows:

- CPU and logical cores;
- system RAM;
- NVIDIA GPU and VRAM through `nvidia-smi`, when available;
- free system-disk space;
- recommended model;
- approximate model download size, final storage, and memory requirement.

CUDA acceleration comes through the installed faster-whisper/CTranslate2 stack. If CUDA libraries or a compatible driver are unavailable, choose CPU mode or follow the current faster-whisper GPU installation guidance. CPU transcription is valid but may take longer than the lecture duration.

## Local AI models

| Mode | Model | Approx. download | Suggested hardware | Tradeoff |
|---|---|---:|---|---|
| Fast | `small` multilingual | ~500 MB | 4+ GB RAM | Faster, more errors in far-field/code-switched speech |
| Balanced | `medium` multilingual | ~1.5 GB | 8+ GB RAM or 6+ GB VRAM | Strong practical middle ground |
| Maximum Accuracy | `large-v3` multilingual | ~3.1 GB | 16+ GB RAM or 10+ GB VRAM preferred | Best target quality; slowest and largest |

Sizes are estimates and can change with model packaging. Setup always displays the choice and asks before download. Benchmark the models on the user’s real classroom rather than assuming the largest model always wins.

## Phone mode

**Transcribe on Phone** downloads a multilingual Whisper Small model only after the user chooses that action. It runs in a dedicated browser worker, reports model-download and transcription progress, and stores the model in browser cache for later offline use. If the model is already installed and the device supports the required browser features, a newly finished recording starts phone transcription automatically when the Windows helper is unavailable.

For important English/Egyptian Arabic lectures, **Maximum Accuracy on Computer** uses the stronger configured local model. Phone transcription remains useful offline but may be slower and less accurate on long, noisy, far-field, or heavily code-switched recordings. Low-confidence segments are marked for review against the original audio.

## Clickable transcript

- Tap the timestamp to seek and play.
- Tap the sentence to seek and play.
- The current sentence highlights as audio advances.
- Seeking updates the highlight immediately.
- **Follow transcript** scrolls the active sentence gently into view and can be disabled.
- Player controls include play/pause, seek bar, −10, −5, +5, +10, and 0.75×–2× speed.

Use **Edit transcript** to save corrections in the separate Corrected view. The original machine transcript and timestamp boundaries stay intact so every edit remains auditable against the recording.

Use **Delete recording & lecture** in Attachments to remove the selected lecture, its original audio, transcript, notes, checkpoints, and attachments after an explicit confirmation. The application does not repopulate deleted lectures with demo data.

Production starts with an empty lecture and course library. Lecture cards and playback controls appear only for recordings or imports the user actually creates.

## Automatic notes

After a transcript is returned by the phone model, Windows helper, or advanced import fallback, LectureAI automatically builds:

- Lecture Summary;
- Detailed Lecture Notes;
- Key Concepts;
- Definitions;
- Examples;
- Formulas / Technical Information;
- Important Professor Notes;
- Possible Exam Topics;
- Study Questions.

Version 1 uses a deterministic extractive generator. It does not invent outside facts and labels exam-topic suggestions as suggestions. Supporting timestamps remain clickable. A local LLM can be added later only if its output is source-grounded and never modifies the transcript.

## Editing notes

The note surface is a lightweight document editor. It supports free text, deletion, headings, bold, italic, highlight, bulleted/numbered lists, browser undo/redo, and source timestamp links. Edits are sanitized with DOMPurify and autosaved to IndexedDB after a short debounce.

**Original generated notes** are protected. Regeneration creates a preview and requires one of these explicit choices: replace current notes, keep existing, save as alternative, or cancel. Replacing first snapshots the edited version.

## Exporting to Word

Open a lecture, choose **Export → Word document (.docx)**. The generated document uses:

- course name/code, professor, date, and duration;
- current edited notes, not the original draft;
- complete corrected transcript with start/end timestamps;
- RTL paragraph settings when Arabic script is present.

Markdown and TXT exports are also direct downloads. **Print / Save as PDF** opens a sanitized print document so the browser can create a PDF while retaining the device’s Arabic fonts.

## Course glossary

Create one glossary per course. Include technical terms, professor/name spellings, abbreviations, formula names, software, and people. Use commas or new lines. The Windows helper limits prompt context to 250 short terms to prevent oversized or malicious prompt content.

PDF/TXT/Markdown context can also be passed to `local-ai/transcribe.py` with repeated `--context` arguments. Text is extracted locally and used only as terminology guidance. Slide text never replaces spoken content.

## Translation views

Original, English, and Arabic views are separate fields. The original view is never overwritten or silently translated. Version 1 prioritizes the original multilingual transcript; its translation tabs show separate pending content where a trustworthy local translation has not been generated.

A future local translation model should translate only the necessary sections, preserve technical English terms appropriately, and store its output separately. No paid translation API is required by the core app.

## Backup

Settings → **Export local backup** downloads JSON containing course metadata, glossaries, lectures, timestamps, corrected transcripts, notes, bookmarks, and processing state. Audio is intentionally exported per lecture so large backups do not require building an enormous in-memory archive. Never commit or share private backups unintentionally.

## Privacy

- No required account.
- No ad network or transcript analytics.
- No automatic recording upload.
- No OpenAI, Google, Azure, AWS, or Anthropic API.
- Local helper binds to `127.0.0.1`, not the LAN.
- Original audio is never destructively modified.
- Imported transcript JSON has a 50 MB browser limit and validated timestamp/text fields.
- Attachments have a 100 MB browser limit and are stored as inert blobs.
- Notes HTML is sanitized before display, save, and export.
- Downloads use sanitized filenames.
- The Python service ignores the uploaded filename for paths and writes only inside a temporary directory.

This is a privacy architecture, not a substitute for recording permission. Follow university rules and applicable law.

## Security review

| Risk | Control |
|---|---|
| XSS in transcript import | Imported text renders as React text, not HTML |
| XSS in note editing/import | DOMPurify sanitization; no script/event attributes preserved |
| Path traversal | Browser filenames are download-sanitized; server uses generated temp paths |
| Malicious document import | Attachments are stored inertly; the browser does not execute them |
| Oversized upload | 50 MB transcript, 100 MB attachment, and 8 GB local-audio safety limits |
| Secret leakage | No core secrets; `.env*`, audio, transcripts, models, and private benchmarks ignored |
| Destructive processing | Raw audio is read-only; temporary/derived files are separate |
| Accidental deletion | Explicit confirmation before lecture/audio deletion |
| Local-service exposure | Loopback bind and explicit CORS origin allowlist |

## Search and organization

The hierarchy is Semester → Course → Lecture. Search covers lecture/course metadata, professor, glossary, original/corrected transcript text, and current notes. Transcript hits include a source timestamp and open the exact lecture.

## Troubleshooting

### Microphone permission denied

Use Safari/Chrome site settings to allow the microphone, reload LectureAI, and rerun Test Microphone. Microphone capture requires HTTPS except on `localhost`.

### Recording stopped after switching apps on iPhone

This is an iOS/PWA limitation, not an artificial LectureAI limit. Return to LectureAI, open the interrupted lecture, and choose **Recover recording**. For the next class, keep the app visible or use Voice Memos as the capture source.

### Storage checkpoint warning

Stop as soon as practical. Export existing audio, remove unrelated browser data manually, and free device storage. LectureAI never deletes another lecture automatically.

### Windows helper is not running

Run `start-lectureai.bat`, keep the local transcription window open, and retry. If a hosted HTTPS page cannot reach the loopback service because of browser private-network policy, use `transcribe-lecture.bat` and import JSON.

### NVIDIA/CUDA error

Update the NVIDIA driver and follow faster-whisper’s current CUDA/cuDNN requirements, or use CPU mode. The original audio remains safe.

### Model download interrupted

Rerun `local-ai/setup_model.py` inside the `.venv`. The Hugging Face/CTranslate2 cache resumes or verifies model files. Setup asks before downloading.

### Arabic ordering looks wrong in an export

Use Word or the print/PDF path on a device with an Arabic-capable font. Transcript/notes use `dir="auto"`, Unicode bidi handling, and DOCX RTL paragraph flags, but final layout also depends on the reader application and installed fonts.

## Accuracy limitations

Accuracy depends on distance, microphone orientation, professor volume, room reverberation, noise, overlapping speech, terminology, and hardware/model choice. Rows 1–3 are the primary target; rows 4–5 can be usable but are more difficult. Quiet words removed by aggressive denoising cannot be recovered, so raw audio is the default.

Confidence is a useful review signal, not a calibrated guarantee. Whisper can hallucinate during long silence or noise; VAD and hallucination controls reduce but do not eliminate this. Always verify important claims, formulas, names, and exam instructions against audio.

Use `benchmarks/README.md` and `benchmarks/evaluate.py` to calculate WER/CER on consented recordings. Do not publish an accuracy percentage until the measured dataset, conditions, model, and review procedure are documented.

## Testing

Run the automated quality gate:

```bash
npm run check
```

Individual commands:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

Automated tests cover time/filename formatting, mixed-language transcript import, invalid timestamp rejection, automatic note sections/source links, chunk ordering, audio assembly, and checkpoint cleanup. Browser microphone permission, real audio capture, PWA install, iPhone background behavior, and long-duration reliability require the real-device checklist in `benchmarks/README.md`.

## Zero-cost audit

The required core has no recurring service charge and no billing-based minute quota.

| Dependency/service | Purpose | Cost / free limitations | Account | Data leaves device? | Offline? | If it disappears |
|---|---|---|---|---|---|---|
| React / React DOM | UI | Open-source, no usage fee | No | No | Yes | Built app keeps working; source can migrate |
| React / Vite | Build/runtime | Open-source, no usage fee | No | No at runtime | Yes locally | Static worker entry avoids server-rendering loops |
| IndexedDB + `idb` | Local records/blobs | Browser quota only | No | No | Yes | Native IndexedDB API can replace wrapper |
| MediaRecorder / Web Audio | Recording and level meter | Browser/device limits | No | No | Yes | Native recorder/import workflow remains fallback |
| DOMPurify | Notes sanitization | Open-source, no usage fee | No | No | Yes | Replace with maintained local sanitizer |
| Lucide React | Interface icons | Open-source, no usage fee | No | No | Yes | Replace with text/native controls |
| `docx` | Word export | Open-source, no usage fee | No | No | Yes | Markdown/print export remains |
| Service worker / Cache Storage | Offline app shell | Browser quota only | No | No | Yes | Online/local server still works |
| faster-whisper / CTranslate2 | Local multilingual transcription | Free; compute/storage are the user’s | No for already downloaded models | Model download only; recordings stay local | Yes after download | `whisper.cpp` or another local engine can replace it |
| Whisper model files | Speech model | Free download; ~0.5–3.1 GB | Model host may not require one | Download request only | Yes after download | Existing local files continue working |
| FastAPI / Uvicorn | Loopback helper | Open-source, no usage fee | No | No | Yes | CLI transcription remains available |
| psutil / pypdf | Hardware/context extraction | Open-source, no usage fee | No | No | Yes | Detection/context are optional |
| Python / Node.js | Local runtimes | Free | No | No | Yes | Versions can be archived or replaced |
| Vitest / jsdom / fake-indexeddb / ESLint / TypeScript | Development QA | Open-source, no usage fee | No | No | Yes after install | Runtime app unaffected |
| Sites hosting | Optional HTTPS/PWA URL | Subject to the user’s OpenAI workspace offering; not required for local core | Possibly | Static app code only; lecture data stays in browser | Installed app works offline after caching | Run locally or host static/worker build elsewhere |

No dependency bills by recorded/transcribed minute. Electricity, computer/phone hardware, disk space, and internet used to install packages/models are real user resources but not LectureAI subscriptions.

## Project layout

```text
src/                 Responsive browser-first application shell
styles/              Shared iPhone, iPad, and laptop layout styles
components/          Recording, lecture player, transcript, notes UI
hooks/               Chunked MediaRecorder lifecycle
lib/                 IndexedDB, notes, import/export, models
local-ai/            faster-whisper CLI and loopback server
benchmarks/          WER/CER tool and real-device checklist
tests/               Automated persistence/import/note tests
public/              PWA service worker, icons, social preview
setup-windows.bat    First-time setup
start-lectureai.bat  Normal local launcher
transcribe-lecture.bat  File-based Maximum Accuracy workflow
```

## License and recording policy

Choose a project license before distributing the source. Lecture recordings remain the user’s private data and are not licensed by this repository. Always obtain permission to record.
