/**
 * Where a person adds the connector, and how the Account screen words what an app has done.
 * Settings pages read 18 Nov from the primary pages. Claude: Customize > Connectors, where a
 * Free, Pro or Max person adds their own. ChatGPT: then plus, Add custom MCP server.
 */
export const CLAUDE_SETTINGS = "https://claude.ai/customize/connectors";
export const CHATGPT_SETTINGS = "https://chatgpt.com/plugins";

/** The address an app is given: this copy's own origin and `/mcp`. */
export const connectorAddress = (origin: string): string => `${origin.replace(/\/+$/, "")}/mcp`;

/** An app that is let in, as the Worker lists it. No token of any kind. */
export interface GrantItem {
  readonly id: string;
  readonly clientName: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

/** Only the four fields a screen shows, the most recently used first. */
export function shapeGrants(grants: readonly GrantItem[]): GrantItem[] {
  const at = (g: GrantItem): string => g.lastUsedAt ?? g.createdAt;
  return grants
    .map((g) => ({ id: g.id, clientName: g.clientName, createdAt: g.createdAt, lastUsedAt: g.lastUsedAt }))
    .sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0));
}

/** When an app last used its access, in the fewest words that stay true. */
export function lastUsed(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "not used yet";
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days <= 1 ? "yesterday" : `${days} days ago`;
}

/** The event a live message from a connected app's write raises, for any screen that lists such writes. */
const CONNECTOR_EVENT = "vemi:connector-changed";

export const tellConnectorChanged = (target: EventTarget = window): void => { target.dispatchEvent(new Event(CONNECTOR_EVENT)); };

/** Calls `run` on each such event; the returned function stops it. */
export function onConnectorChanged(run: () => void, target: EventTarget = window): () => void {
  target.addEventListener(CONNECTOR_EVENT, run);
  return () => target.removeEventListener(CONNECTOR_EVENT, run);
}
