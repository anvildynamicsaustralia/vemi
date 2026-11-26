/**
 * The service worker for `/try/`, the copy that keeps its data in the browser. Scope `/try/`.
 *
 * It exists so the page opens with no signal: it keeps the page, the built code, the database
 * worker and the wasm, and hands them back. That is all it does. It has no `/api/` handling,
 * because the page answers its own requests; it has no push handler, because nothing is ever
 * pushed here; and it never touches the signed-in app's worker or its caches.
 *
 * Plain JavaScript, emitted by the build rather than bundled, for the reason `src/web/sw.js`
 * gives. The build writes its stamp into `BUILD` and its file list into `FILES`
 * (see vite.config.ts), so every build is a new worker and a new shell.
 */

const BUILD = "__VEMI_BUILD__";
/** The files this page loads. Kept at install, so it opens offline straight after the first visit. */
const FILES = "__VEMI_FILES__";
const PREFIX = "vemi-try-shell-";
const SHELL = `${PREFIX}${BUILD}`;
/** The page: a real file on every static server, so no rule is needed to serve it. */
const PAGE = "/try/";
/** A weak signal hangs rather than fails. Past this, what was kept is better than waiting. */
const PATIENCE_MS = 4000;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
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
    await Promise.all(names.filter((n) => n.startsWith(PREFIX) && n !== SHELL).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

/** Files this page loads and keeps: the built code and styles, the worker, the wasm, the icons. */
const isBuilt = (url) =>
  url.pathname.startsWith("/assets/")
  || url.pathname.startsWith("/try/assets/")
  || url.pathname.startsWith("/icons/")
  || url.pathname === "/icon.svg"
  || url.pathname === "/apple-touch-icon.png";

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isBuilt(url)) {
    event.respondWith(keptThenNetwork(request));
    return;
  }
  // The page itself: the newest build when it can be had, the kept one when it cannot.
  if (request.mode === "navigate" && (url.pathname === "/try" || url.pathname.startsWith("/try/"))) {
    event.respondWith(networkThenKept(new Request(PAGE)));
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

/** A device that will not keep a copy must still be handed the answer. */
async function keep(cache, request, response) {
  try {
    await cache.put(request, response);
  } catch {
    // Not kept; asked for again next time.
  }
}

async function networkThenKept(request) {
  const cache = await caches.open(SHELL);
  const network = fetch(request).then(async (fetched) => {
    const response = await unredirected(fetched);
    if (response.ok) await keep(cache, request, response.clone());
    return response;
  });
  try {
    return await withPatience(network);
  } catch {
    const kept = await cache.match(request);
    if (kept !== undefined) return kept;
    try {
      return await network;
    } catch {
      return Response.error();
    }
  }
}

async function keptThenNetwork(request) {
  const cache = await caches.open(SHELL);
  const kept = await cache.match(request);
  if (kept !== undefined) return kept;
  const response = await fetch(request);
  const page = (response.headers.get("content-type") ?? "").includes("text/html");
  if (response.ok && !page) await keep(cache, request, response.clone());
  return response;
}
