/**
 * The unchanged app, running where the database is.
 *
 * `openLocalApp` opens the local database, applies the migrations, and builds the same
 * `createApp` the Worker runs, through the same `assemble`, with a store over the wasm engine,
 * the one-owner identity, and a live channel that posts each change for the other open pages.
 * Nothing in the routes is copied or changed. `handle` is `App` without the work-after-reply
 * argument: what a route leaves running behind its answer is tracked, and `idle()` waits for it.
 *
 * The page's own writes arrive without an `Origin` (a script's request has none to read), and
 * nothing but the page can reach `handle`, so every request is the page's own. A socket is
 * never asked for here: the page hears changes from `channel.ts`, not from `/api/live`.
 */
import { assemble } from "../api/assemble.js";
import { openLocalStore, type Store } from "../api/store.js";
import type { Change } from "@vemi/shared";
import { localIdentity } from "./identity.js";
import { localTick } from "./localTick.js";
import { TICK_PATH } from "./tickPath.js";
import type { Reminder } from "../web/reminderEvent.js";
import { applyMigrations, bundledMigrations } from "./migrate.js";
import { createSqlBinding, type SqlEngine } from "./sqlD1.js";


export interface LocalAppOptions {
  readonly engine: SqlEngine;
  /** The page's own origin. */
  readonly origin: string;
  /** The browser's time zone. */
  readonly timeZone: string;
  readonly now?: () => Date;
  /** Where a change goes for the other open pages: `channel.ts`'s `post`. */
  readonly post: (change: Change) => void;
}

export interface LocalApp {
  handle(request: Request): Promise<Response>;
  /** Resolves once all work a response left running behind it has finished. */
  idle(): Promise<void>;
  readonly store: Store;
}

export async function openLocalApp(options: LocalAppOptions): Promise<LocalApp> {
  const { engine, origin, timeZone } = options;
  const now = options.now ?? (() => new Date());
  await applyMigrations(engine, await bundledMigrations());
  const store = openLocalStore(createSqlBinding(engine), now);
  const identity = localIdentity({ store, timeZone });
  // A fresh database shows the front page; a copy in the page has no front page, and nobody to turn it on.
  await store.setFrontLanding(false);
  const app = assemble({
    store,
    now,
    origin,
    timeZone,
    identity,
    live: {
      publish: async (_owner, change) => options.post(change),
      connect: async () => new Response(JSON.stringify({ error: "the page hears changes from its own channel" }), {
        status: 404, headers: { "content-type": "application/json; charset=utf-8" },
      }),
    },
    extras: { sameOrigin: () => true },
  });

  const behind = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => {
    // A failed afterthought must not fail the answer it followed, nor go unhandled.
    const settled = work.then(() => undefined, () => undefined).finally(() => behind.delete(settled));
    behind.add(settled);
  };


  /**
   * The minute's check, asked by the page: what is due now, once each. It is not a route of the
   * app, which has no reminders to show a page; it answers here, beside the app, from the same
   * store, and shows nothing itself. `hiddenSince` is when the page went out of view, if it did.
   */
  const tick = async (request: Request): Promise<Response> => {
    const body = (await request.json().catch(() => ({}))) as { hiddenSince?: unknown };
    const hidden = typeof body.hiddenSince === "string" ? new Date(body.hiddenSince) : null;
    const who = await identity.resolve(request);
    if ("refused" in who) return new Response(JSON.stringify({ error: who.refused }), { status: 401, headers: { "content-type": "application/json; charset=utf-8" } });
    const { owner } = who;
    const due: Reminder[] = [];
    await localTick({
      store, owner, now: now(), timeZone, show: (reminder) => due.push(reminder),
      hiddenSince: hidden === null || Number.isNaN(hidden.getTime()) ? null : hidden,
    });
    return new Response(JSON.stringify({ due }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  };

  return {
    store,
    handle: (request) => {
      if (request.method === "POST" && new URL(request.url).pathname === TICK_PATH) return tick(request);
      return app(request, track);
    },
    idle: async () => {
      while (behind.size > 0) await Promise.all([...behind]);
    },
  };
}
