import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const robots = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');
const sitemap = readFileSync(new URL('../public/sitemap.xml', import.meta.url), 'utf8');
const privacy = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');
const howItWorks = readFileSync(new URL('../public/how-it-works.html', import.meta.url), 'utf8');
const vercel = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
const gitignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
const seoGod = JSON.parse(readFileSync(new URL('../seo-god.json', import.meta.url), 'utf8')) as {
  version: number;
  site_url: string;
  openseo: { status: string };
  phases: Record<string, string>;
  power_ups: Record<string, boolean>;
};

assert.equal(seoGod.version, 1);
assert.equal(seoGod.site_url, 'https://lecture-ai-blush.vercel.app');
assert.equal(seoGod.phases.setup, 'in_progress');
assert.deepEqual(Object.keys(seoGod.phases).sort(), ['ai_visibility', 'audit', 'measure', 'schedule', 'setup']);
for (const state of Object.values(seoGod.phases)) assert.match(state, /^(pending|in_progress|done)$/);
assert.equal(seoGod.power_ups.dataforseo, false);
assert.equal(seoGod.power_ups.llm_keys, false);
assert.match(gitignore, /\/\.seo-god\//);

assert.match(index, /rel="canonical" href="https:\/\/lecture-ai-blush\.vercel\.app\/"/);
assert.match(index, /application\/ld\+json/);
assert.match(index, /SoftwareApplication/);
assert.doesNotMatch(index, /AggregateRating|reviewRating|ratingValue|userCount|award|"@type"\s*:\s*"Review"/i);

assert.match(robots, /User-agent: \*/);
assert.match(robots, /Sitemap: https:\/\/lecture-ai-blush\.vercel\.app\/sitemap\.xml/);
assert.match(sitemap, /https:\/\/lecture-ai-blush\.vercel\.app\//);
assert.match(sitemap, /\/privacy/);
assert.match(sitemap, /\/how-it-works/);
assert.doesNotMatch(sitemap, /lecture\/|transcript|notes|quiz|recording/i);

assert.match(privacy, /stays local by default/i);
assert.match(privacy, /model files/i);
assert.match(privacy, /does not require a paid speech API/i);
assert.doesNotMatch(privacy, /100% local|perfect accuracy|guaranteed/i);
assert.match(howItWorks, /multilingual Whisper/i);
assert.match(howItWorks, /Accuracy varies/i);
assert.match(howItWorks, /does not impose recording-minute or transcription-minute quotas/i);
assert.doesNotMatch(howItWorks, /AggregateRating|reviewRating|ratingValue|"@type"\s*:\s*"Review"|millions of users|100% accurate/i);

assert.match(vercel, /"source": "\/privacy"/);
assert.match(vercel, /"source": "\/how-it-works"/);
assert.match(vercel, /X-Content-Type-Options/);
assert.match(vercel, /Referrer-Policy/);
assert.match(vercel, /Permissions-Policy/);
assert.match(vercel, /no-cache, no-store, must-revalidate/);

console.log('✓ public SEO, privacy boundaries, truthful schema, SEO God state, and Vercel routing safeguards are present');