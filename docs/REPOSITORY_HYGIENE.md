# Repository hygiene

To keep LectureAI safe for public collaboration:

- never commit `.env` files, credentials, access tokens, or private keys
- never commit real lecture recordings or student data
- never commit local tar/zip/base64 staging archives
- keep generated build output and dependency directories untracked
- use synthetic, public-domain, or explicitly permitted fixtures in tests and issues
- keep roadmap work clearly separated from implemented features

CI rejects common tracked media and archive formats in the current source tree, and `.gitignore` blocks them during normal development.
