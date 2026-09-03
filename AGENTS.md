# LectureAI Codex / agent instructions

## Scope
Work on LectureAI as a local-first lecture recording, transcription, notes, study, and export app. Preserve the stable production app unless a change is explicitly intended for release. The active integration branch is `expo-unified-lectureai`; PR #28 must stay draft until the physical iPhone + iPad acceptance gate passes.

## Non-negotiable product invariants
1. The original lecture audio is the source of truth. Never overwrite, transcode in place, trim, or delete the original as part of transcription, notes, translation, export, recovery, or cleanup.
2. A saved recording is not considered verified merely because a file exists. Keep explicit playback verification and recovery warnings.
3. Expo Go is the free native-feeling iPhone/iPad route. Do not claim guaranteed locked-screen/background recording in stock Expo Go.
4. iPhone and iPad are separate physical acceptance targets. A passing iPhone test does not imply iPad has passed.
5. Do not invent transcription accuracy percentages. Benchmark results must come from human-verified samples.
6. Unknown speakers must remain neutral (`Speaker`) unless real diarization exists.
7. Derived notes/study/translation content must become stale after transcript text changes and must not silently remain current.
8. `[uncertain]` / `[inaudible]` transcript text must not be promoted into trusted notes/study facts.
9. Paired Windows transcription is for trusted private/home Wi-Fi only. Preserve authentication, rate limiting, SecureStore token handling, transfer integrity checks, and the explicit warning that the LAN HTTP transport is not end-to-end encrypted.

## Supabase
The currently connected Supabase project already contains StudyCore-style tables such as `subjects`, `documents`, `lecture_imports`, `notes`, `flashcards`, quizzes, mastery, planner, and AI threads/messages. Do not repurpose or destructively modify those tables for LectureAI without an explicit migration plan.

If LectureAI cloud features are added, keep them opt-in and local-first:
- local recording + local library remains the default;
- prefer syncing metadata, transcript, notes, study data, and recovery metadata before syncing raw audio;
- raw lecture audio must never be uploaded silently;
- use separate LectureAI tables/schema or a clearly versioned integration path;
- enforce RLS/user ownership on every user-data table;
- never ship service-role credentials to web/Expo clients;
- run Supabase security and performance advisors after DDL changes.

The existing `lecture_imports` structure may be used later as an explicit StudyCore import bridge if its contract is documented and tested. Do not assume that bridge is enabled merely because the table exists.

## SEO / public web
SEO applies to the public LectureAI website/launch pages, not private lecture content inside Expo. Preserve privacy and do not add analytics/tracking just to improve SEO.

Current SEO-God/OpenSEO config exists in `seo-god.json`, but OpenSEO is not installed and Google Search Console is not connected. Do not claim those phases are complete. After the final Cloudflare production URL exists, update canonical URLs, sitemap, robots, Open Graph/schema URLs, and `seo-god.json` together, then run the SEO audit against the real production URL.

## Cloudflare
The web/launch side is Cloudflare Pages-ready. Build with:
- `npm run build`
- output directory: `dist/client`

Do not treat Cloudflare as the Expo runtime. Cloudflare hosts the public website/launch pages; Expo Go runs the iPhone/iPad app during the free testing phase.

## Validation before saying a code head is green
Root app:
- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`

Expo app (`expo-recorder`):
- install dependencies
- `npx expo install --check`
- `npx expo-doctor`
- export/bundle iOS
- export/bundle Android

Python/helper:
- compile/check helper Python
- run benchmark evaluator self-tests
- run pairing/auth tests

CI passing is necessary but does not replace physical-device acceptance.

## Physical merge gate for PR #28
Do not merge or call the Expo build production-proven until both iPhone and iPad have documented passes for the relevant checks:
- start -> pause -> continue -> mark -> finish -> playback;
- reopen Expo Go/project and replay preserved audio;
- Share / Save to Files and text/data exports;
- microphone routing with and without Bluetooth/headphones where available;
- interruption/recovery test where practical;
- 30 / 60 / 90 / 120-minute recordings when storage/battery permit;
- paired Windows helper connection on trusted Wi-Fi and a real transcription round trip, including a larger recording;
- transcript correction -> stale derived content -> regeneration -> timestamp seeking;
- deletion removes intended local original + metadata without leaving duplicate aliases.

## Change discipline
- Prefer branch commits and PR review; do not push experimental work directly to `main`.
- Do not merge PR #24 casually; it is an older native-iOS candidate with separate unresolved history.
- Keep docs synchronized with actual runtime behavior.
- When a limitation cannot be solved in Expo Go, state it clearly instead of faking support.
