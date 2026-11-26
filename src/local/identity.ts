/**
 * The identity of a copy that lives in the page: one person, one account, no way in to prove.
 *
 * Whoever can reach the page owns what is in it, so every request resolves to the one owner
 * `local`. The account row is made on first open through the same `createAccount` the Worker
 * uses, in the device's own time zone. There is no sign-in, sign-up, reset or invite here and
 * no password, Google or 2-step to set: every `/auth/` path but `GET /auth/me` answers 404.
 */
import type { Identity } from "../api/identity.js";
import type { Store } from "../api/store.js";

export const LOCAL_OWNER = "local";

/** The address the account row carries. The column needs one; nothing is ever sent to it. */
export const LOCAL_EMAIL = "local@local.invalid";

/**
 * The table requires a password or a Google identity on every account. This is neither: it is
 * not a hash of anything, so no password can ever match it, and `/auth/me` says there is none.
 */
const NO_PASSWORD = "none";

export interface LocalIdentityOptions {
  readonly store: Store;
  /** The device's own zone, kept as the account's when the account is made. */
  readonly timeZone: string;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export function localIdentity(options: LocalIdentityOptions): Identity {
  const { store, timeZone } = options;
  // Made once per open: the first request waits for it, the rest find it done.
  let made: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    made ??= (async () => {
      // An open after the first finds the account, and does not ask the database to refuse a second.
      if (await store.account(LOCAL_OWNER) !== null) return;
      const fresh = await store.createAccount({ id: LOCAL_OWNER, email: LOCAL_EMAIL, passwordHash: NO_PASSWORD, googleSub: null, confirmed: true });
      if (fresh) await store.setAppearance(LOCAL_OWNER, { timeZone });
    })().catch((error: unknown) => {
      made = null;
      throw error;
    });
    return made;
  };

  return {
    describe: "this device: one account, nothing to sign in with",
    async resolve() {
      await ensure();
      return { owner: LOCAL_OWNER };
    },
    async resolveRead(_request, read) {
      await ensure();
      return { owner: LOCAL_OWNER, read: await read(LOCAL_OWNER, store) };
    },
    async claimOwner() {
      return { refused: { status: 409, error: "This device already has its one account." } };
    },
    async handle(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/auth/")) return null;
      if (request.method !== "GET" || url.pathname !== "/auth/me") return json(404, { error: "not found" });
      await ensure();
      const account = await store.account(LOCAL_OWNER);
      return json(200, {
        signedIn: true,
        id: LOCAL_OWNER,
        // The name the key ways bind to (locked notes, App lock, full encryption); never shown or sent.
        email: LOCAL_EMAIL,
        operator: true,
        password: false,
        google: false,
        firstName: account?.firstName ?? null,
        twoStep: false,
        deleteOn: null,
        googleReady: false,
      });
    },
  };
}
