import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
const redirects = readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8');
const vite = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
const expoConfig = readFileSync(new URL('../expo-recorder/app.json', import.meta.url), 'utf8');
const cloudflareDoc = readFileSync(new URL('../CLOUDFLARE.md', import.meta.url), 'utf8');
const recorderPage = readFileSync(new URL('../public/recorder.html', import.meta.url), 'utf8');

assert.match(vite, /outDir:\s*['"]dist\/client['"]/);
assert.match(wrangler, /name\s*=\s*["']lecture-ai["']/);
assert.match(wrangler, /pages_build_output_dir\s*=\s*["']\.\/dist\/client["']/);
assert.match(wrangler, /compatibility_date\s*=\s*["']2026-09-03["']/);

assert.match(headers, /\/sw\.js/);
assert.match(headers, /Cache-Control:\s*no-cache, no-store, must-revalidate/);
assert.match(headers, /X-Content-Type-Options:\s*nosniff/);
assert.match(headers, /Referrer-Policy:\s*strict-origin-when-cross-origin/);
assert.match(headers, /X-Frame-Options:\s*DENY/);
assert.match(headers, /Permissions-Policy:\s*camera=\(\), geolocation=\(\), microphone=\(self\)/);

assert.match(redirects, /^\/privacy \/privacy\.html 200/m);
assert.match(redirects, /^\/how-it-works \/how-it-works\.html 200/m);
assert.match(redirects, /^\/recorder \/recorder\.html 200/m);
assert.match(redirects, /^\/\* \/index\.html 200/m);

assert.match(expoConfig, /"supportsTablet"\s*:\s*true/);
assert.match(expoConfig, /"iPhone"/);
assert.match(expoConfig, /"iPad"/);
assert.match(cloudflareDoc, /Cloudflare Pages hosts the LectureAI web\/PWA/);
assert.match(cloudflareDoc, /does \*\*not\*\* turn the React Native Expo project into an installable iOS app/);

// The public launcher page must not point users at the obsolete SDK 57 one-file Snack.
assert.doesNotMatch(recorderPage, /sdkVersion=57\.0\.0/);
assert.doesNotMatch(recorderPage, /sourceUrl=.*\/main\/expo-recorder\/App\.js/);

console.log('✓ Cloudflare Pages build, routing, security headers, iPhone/iPad targeting, and Expo-hosting separation safeguards are present');
