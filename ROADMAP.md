# LectureAI Roadmap

This roadmap describes the project's current priorities. It is not a promise of release dates; priorities may change as testing and contributor feedback uncover more important work.

## 1. Open-source readiness

- Move the normal Vite/React/TypeScript application source tree directly into the repository instead of reconstructing it from a packaged archive.
- Add a simple, reproducible local development command.
- Add automated typecheck, lint, test, and production-build checks for pull requests.
- Audit the repository for secrets, credentials, private recordings, and generated deployment artifacts before public release.
- Keep contributor documentation and issue templates current.

## 2. Recording reliability

- Continue testing microphone permissions and device detection across iPhone, iPad, Windows, and other laptops.
- Improve recovery when a recording is interrupted by browser or operating-system behavior.
- Improve diagnostics when a microphone is unavailable, blocked, muted, or misconfigured.
- Preserve the untouched original recording as the source of truth while allowing derived preprocessing copies.

## 3. Transcription quality and verification

- Build repeatable evaluation cases for English, Egyptian Arabic (Masri), MSA, and code-switched technical lectures.
- Measure transcription changes instead of relying only on subjective impressions.
- Improve technical-term and glossary handling.
- Keep timestamp-linked audio review fast so users can verify uncertain transcript segments.
- Avoid claims of guaranteed accuracy; document known limitations by device and environment.

## 4. Study workflow

- Improve transcript editing and note organization.
- Make it easier to move from a verified transcript to useful study notes.
- Improve search and navigation through longer lectures.
- Keep the core workflow local-first and usable without per-minute transcription billing.

## 5. Accessibility and quality

- Improve keyboard navigation and focus behavior.
- Review labels, contrast, responsive layout, and screen-reader behavior.
- Expand automated regression tests around recording, recovery, storage, and transcript editing.
- Keep mobile and desktop behavior covered separately where browser capabilities differ.

## Contributing to the roadmap

If you want to work on one of these items, check the open issues first. If no issue exists, open one describing the problem, proposed approach, and how you would test it.
