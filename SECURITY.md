# Security Policy

## Supported code

Security fixes are focused on the current `main` branch unless an issue explicitly states otherwise.

## Reporting a vulnerability

Please do **not** publish exploitable security details, private recordings, credentials, access tokens, or personal student information in a public GitHub issue.

If GitHub private vulnerability reporting is enabled for the repository, use it. If it is not available, contact the maintainer through the GitHub profile and avoid including sensitive exploit details in a public thread.

A useful report should include, when possible:

- the affected feature or component
- the device, operating system, and browser involved
- steps needed to reproduce the problem
- the security or privacy impact
- whether user recordings, transcripts, local storage, or permissions are involved
- a suggested mitigation, if you have one

## Privacy-sensitive test data

LectureAI handles lecture audio and study data. Security reports and test cases must use synthetic, public-domain, or explicitly permitted data. Do not upload a real private class recording simply to demonstrate a bug.

## Scope

Issues that may be security-sensitive include unintended exposure of recordings or transcripts, unsafe handling of local data, permission bypasses, credential leakage, cross-site scripting, unsafe file handling, and dependency vulnerabilities that are actually reachable in LectureAI.
