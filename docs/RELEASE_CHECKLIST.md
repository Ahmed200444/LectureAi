# Public release checklist

Use this checklist before changing repository visibility to public.

## Source and history

- [x] Current `main` contains a conventional, inspectable source tree.
- [x] Incomplete packaged-source artifacts are not present in the current `main` tree.
- [x] Current source has automated CI checks.
- [x] Repository includes an open-source license and contributor documentation.
- [ ] Review historical commits for sensitive material before public release.

## Security and privacy

- [ ] Confirm no credentials, API keys, access tokens, private recordings, or student data are present in current source or reachable history.
- [ ] Confirm example/test data is synthetic, public-domain, or explicitly permitted.
- [ ] Confirm security reporting instructions are current.

## Project quality

- [x] README states implemented features accurately.
- [x] README avoids unverified transcription-accuracy claims.
- [x] Contribution guide is available.
- [x] Roadmap is available.
- [x] Code of conduct is available.
- [x] Issue and pull-request templates are available.
- [x] CI passes on `main`.

## After publishing

- [ ] Add a concise repository description and relevant topics in GitHub repository settings.
- [ ] Confirm Issues are enabled.
- [ ] Confirm the default branch is `main`.
- [ ] Pin or link the roadmap and contribution guide from the README if project priorities change.
- [ ] Only describe real contributors, usage, stars, forks, downloads, or adoption; never manufacture project metrics.
