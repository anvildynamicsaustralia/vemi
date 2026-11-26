import { useEffect, useState } from "react";
import { connectorAnswer, connectorClient } from "../api.js";
import { consentBody, readConnectRequest, returnSite, verifiedMark, type ConnectRequest } from "../connectRequest.js";
import { ClaudeMark } from "./ClaudeMark.js";
import { Gate } from "./Gate.js";
import { InfoTip } from "./InfoTip.js";
import "./connect.css";

type Stage =
  | { readonly kind: "asking" }
  | { readonly kind: "unknown" }
  | { readonly kind: "ready"; readonly name: string }
  | { readonly kind: "sent" };

const UNKNOWN = "This request is not one VEMI knows.";
const NOT_SENT = "That did not go through. Try again.";

/** The first letter of an app's name, for the tile of an app VEMI has no mark for. */
const letterOf = (name: string): string => Array.from(name.trim())[0]?.toUpperCase() ?? "?";

/**
 * The app's name and the site it returns to, so a name borrowed from another app is still seen
 * to come from elsewhere. The Claude mark and "Verified" show only when the site is exactly
 * claude.ai (`verifiedMark`); any other site gets a letter and "Not verified".
 */
export function ConnectAsk({ name, redirectUri }: { readonly name: string; readonly redirectUri: string }) {
  const site = returnSite(redirectUri);
  const verified = verifiedMark(site) === "claude";
  return (
    <>
      <div className="connect-ask">
        <div className={`connect-tile${verified ? " claude" : ""}`} aria-hidden={verified ? undefined : "true"}>
          {verified ? <ClaudeMark /> : letterOf(name)}
        </div>
        <div className="connect-words">
          <p className="connect-line"><span className="connect-name">{name}</span> wants to read and change your VEMI. It can't delete anything.</p>
          {site !== null && (
            <p className="connect-site">
              {verified
                ? <span className="connect-verified"><span aria-hidden="true">&#10003; </span>Verified</span>
                : <span className="connect-unverified">Not verified</span>}
              {" "}Returns to <span className="connect-name">{site}</span>
              <InfoTip label="About the return site">This is the site you will be sent back to. If it does not look right, choose Deny.</InfoTip>
            </p>
          )}
        </div>
      </div>
      <ul className="connect-can">
        <li>Read what is in your VEMI</li>
        <li>Add and change things in it</li>
        <li>Cannot delete anything</li>
      </ul>
    </>
  );
}

/**
 * The page an app sends a signed-in person to. It names the app from what the Worker
 * registered, never from what the address says, and holds only Deny and Allow.
 */
export function Connect() {
  const [request] = useState<ConnectRequest | null>(() => readConnectRequest(window.location.search));
  const [stage, setStage] = useState<Stage>(request === null ? { kind: "unknown" } : { kind: "asking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (request === null) return;
    let live = true;
    connectorClient(request.clientId, request.redirectUri).then(
      (name) => { if (live) setStage(name === null || returnSite(request.redirectUri) === null ? { kind: "unknown" } : { kind: "ready", name }); },
      () => { if (live) { setStage({ kind: "unknown" }); } },
    );
    return () => { live = false; };
  }, [request]);

  const answer = async (decision: "allow" | "deny"): Promise<void> => {
    if (request === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const to = await connectorAnswer(consentBody(request, decision));
      setStage({ kind: "sent" });
      window.location.assign(to);
    } catch {
      setError(NOT_SENT);
      setBusy(false);
    }
  };

  if (stage.kind === "ready") {
    const redirectUri = request?.redirectUri ?? "";
    const verified = verifiedMark(returnSite(redirectUri)) === "claude";
    const allow = (
      <button type="button" className={verified ? "primary-button" : "quiet-button gate-outline"} disabled={busy} onClick={() => void answer("allow")}>
        {verified ? "Allow" : "Allow anyway"}
      </button>
    );
    const deny = <button type="button" className="quiet-button gate-outline" disabled={busy} onClick={() => void answer("deny")}>Deny</button>;
    return (
      <Gate side={verified ? "consent" : "unverified"} title={`Connect ${stage.name}?`}>
        <ConnectAsk name={stage.name} redirectUri={redirectUri} />
        <div className="connect-actions">{verified ? <>{allow}{deny}</> : <>{deny}{allow}</>}</div>
        {error !== null && <div className="error" role="alert">{error}</div>}
      </Gate>
    );
  }

  return (
    <Gate side="consent" title="Connect an app">
      {stage.kind === "unknown" && <p className="gate-notice" role="alert">{UNKNOWN}</p>}
    </Gate>
  );
}
