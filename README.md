# LectureAI

**Record. Verify. Learn.**

LectureAI is a local-first university lecture recorder and study tool built for iPhone, iPad, Windows, and modern laptops. It is designed for multilingual classes and supports English, Egyptian Arabic (Masri), Modern Standard Arabic (MSA), and mixed technical vocabulary.

The project focuses on keeping the original lecture audio as the source of truth, making transcripts easy to verify against timestamps, and turning recordings into editable study material without forcing students into per-minute transcription billing or artificial recording limits.

## Why LectureAI

Lecture recordings are often difficult to review, especially when a class switches between languages or uses technical terms that ordinary speech-to-text tools misunderstand. LectureAI aims to provide one workflow for recording, transcription, verification, notes, and study review while keeping user data local by default.

## Core principles

- **Local-first:** recordings, transcripts, notes, course data, and glossaries are intended to stay on the user's device by default.
- **Original audio is preserved:** preprocessing or denoising should create derived copies rather than modifying the original recording.
- **Verify, don't blindly trust:** transcripts are editable and designed to be checked against timestamped audio.
- **Multilingual by design:** English, Egyptian Arabic, MSA, and mixed-language technical terms are first-class use cases.
- **No fake accuracy claims:** transcription quality varies with microphone quality, room noise, speaker distance, accents, and device/browser behavior.
- **Student-friendly economics:** the core workflow is designed not to depend on paid per-minute runtime speech APIs.

## Current capabilities

- Lecture recording workflow for iPhone, iPad, and laptops
- Microphone validation, recording recovery, and diagnostics
- Multilingual transcription workflow for English / Masri / MSA
- Timestamp-linked transcript and audio review
- Editable transcripts and study notes
- Local Windows **Maximum Accuracy** helper workflow
- Local-first storage for lecture data
- Progressive Web App deployment

## Project status

LectureAI is under active development. Device and browser behavior can differ, especially on mobile Safari. The project does **not** claim guaranteed transcription accuracy or guaranteed background recording on iPhone/iPad.

The repository is also being cleaned up for easier public contribution. The current deployment setup reconstructs the web application from a packaged source archive during the build. Moving the normal application source tree directly into the repository is a high-priority open-source task tracked in the roadmap.

## Build

Requirements:

- Node.js 22.x
- npm

Install the root deployment dependencies and run the production build:

```bash
npm install
npm run build
```

The current build script reconstructs the application into `app/`, installs its dependencies, and runs the application production build. A conventional contributor development workflow will replace this packaging step as the source-tree cleanup is completed.

## Contributing

Contributions are welcome. Good areas to help with include:

- iPhone/iPad recording reliability
- accessibility and keyboard navigation
- browser/device diagnostics
- multilingual transcription evaluation
- tests and regression coverage
- documentation
- build and contributor tooling

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Larger changes should begin with a GitHub issue so the approach can be discussed first.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for current open-source, reliability, transcription-quality, and study-workflow priorities.

## Privacy and security

Please do not upload real private lecture recordings, student information, API keys, access tokens, or other sensitive data to GitHub issues or pull requests. Security reports should follow [SECURITY.md](SECURITY.md).

## License

LectureAI is released under the [MIT License](LICENSE).
