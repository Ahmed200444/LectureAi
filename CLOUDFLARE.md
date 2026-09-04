# LectureAI on Cloudflare Pages

This repository is prepared for Cloudflare Pages as a second web host while the Expo app remains the iPhone/iPad runtime.

## What Cloudflare hosts

Cloudflare Pages hosts the LectureAI web/PWA, public information pages, SEO files, and the Expo setup/launch instructions. It does **not** turn the React Native Expo project into an installable iOS app.

The Expo app continues to run through Expo Go during the free testing phase. A future standalone iOS app still requires Apple's signed-app distribution path.

## Cloudflare Pages settings

Use the GitHub repository `Ahmed200444/LectureAi`.

- Production branch: `main` once the Expo PR is physically approved and merged.
- For preview/testing now: `expo-unified-lectureai`.
- Build command: `npm run build`
- Build output directory: `dist/client`
- Node: 22

`wrangler.toml` also declares `dist/client` as the Pages build output directory.

Cloudflare Pages should automatically copy `public/_headers` and `public/_redirects` into the final Vite output. These reproduce the important security headers and clean-route rewrites used by the Vercel deployment.

## First Cloudflare connection

In Cloudflare Dashboard open **Workers & Pages → Create application → Pages → Import an existing Git repository**, authorize GitHub if needed, choose `Ahmed200444/LectureAi`, then use the build settings above.

The resulting site will receive a `*.pages.dev` address. Keep the existing production canonical URL until a deliberate domain migration is made; do not change SEO canonicals merely because a preview mirror exists.

## Expo on iPhone and iPad

1. Install Expo Go from the App Store on each device.
2. Start the unified Expo project from `expo-recorder` with Expo tooling and scan the generated QR code on the device.
3. LectureAI then runs inside Expo Go using native Expo audio. Cloudflare is only the website/guide host; it is not the native app package host.
4. The current Expo configuration explicitly supports both iPhone and iPad.

## Export behavior

The Expo app can share/save the original audio through the Apple share sheet and export transcript, notes, study guide, and LectureAI JSON data. The original audio remains separate and unchanged.

## Production gate

Do not merge or call the Expo build production-proven until the physical iPhone **and** iPad acceptance checklist in the PR has passed. Cloudflare deployment success is not a substitute for physical microphone, long-recording, interruption, local-network, Windows transcription, or export testing.
