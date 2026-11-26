/**
 * The Worker. The only file that knows where the pieces come from.
 *
 * No server runs anywhere: Cloudflare starts this per request. Nothing needs starting,
 * restarting or keeping alive on any machine.
 */
import { RELEASE_FEED, RELEASE_PUBLIC_KEY, VERSION, type Change } from "@vemi/shared";
import type { App } from "./app.js";
import { assemble } from "./assemble.js";
import type { Live } from "./live.js";
import { accountIdentity } from "./accountIdentity.js";
import { copyOrigin, sessionKey } from "./sessionKey.js";
import { createSelfUpdate } from "./selfUpdate.js";
import { createSetup } from "./setup.js";
import { openStore, type StoreEnv } from "./store.js";
import { tick } from "./tick.js";

export { Live } from "./live.js";

interface Env extends StoreEnv {
  readonly LIVE: DurableObjectNamespace<Live>;
  readonly ORIGIN?: string;
  readonly OWNER: string;
  readonly TIME_ZONE: string;
  readonly OPERATOR_EMAIL?: string;
  readonly GOOGLE_CLIENT_ID?: string;
  readonly GOOGLE_CLIENT_SECRET?: string;
  readonly SESSION_SECRET?: string;
  readonly VAPID_PUBLIC?: string;
  readonly VAPID_PRIVATE?: string;
  readonly SETUP_CLAIM?: string;
  readonly SETUP_FROM?: string;
}

/**
 * One app per isolate, not one per request, so what it keeps between requests lasts: the
 * session key. `env` is the same object for every request an isolate serves.
 */
const apps = new WeakMap<Env, App>();

export default {
  fetch(request, env, ctx) {
    let app = apps.get(env);
    if (app === undefined) {
      app = build(env, copyOrigin(env.ORIGIN, request));
      apps.set(env, app);
    }
    return app(request, (work) => ctx.waitUntil(work));
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(tick(new Date(controller.scheduledTime), env));
  },
} satisfies ExportedHandler<Env>;

/** `origin` is `ORIGIN` when set, else the address the first request came to. */
function build(env: Env, origin: string): App {
  const store = openStore(env);
  const now = (): Date => new Date();
  const channel = (owner: string) => env.LIVE.get(env.LIVE.idFromName(owner));
  const identity = accountIdentity({
    setupClaim: Boolean(env.SETUP_CLAIM),
    store,
    now,
    origin,
    owner: env.OWNER,
    operatorEmail: env.OPERATOR_EMAIL ?? "",
    sessionSecret: () => sessionKey(store, env.SESSION_SECRET),
    google:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
        : null,
    fetch: (input, init) => fetch(input, init),
  });
  const publish = async (owner: string, change: Change): Promise<void> => {
    await channel(owner).publish(JSON.stringify(change));
  };
  return assemble({
    store,
    now,
    origin,
    timeZone: env.TIME_ZONE,
    extras: {
      copyOwner: env.OWNER,
      vapid: { publicKey: env.VAPID_PUBLIC, privateKey: env.VAPID_PRIVATE },
      ...(env.SETUP_CLAIM || env.SETUP_FROM
        ? { setup: createSetup({ store, secret: env.SETUP_CLAIM ?? "", from: env.SETUP_FROM ?? "", origin, move: { owner: env.OWNER, identity, publish } }) }
        : {}),
      ...(env.SETUP_CLAIM
        ? {
            update: createSelfUpdate({
              store, secret: env.SETUP_CLAIM, origin, feed: RELEASE_FEED, publicKey: RELEASE_PUBLIC_KEY, version: VERSION,
              fetch: (url, init) => fetch(url, init), now,
            }),
          }
        : {}),
    },
    identity,
    live: {
      publish,
      connect: (owner: string, upgrade: Request) => channel(owner).fetch(upgrade),
    },
  });
}
