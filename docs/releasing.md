# Releasing

How a release of VEMI is built and signed, for whoever publishes releases. A copy installs only what is signed with the key it trusts. This page holds no key, token or ID, and nothing here should ever be added to it.

## What is signed

A release is a folder, `dist/release/<version>/`, with:

- `manifest.json`, which lists the version, the date and time it was issued, its notes, the Worker file, every client file and every database change, each with its size and hash.
- the Worker in `worker/`, the client files in `client/` and the database changes in `migrations/`.
- `manifest.sig`, the signature.

`dist/release/latest.json` sits beside it and names the newest version and the hash of its manifest. It is not signed itself. A copy holds the manifest it fetches to that hash, then checks the signature, so a changed latest.json cannot install anything.

The signature is Ed25519 over the exact bytes of `manifest.json`, written as base64url. Because the manifest carries every file's hash, signing it covers the whole release.

The manifest carries `issuedAt`, the moment the bundle was built, as a UTC time like `2026-11-25T03:04:05.000Z`. `pnpm run release` writes it, so it is signed with everything else. A copy keeps the newest `issuedAt` it has accepted and refuses a release dated before it, so an old feed played back cannot hide a newer release. It also refuses a date more than 24 hours ahead of its own clock, so one wrong date cannot lock out every later release. A copy accepts the same date again, because it reads the same release every day. Build a release on the day you publish it, and if you rebuild, publish the rebuild: an older bundle published after a newer one is refused.

## Where the public key is

The public key is built into every copy, as `RELEASE_PUBLIC_KEY` in `src/shared/releaseKey.ts`: 32 raw bytes as base64url. The same file holds `RELEASE_FEED`, the address releases are read from, ending in a slash, with `latest.json` directly under it. Both are empty until a first release pastes them in, and a copy built with them empty installs nothing.

## The steps

Needs Node 24. The private key is made once and kept offline, outside this repository, on a device that is not online while it is used.

1. Make the pair, once. Give a path outside the repository:

   ```
   node scripts/make-release-key.mjs <path to the private key>
   ```

   It writes the private key to that path and prints only the public key. It refuses a path inside the repository and a path that already exists. Paste the printed public key into `RELEASE_PUBLIC_KEY`, and the feed address into `RELEASE_FEED`. Then back the private key up somewhere offline. Do not commit, paste or send it.

2. Add the version's notes to `RELEASE_NOTES.md` under a heading `## <version>`.

3. Build the bundle:

   ```
   pnpm run release
   ```

   It builds the app and writes `dist/release/`. It touches no network.

4. Sign it, with the private key brought to the signing device:

   ```
   node scripts/sign-release.mjs --key <path to the private key> dist/release/<version>
   ```

   It checks the folder against its manifest first, reads the key from that path alone, and writes `manifest.sig` beside `manifest.json`. It prints no key. It refuses a key path inside the repository.

5. Publish the folder and `latest.json` to the feed address. The front door serves them under `/release/`. Take the private key offline again.

## What a copy does with a bad signature

It refuses the release. The offer is not shown, nothing is downloaded or installed, and the copy keeps running the version it has. The same happens for a missing signature, a manifest that does not match the hash in `latest.json`, a body that is too large, a network error, a release that is not newer than the one running, a release with no issue date, a release dated before one the copy already accepted, and a release dated more than 24 hours ahead. The copy checks again the next day.

## If the key is lost

Copies trust only the public key built into them. Without the private key, nothing new can be signed that they accept, so copies already running stay on their version and keep working. A new key helps only copies built after it: a new public key goes into `RELEASE_PUBLIC_KEY`, and each existing copy has to be remade or redeployed with it, by the setup helper again or by the Deploy button path in [Updating](updating.md). The same is true if the key is ever exposed: make a new one, and treat the old public key as retired.
