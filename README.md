# LectureAI Open Source Core

**Record. Verify. Learn.**

LectureAI Open Source Core is a local-first web project for lecture recording and study workflows. It provides a transparent browser-based foundation that contributors can inspect, run, test, and improve without requiring a paid speech API.

This repository is maintained by **Ahmed200444** and is released under the MIT License.

## What is implemented

The current open-source core includes:

- browser microphone permission and readiness checks
- lecture audio recording with `MediaRecorder`
- microphone-level feedback
- recording duration tracking
- local playback and audio export
- device/browser diagnostics
- iPhone, iPad, Windows, Mac, and other-device detection
- locally saved lecture titles and study notes
- installable/offline-capable PWA basics
- automated JavaScript checks and unit tests through GitHub Actions

## What is not claimed yet

The public core does **not** currently claim to provide completed automatic lecture transcription. Multilingual transcription for English, Egyptian Arabic (Masri), Modern Standard Arabic (MSA), and mixed technical vocabulary remains an active roadmap area.

It also does not claim guaranteed background recording on iPhone/iPad or guaranteed transcription accuracy. Browser behavior, operating-system restrictions, microphone quality, room noise, and speaker distance can all affect results.

## Why this project exists

Students often need more than a raw voice memo: they need to know whether the microphone is actually working, preserve a usable original recording, organize notes, and later verify AI-generated text against the source audio. LectureAI is being developed around that workflow.

The open-source project focuses on four principles:

1. **Local-first by default** — core recording and notes should not require uploading private lecture data.
2. **Original audio is the source of truth** — derived processing should never silently replace the original recording.
3. **Cross-device behavior must be tested separately** — desktop success does not prove iPhone/iPad behavior.
4. **No fake accuracy claims** — future transcription improvements should be measured with reproducible evaluation cases.

## Run locally

No third-party runtime dependencies are required for the current web core.

```bash
git clone https://github.com/Ahmed200444/LectureAi.git
cd LectureAi
npm run ci
```

Then serve the repository over `localhost` or HTTPS. For example, if Python is installed:

```bash
python -m http.server 8080
```

Open `http://localhost:8080` in your browser. Microphone APIs generally require a secure context; browsers treat `localhost` as secure for development.

## Tests

```bash
npm test
```

The CI workflow also performs JavaScript syntax validation and confirms that the expected public project files are present.

## Contributing

Contributions are welcome. Useful areas include:

- iPhone/iPad recording reliability and recovery
- browser/device diagnostics
- accessibility and keyboard navigation
- multilingual transcription evaluation
- timestamp-linked transcript review
- local storage and privacy improvements
- regression tests and documentation

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. The [ROADMAP.md](ROADMAP.md) lists larger project priorities.

## Privacy

Do not upload private lecture recordings, student information, credentials, API keys, or access tokens to issues or pull requests. Use synthetic, public-domain, or explicitly permitted test data.

See [SECURITY.md](SECURITY.md) for security reporting guidance.

## License

MIT. See [LICENSE](LICENSE).
