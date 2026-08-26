# Open-Source Release Checklist

Use this checklist before changing the repository from private to public.

- [x] Add an explicit open-source license.
- [x] Add a contributor guide.
- [x] Add a public roadmap.
- [x] Add issue and pull request templates.
- [x] Add security and conduct guidance.
- [ ] Move the normal application source tree directly into the repository.
- [ ] Run typecheck, lint, unit tests, and the production build against the normal source tree.
- [ ] Review the full Git history and packaged source for API keys, tokens, passwords, private URLs, private recordings, student information, and other secrets.
- [ ] Confirm no `.env` or local credential files are tracked.
- [ ] Confirm deployment configuration contains no embedded credentials.
- [ ] Enable GitHub security features appropriate for a public repository.
- [ ] Change repository visibility to **Public** in GitHub Settings.
- [ ] Re-check the public repository from a signed-out browser session.

Do not mark the secret-review items complete based only on a text search of the current root files: the repository currently contains packaged source archives that also need to be inspected before public release.
