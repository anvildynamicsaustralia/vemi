/**
 * The service worker. The phone runs the same app with everything working, including with
 * no signal: the shell is kept, the last answer to each read is kept, and both are handed
 * over when the Worker cannot be reached.
 *
 * It never invents freshness. A kept answer carries `x-vemi-received-at`, the moment it
 * arrived, and the client says how old what it is drawing is.
 *
 * Plain JavaScript, emitted by the build rather than bundled: a service worker with a
 * content hash in its name can never be updated in place. The build writes its own stamp
 * into `BUILD` and its file list into `FILES` (see vite.config.ts), so every deploy is a new
 * worker and a new shell, and an old shell's files do not pile up on the phone.
 */

const BUILD = "__VEMI_BUILD__";
/** The build's own files. Kept at install, so the app opens offline straight after a deploy. */
const FILES = "__VEMI_FILES__";
const SHELL = `vemi-shell-${BUILD}`;
/** Not per build: a deploy must not throw away what a phone kept to use offline. */
const DATA = "vemi-data-v1";
const RECEIVED_AT = "x-vemi-received-at";
/** A weak signal hangs rather than fails. Past this, what was kept is better than waiting. `src/patience.ts` is the twin: it cannot be imported here, so change both. */
const PATIENCE_MS = 4000;
/**
 * The page is asked for at `/`. Cloudflare answers `/index.html` with a redirect to `/`, and a
 * browser refuses a redirected answer to a page load: asking for `/index.html` here took the
 * whole app down on 2026-09-15.
 */
const PAGE = "/";

/** When this device last signed out. A read that left before then is not kept. */
let forgotAt = 0;

/**
 * Built files. Most carry a hash in their name; icons do not, but the shell is thrown away
 * with every build, so a kept icon is never older than the build that drew it. The app icons,
 * SVG and PNG, are built with every build.
 */
const isBuilt = (url) =>
  url.pathname.startsWith("/assets/")
  || url.pathname.startsWith("/icons/")
  || url.pathname === "/manifest.webmanifest"
  || url.pathname.endsWith(".svg")
  || url.pathname.endsWith(".png");

/** Reads worth keeping. The live socket is a connection, and search changes with every key. */
const isKeptRead = (url) =>
  url.pathname.startsWith("/api/")
  && url.pathname !== "/api/live"
  && url.pathname !== "/api/search"
  && !url.pathname.startsWith("/api/connector/");

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    // The page and every built file, before this worker takes over and the old shell goes,
    // which would otherwise leave nothing to open offline until a full load online. A file
    // that will not come is not worth refusing the update over: it is fetched on first use.
    const cache = await caches.open(SHELL);
    await Promise.all([PAGE, ...(Array.isArray(FILES) ? FILES : [])].map(async (path) => {
      try {
        const response = await unredirected(await fetch(path, { cache: "no-cache" }));
        if (response.ok) await cache.put(path, response);
      } catch {
        // Fetched on first use instead.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SHELL && n !== DATA).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/auth/")) return;
  // An app's sign-in lands on the Worker's own answer, not on the page.
  if (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/") || url.pathname === "/mcp") return;
  // The setup page stands apart from the app: it is its own page, never the app's shell.
  if (url.pathname === "/get" || url.pathname.startsWith("/get/")) return;
  // So is the copy that keeps its data in the browser, with a worker of its own at /try/.
  if (url.pathname === "/try" || url.pathname.startsWith("/try/")) return;

  if (isKeptRead(url)) {
    event.respondWith(networkThenKept(request, DATA, true));
    return;
  }
  if (isBuilt(url)) {
    event.respondWith(keptThenNetwork(request));
    return;
  }
  // The page itself, at any path the client routes: the newest build when it can be had, so
  // a deploy shows on the next load rather than the one after.
  if (request.mode === "navigate") {
    event.respondWith(networkThenKept(new Request(PAGE), SHELL, false));
  }
});

function withPatience(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("slow")), PATIENCE_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** A copy that does not remember being redirected, so it can answer a page load. */
async function unredirected(response) {
  if (!response.redirected) return response;
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/**
 * Keeps a copy, or does not. A phone that is out of space, or a browser whose storage
 * refuses the write, must still be handed the answer the Worker gave: losing the copy
 * only costs the offline view, while losing the answer drew "no connection" on a page
 * that was online.
 */
async function keep(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch {
    // Not kept; asked for again next time.
  }
}

async function networkThenKept(request, cacheName, stamp) {
  const cache = await caches.open(cacheName);
  const startedAt = Date.now();
  const network = fetch(request).then(async (fetched) => {
    const response = await unredirected(fetched);
    // A read that left before a sign-out belongs to the session that ended.
    if (response.ok && !(stamp && forgotAt >= startedAt)) {
      const headers = new Headers(response.headers);
      if (stamp) headers.set(RECEIVED_AT, new Date().toISOString());
      const body = await response.clone().arrayBuffer();
      await keep(cache, request, new Response(body, { status: response.status, headers }));
    }
    return response;
  });
  try {
    return await withPatience(network);
  } catch {
    const kept = await cache.match(request);
    if (kept !== undefined) return kept;
    try {
      // Nothing kept: waiting longer is the only answer there is.
      return await network;
    } catch {
      if (!stamp) return Response.error();
      return new Response(JSON.stringify({ error: "no connection, and nothing kept on this device yet" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
  }
}

async function keptThenNetwork(request) {
  const cache = await caches.open(SHELL);
  const kept = await cache.match(request);
  if (kept !== undefined) return kept;
  const response = await fetch(request);
  // A path with no file is answered with the app's page. Kept, it would stand in for the
  // missing file for the life of the build.
  const page = (response.headers.get("content-type") ?? "").includes("text/html");
  if (response.ok && !page) await keep(cache, request, response.clone());
  return response;
}

/** Signing out forgets every kept answer: they are one person's plans. */
self.addEventListener("message", (event) => {
  if (event.data !== "forget-data") return;
  forgotAt = Date.now();
  event.waitUntil(caches.delete(DATA));
});

/*
 * Push. `src/pushMessage.ts` is the twin of the small functions below (the worker cannot
 * import): change both. The server-side twin of what is sealed into a push is `reminders.ts`. A reminder for a task, with a VEMI tab on screen, is sent to
 * that tab for the in-app banner and shows no system notification. Everything else, and a
 * reminder with no tab on screen, is a system notification.
 */
const PUSH_MESSAGE = "vemi-push";
const OPEN_MESSAGE = "vemi-open";

const openUrlFor = (payload) =>
  payload.kind === "task" && typeof payload.taskId === "string"
    ? `/?task=${encodeURIComponent(payload.taskId)}`
    : "/today";

const inAppFor = (payload) =>
  payload.kind === "task" && typeof payload.taskId === "string" && typeof payload.at === "string"
    ? { taskId: payload.taskId, at: payload.at }
    : null;

function notificationFor(payload, maxActions) {
  const all = inAppFor(payload) === null ? [] : [
    { action: "done", title: "Done" },
    { action: "snooze", title: "In 1 hour" },
  ];
  const data = { kind: payload.kind, url: openUrlFor(payload) };
  if (typeof payload.taskId === "string") data.taskId = payload.taskId;
  if (typeof payload.at === "string") data.at = payload.at;
  return {
    title: payload.title,
    options: { body: payload.body, tag: payload.tag, data, actions: all.slice(0, Math.max(0, Math.floor(maxActions))) },
  };
}

/*
 * A reminder from an account with full encryption carries the task's own title envelope in
 * `sealedTitle`. Only a device that holds the key can open it. The key lives in IndexedDB
 * `vemi-keys` store `keys` (src/deviceKey.ts), one entry per account, each with its `keyRef`.
 * `shownFor` is the twin of `shownPayload` in src/pushMessage.ts. Any failure leaves the
 * message as the server sent it: the generic title, and for a count message the count only.
 */
function keptKeys() {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open("vemi-keys");
      request.onerror = () => resolve([]);
      request.onblocked = () => resolve([]);
      request.onupgradeneeded = () => {
        // Nothing is kept here. Leave no empty store behind.
        request.transaction.abort();
        resolve([]);
      };
      request.onsuccess = () => {
        const db = request.result;
        try {
          const all = db.transaction("keys", "readonly").objectStore("keys").getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result);
          };
          all.onerror = () => {
            db.close();
            resolve([]);
          };
        } catch {
          db.close();
          resolve([]);
        }
      };
    } catch {
      resolve([]);
    }
  });
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The title inside an envelope, or null when this device cannot open it. Never throws. */
async function openTitle(envelope, taskId) {
  try {
    const parts = envelope.split(".");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    const keyRef = parts[1];
    const entry = (await keptKeys()).find((k) => k && k.keyRef === keyRef && k.fieldKey);
    if (entry === undefined) return null;
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(parts[2]), additionalData: new TextEncoder().encode(`vemi:v1:${keyRef}:${taskId}:title`) },
      entry.fieldKey,
      fromBase64Url(parts[3]),
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

const shownFor = (payload, title) => {
  const rest = { ...payload };
  delete rest.sealedTitle;
  if (title === null) return rest;
  return payload.kind === "task" ? { ...rest, title } : { ...rest, body: title };
};

async function shownPayload(payload) {
  if (typeof payload.sealedTitle !== "string" || typeof payload.taskId !== "string") return shownFor(payload, null);
  return shownFor(payload, await openTitle(payload.sealedTitle, payload.taskId));
}

function actBody(data, action) {
  if (action !== "done" && action !== "snooze") return null;
  if (typeof data.taskId !== "string" || typeof data.at !== "string") return null;
  return { taskId: data.taskId, action, at: data.at };
}

const windows = () => self.clients.matchAll({ type: "window", includeUncontrolled: true });

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload;
    try {
      payload = event.data.json();
    } catch {
      // A push must show something. A message that cannot be read says only who sent it.
      payload = { kind: "test", title: "VEMI", body: "", tag: "vemi" };
    }
    if (inAppFor(payload) !== null) {
      const visible = (await windows()).filter((c) => c.visibilityState === "visible");
      if (visible.length > 0) {
        for (const client of visible) client.postMessage({ type: PUSH_MESSAGE, payload });
        return;
      }
    }
    const max = typeof Notification === "function" && typeof Notification.maxActions === "number" ? Notification.maxActions : 0;
    const plan = notificationFor(await shownPayload(payload), max);
    await self.registration.showNotification(plan.title, plan.options);
  })());
});

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data ?? {};
  event.notification.close();
  event.waitUntil((async () => {
    const body = event.action === "" ? null : actBody(data, event.action);
    if (body !== null) {
      try {
        const response = await fetch("/api/push/act", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        // Done, or snoozed: nothing to open. A refusal opens the task so it can be seen to.
        if (response.ok) return;
      } catch {
        // No signal: open the task instead.
      }
    }
    const url = typeof data.url === "string" ? data.url : "/today";
    const open = await windows();
    const client = open.find((c) => c.visibilityState === "visible") ?? open[0];
    if (client !== undefined) {
      await client.focus();
      client.postMessage({ type: OPEN_MESSAGE, url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
