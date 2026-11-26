/**
 * The request an app made, as the consent page receives it in the address. `/oauth/authorize`
 * checks it and hands the person on to `/connect` with these parts; the page sends them back
 * whole with the person's answer.
 */
export interface ConnectRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string | null;
  readonly resource: string | null;
}

/** What the page sends with the person's answer: the request whole, and Allow or Deny. */
export function consentBody(request: ConnectRequest, decision: "allow" | "deny"): Readonly<Record<string, string>> {
  const body: Record<string, string> = {
    decision, clientId: request.clientId, redirectUri: request.redirectUri, codeChallenge: request.codeChallenge,
  };
  if (request.state !== null) body.state = request.state;
  if (request.resource !== null) body.resource = request.resource;
  return body;
}

/** The request in `search`, or null when it is not one: the page then says so in one line. */
export function readConnectRequest(search: string): ConnectRequest | null {
  const q = new URLSearchParams(search);
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const codeChallenge = q.get("code_challenge") ?? "";
  if (clientId === "" || redirectUri === "" || codeChallenge === "") return null;
  return { clientId, redirectUri, codeChallenge, state: q.get("state"), resource: q.get("resource") };
}

/**
 * Whose mark the consent page may show for a return site: "claude" only when the site is
 * exactly `claude.ai` (what `returnSite` gives for https://claude.ai/...), otherwise null.
 * An exact match and nothing else: no subdomain, no suffix, no port, no wildcard. The name an
 * app calls itself never counts; only where it sends the person back to.
 */
export function verifiedMark(site: string | null): "claude" | null {
  return site === "claude.ai" ? "claude" : null;
}

/**
 * Where an allowed app sends the person back to, as the site alone (with a port when it has one).
 * The consent page shows it under the app's name, so an app that calls itself something it is
 * not is still seen to come from somewhere else. A return address that is not a web address, or
 * is not https, has no site to show: null, and the page refuses to offer Allow.
 */
export function returnSite(redirectUri: string): string | null {
  let u: URL;
  try { u = new URL(redirectUri); } catch { return null; }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) return null;
  return u.hostname === "" ? null : u.hostname + (u.port === "" ? "" : ":" + u.port);
}
