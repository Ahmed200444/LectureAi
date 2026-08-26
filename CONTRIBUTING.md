# Contributing to LectureAI

Thanks for your interest in improving LectureAI. The project is intended to be useful to students across phones, tablets, and laptops, so reliability, privacy, accessibility, and clear testing matter as much as adding features.

## Before you start

1. Read the README and ROADMAP.
2. Search existing issues before opening a new one.
3. For a bug fix, add clear reproduction details when possible.
4. For a larger feature or architectural change, open an issue first so the approach can be discussed before implementation.

## Good contribution areas

- iPhone/iPad recording reliability and recovery
- laptop/browser microphone diagnostics
- accessibility and keyboard navigation
- multilingual transcription evaluation for English, Egyptian Arabic (Masri), MSA, and code-switching
- transcript/timestamp verification UX
- automated tests and regression coverage
- documentation and contributor tooling
- source-tree and build cleanup

## Current repository note

The current deployment repository still reconstructs the application from a packaged source archive during the build. A roadmap task is to move the normal Vite/React/TypeScript source tree directly into the repository so contributors can work with a conventional development setup.

Until that cleanup is complete, please open or claim an issue before making large application-code changes.

## Local build

Requirements:

- Node.js 22.x
- npm

From the repository root:

```bash
npm install
npm run build
```

The current build process reconstructs the application into `app/` and runs its production build.

## Branches and commits

Use a short, descriptive branch name such as:

- `fix/recording-recovery`
- `feat/transcript-review`
- `docs/contributor-setup`
- `test/mobile-recording`

Keep commits focused and use short messages that describe the change, for example `Fix microphone recovery after interruption`.

## Pull request expectations

A pull request should explain:

- what changed
- why the change is needed
- how it was tested
- which devices/browsers are affected
- any privacy, storage, recording, or transcription implications

When relevant, test on more than one device class rather than assuming desktop behavior matches iPhone or iPad behavior.

## Project safeguards

Contributions should preserve these project rules:

- Never modify or overwrite the original lecture audio as part of preprocessing. Create derived copies instead.
- Do not require a paid per-minute speech API for the core workflow.
- Do not introduce artificial recording caps into the core experience.
- Do not claim guaranteed transcription accuracy.
- Do not claim guaranteed iPhone/iPad background recording.
- Do not commit API keys, tokens, passwords, private recordings, student information, or other sensitive data.
- Use only recordings or datasets that you have permission to use in tests.

## AI-assisted contributions

AI-assisted development is allowed, but contributors are responsible for reviewing, understanding, testing, and taking responsibility for the code they submit. Please do not submit large generated changes that have not been checked against the project behavior.

## Reporting security issues

Do not disclose exploitable security details in a public issue. Follow the process in [SECURITY.md](SECURITY.md).

## Conduct

By participating in the project, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
