/**
 * Where a copy looks for releases and who it trusts to sign them. Plain constants, no code.
 *
 * Both are empty until the release step pastes them in. An empty RELEASE_PUBLIC_KEY fails every
 * verify, and an empty RELEASE_FEED makes the daily check do nothing, so a copy built before then
 * never installs anything.
 */

/** The Ed25519 public key releases are signed with, 32 raw bytes as base64url. */
export const RELEASE_PUBLIC_KEY = "_ZEbss2djgMWqrSIik7tjk7USvyBQl_D9r0nzsDi3xA";

/** The absolute base of the release files, ending in a slash; latest.json sits directly under it. */
export const RELEASE_FEED = "https://vemi.anvildynamics.com.au/release/";

/** The page that explains updating, for copies that cannot update themselves. */
export const UPDATE_DOCS = "https://github.com/anvildynamicsaustralia/vemi/blob/main/docs/updating.md";
