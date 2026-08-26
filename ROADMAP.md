# LectureAI Roadmap

This roadmap describes current open-source priorities. It is not a promise of release dates.

## Current foundation

The open-source core now provides a conventional, inspectable web source tree with browser recording, microphone diagnostics, local notes, PWA basics, unit tests, and GitHub Actions validation.

## 1. Recording reliability

- Expand iPhone/iPad Safari testing for permission changes, interruptions, locking, navigation, and recovery.
- Add repeatable recording regression tests where browser APIs can be safely mocked.
- Improve messages when an operating-system or browser restriction cannot be worked around.
- Preserve exported original audio as the source of truth.

## 2. Multilingual transcription

- Define an open transcription interface that does not lock the project to one paid provider.
- Build a reproducible evaluation set for English, Egyptian Arabic (Masri), MSA, and code-switched technical lectures.
- Measure word/segment errors and document qualitative failures such as names and technical terms.
- Add glossary support for course-specific terminology.
- Keep accuracy claims tied to reproducible tests rather than marketing language.

## 3. Timestamp-linked review

- Associate transcript segments with recording timestamps.
- Add click-to-seek review from transcript text to source audio.
- Make uncertain segments easy to correct manually.
- Preserve edits separately from raw model output where practical.

## 4. Local-first study workflow

- Improve longer-form note organization.
- Add local lecture history without requiring a cloud account.
- Explore IndexedDB for persistent local recording metadata and optional local blobs.
- Add export/import for user-controlled backups.

## 5. Accessibility and quality

- Audit keyboard navigation, screen-reader labels, focus management, contrast, and touch targets.
- Add automated accessibility checks where practical.
- Expand unit and browser-level regression coverage.
- Keep mobile and desktop test results separate when platform behavior differs.

## 6. Contributor experience

- Add device-specific testing documentation.
- Add screenshots or short permitted demo media.
- Improve issue labels and newcomer tasks as real needs are identified.
- Keep CI fast and dependency-light.

## Contributing

If you want to work on an item, check open issues first. If none exists, open an issue describing the problem, proposed approach, and testing plan before starting a large change.
