# Security

## How to report

Use GitHub's private vulnerability report on this repository: open the Security tab and choose
"Report a vulnerability". Only the maintainers see it. Please do not open a public issue for a
security problem.

Say what you did, what you expected and what happened, and which version of VEMI. Do not include
a recovery code, a password or anyone's data.

## No bounty

There is no bounty. VEMI is free and made by one small team. We will read every report and say
thank you.

## What is in scope

- A copy's code: the API, the web app and the database rules.
- The signing and update path: how a copy checks and installs a release.
- The encryption: locked notes and full-account encryption.

Anything that lets one person see another person's data, or lets someone who is not the owner of a
copy change it, is in scope.

## Out of scope

- A copy that its owner has changed.
- Cloudflare's own service.
- Reports that need access to a person's unlocked device.

## Known limits

- Signing out on one device does not end a session cookie that was copied from it. A copied cookie
  stays valid until it expires, 30 days after it was made, unless you use "sign out everywhere".
  A server-side session list is planned for a later release.
