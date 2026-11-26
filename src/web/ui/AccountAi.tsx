import { useCallback, useEffect, useState } from "react";
import { connectorChanges, connectorGrants, revokeConnectorGrant, undoConnectorChange, type ConnectorChangeItem } from "../api.js";
import { CHATGPT_SETTINGS, CLAUDE_SETTINGS, connectorAddress, lastUsed, shapeGrants, type GrantItem } from "../connectorLinks.js";
import { encryptionState, refreshEncryption } from "../sealedApi.js";
import { useApp } from "./appContext.js";
import "./accountAi.css";

/** The line an AI app gets from the Worker on an account with full encryption: the same words. */
export const ENCRYPTED_AI = "This VEMI is fully encrypted, so AI apps can't read it.";

const said = (e: unknown): string => (e instanceof Error ? e.message : "That did not work.");

/** Account > AI: the address to give an app, the apps let in, and what they did in the last 7 days. */
export function AccountAi() {
  const app = useApp();
  const [grants, setGrants] = useState<readonly GrantItem[]>([]);
  const [changes, setChanges] = useState<readonly ConnectorChangeItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const address = connectorAddress(window.location.origin);
  const [encrypted, setEncrypted] = useState(() => encryptionState() === "on" || encryptionState() === "turning_on");

  const load = useCallback(async () => {
    try {
      const [g, c] = await Promise.all([connectorGrants(), connectorChanges()]);
      setGrants(shapeGrants(g));
      setChanges(c);
      setProblem(null);
    } catch (e) {
      setProblem(said(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void refreshEncryption().then((now) => setEncrypted(now === "on" || now === "turning_on"));
  }, []);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setProblem("This browser would not copy it.");
    }
  };

  const revoke = async (g: GrantItem): Promise<void> => {
    setBusy(g.id);
    try {
      await revokeConnectorGrant(g.id);
      app.notify(`${g.clientName} turned off`);
      await load();
    } catch (e) {
      setProblem(said(e));
    } finally {
      setBusy(null);
    }
  };

  const undo = async (c: ConnectorChangeItem): Promise<void> => {
    setBusy(c.id);
    try {
      await undoConnectorChange(c.id);
      app.notify("Put back");
      await load();
    } catch (e) {
      setProblem(said(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="ai" data-testid="account-ai">
      <h3 className="ai-group">AI</h3>
      <div className="account-rows">
        {encrypted && <div className="account-row"><span className="account-row-title">{ENCRYPTED_AI}</span></div>}
        {!encrypted && (
          <div className="account-row ai-address">
            <span className="account-row-title">
              Connector address
              <code className="ai-code">{address}</code>
            </span>
            <button type="button" className="row-action" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
          </div>
        )}
        {!encrypted && (
          <div className="account-row">
            <span className="account-row-title">Connector settings</span>
            <span className="account-row-actions">
              <a className="row-action" href={CLAUDE_SETTINGS} target="_blank" rel="noreferrer">Claude</a>
              <a className="row-action" href={CHATGPT_SETTINGS} target="_blank" rel="noreferrer">ChatGPT</a>
            </span>
          </div>
        )}
        {grants.map((g) => (
          <div className="account-row" key={g.id}>
            <span className="account-row-title">
              {g.clientName}
              <span className="account-row-note">Last used {lastUsed(g.lastUsedAt)}</span>
            </span>
            <button type="button" className="row-action" disabled={busy === g.id} onClick={() => void revoke(g)}>Revoke</button>
          </div>
        ))}
        {changes.map((c) => (
          <div className="account-row" key={c.id}>
            <span className="account-row-title">
              {c.clientName}: {c.tool.replace(/_/g, " ")}
              <span className="account-row-note">{lastUsed(c.createdAt)}{c.undoneAt === null ? "" : ", put back"}</span>
            </span>
            {c.undoneAt === null && (
              <button type="button" className="row-action" disabled={busy === c.id} onClick={() => void undo(c)}>Undo</button>
            )}
          </div>
        ))}
        {problem !== null && (
          <div className="account-row"><span className="account-row-title failed" role="alert">{problem}</span></div>
        )}
      </div>
    </div>
  );
}
