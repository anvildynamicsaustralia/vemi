/**
 * The one place the app is put together from its three pieces: a store, an identity and a
 * live channel. The Worker (`index.ts`) and the copy that runs inside the page
 * both come through here, so they differ only in which store, which
 * identity and which live channel they hand over, and everything else is the same code.
 */
import { createApp, type App, type AppDeps } from "./app.js";

/** What differs between one copy and another, and what each shares. */
export interface Parts {
  readonly store: AppDeps["store"];
  readonly identity: AppDeps["identity"];
  readonly live: AppDeps["live"];
  /** The page's own origin. */
  readonly origin: string;
  /** The zone "today" turns over in when the page names none. */
  readonly timeZone: string;
  readonly now?: () => Date;
  /** Only the Worker has these: the copy's owner, push keys, the setup hand-over and self-update. */
  readonly extras?: Pick<AppDeps, "copyOwner" | "vapid" | "setup" | "update" | "push" | "fetch" | "sameOrigin">;
}

export function assemble(parts: Parts): App {
  const { extras, now, ...own } = parts;
  return createApp({ ...extras, ...own, now: now ?? (() => new Date()) });
}
