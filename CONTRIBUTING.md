# Contributing to LectureAI

Thanks for helping improve LectureAI. The project welcomes bug fixes, tests, documentation, accessibility improvements, and well-scoped features.

## Before starting

1. Read the README and ROADMAP.
2. Search existing issues before opening a new one.
3. For larger behavior or architecture changes, open an issue first and describe how you plan to test the change.
4. Never use a private class recording or another person's personal data as public test material.

## Development setup

The current open-source web core has no third-party runtime dependencies.

```bash
npm run ci
```

To use microphone features, serve the repository from `localhost` or HTTPS. One simple development server is:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080`.

## Good contribution areas

- iPhone/iPad recording behavior and recovery
- Windows/Mac/browser microphone diagnostics
- accessibility and keyboard navigation
- automated regression tests
- PWA/offline behavior
- local-first storage
- multilingual transcription benchmarks and evaluation tooling
- timestamp-linked transcript review
- documentation

## Pull requests

A good pull request should explain:

- what changed
- why the change is useful
- how it was tested
- which browsers/devices were tested when relevant
- any privacy, recording, storage, or network implications

Please keep pull requests focused. Small fixes are easier to review and safer to merge.

## Project safeguards

Contributions should preserve these rules:

- Do not silently overwrite the original lecture recording.
- Do not require a paid per-minute speech service for the core recording workflow.
- Do not add artificial recording caps to the open-source core.
- Do not claim guaranteed transcription accuracy.
- Do not claim guaranteed background recording on iPhone/iPad.
- Do not commit passwords, tokens, API keys, `.env` files, private recordings, or student information.
- Use only synthetic, public-domain, or explicitly permitted data in public tests.

## AI-assisted contributions

AI-assisted development is allowed, but the contributor is responsible for reviewing, understanding, and testing the submitted code. Large generated changes that have not been checked should not be submitted.

## Commit style

Use concise, descriptive messages, for example:

- `Fix recording stop state on Safari`
- `Add microphone diagnostics test`
- `Improve notes keyboard navigation`

## Security and conduct

For security-sensitive problems, follow [SECURITY.md](SECURITY.md) instead of publishing exploit details in an issue.

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
