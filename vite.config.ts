import { defineConfig, type Plugin, type Rollup } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { iconFile, iconFiles } from "./src/icons/assets.js";
import { ICON_FILES, iconBytes } from "./src/web/appIcon.js";

const source = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Every icon as its own file under `icons/`, fetched the first time it is drawn. The page's
 * code names no icon at all; see `src/icons`.
 */
function icons(): Plugin {
  return {
    name: "vemi-icons",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/icons/")) {
          next();
          return;
        }
        const path = decodeURIComponent(url.slice("/icons/".length).split("?")[0] ?? "");
        const body = iconFile(path);
        if (body === null) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("content-type", path.endsWith(".json") ? "application/json" : "image/svg+xml");
        res.end(body);
      });
    },
    generateBundle() {
      for (const file of iconFiles()) this.emitFile({ type: "asset", fileName: file.fileName, source: file.source });
    },
  };
}

/**
 * The app icon in every form an installing browser asks for, read from `brand/icons/`
 * (written by `scripts/make-brand.mjs`). It stays out of the bundle, so the page's code never
 * carries it.
 */
function appIcons(): Plugin {
  const body = (fileName: string): string | Uint8Array | null => {
    const file = ICON_FILES.find((candidate) => candidate.fileName === fileName);
    if (file === undefined) return null;
    return iconBytes(file.fileName);
  };
  return {
    name: "vemi-app-icons",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const fileName = (req.url ?? "").split("?")[0]?.slice(1) ?? "";
        const content = body(fileName);
        if (content === null) {
          next();
          return;
        }
        res.setHeader("content-type", fileName.endsWith(".svg") ? "image/svg+xml" : "image/png");
        res.end(content);
      });
    },
    generateBundle() {
      for (const file of ICON_FILES) this.emitFile({ type: "asset", fileName: file.fileName, source: body(file.fileName) ?? "" });
    },
  };
}

/**
 * Emit the service worker, stamped with the build. It lives in `src/web` rather than in
 * `public/`, because `public/` is copied untouched, and an unstamped worker is the same worker
 * on every deploy, holding every old build's files. The stamp is a hash of every file name
 * the build made, and those names carry their content's hash.
 */
function serviceWorker(): Plugin {
  /** The text of a built file, or null for a binary one. */
  const textOf = (file: Rollup.OutputBundle[string]): string | null =>
    file.type === "chunk" ? file.code : typeof file.source === "string" ? file.source : null;

  /**
   * Every built file a page loads, found from the page by following each mention of a file's
   * name (a hashed name, so a mention is a reference): imports, dynamic imports, styles, fonts,
   * and the worker and wasm a chunk names by URL.
   */
  const reach = (bundle: Rollup.OutputBundle, from: string): Set<string> => {
    const candidates = Object.keys(bundle).filter((name) => name.startsWith("assets/") || name.startsWith("try/assets/"));
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const text = textOf(bundle[queue.pop() as string] as Rollup.OutputBundle[string]);
      if (text === null) continue;
      for (const name of candidates) {
        if (!seen.has(name) && text.includes(name.slice(name.lastIndexOf("/") + 1))) {
          seen.add(name);
          queue.push(name);
        }
      }
    }
    return seen;
  };

  /** A worker file with its stamp and its file list written in, loudly when it cannot be. */
  const stamped = (path: string, stamp: string, files: readonly string[]): string => {
    const text = readFileSync(source(path), "utf8");
    // Exactly one quoted placeholder: a second mention would take the stamp and leave the real one.
    const placeholder = "\"__VEMI_BUILD__\"";
    const listed = "\"__VEMI_FILES__\"";
    if (text.split(placeholder).length !== 2) throw new Error(`${path} must hold exactly one "__VEMI_BUILD__" to stamp`);
    if (text.split(listed).length !== 2) throw new Error(`${path} must hold exactly one "__VEMI_FILES__" to fill`);
    return text.replace(placeholder, `"${stamp}"`).replace(listed, JSON.stringify(files.map((name) => `/${name}`)));
  };

  return {
    name: "vemi-service-worker",
    apply: "build",
    // After the pages are written: the lists are found by following each page's references.
    enforce: "post",
    generateBundle(_options, bundle) {
      const names = Object.keys(bundle).sort().join("\n");
      const stamp = createHash("sha256").update(names).digest("hex").slice(0, 12);
      // The page at /try has its own worker and its own files. What only that page loads stays
      // out of the app's list: the app's worker must not keep the database code.
      const tryOnly = new Set<string>();
      let tryFiles: string[] = [];
      if (bundle["try/index.html"] !== undefined) {
        const app = reach(bundle, "index.html");
        const page = reach(bundle, "try/index.html");
        for (const name of page) if (!app.has(name)) tryOnly.add(name);
        tryFiles = [...new Set([...page, ...Object.keys(bundle).filter((name) => name.startsWith("try/assets/"))])].sort();
        this.emitFile({ type: "asset", fileName: "try/sw.js", source: stamped("try/sw.js", stamp, tryFiles) });
      }
      // The built code and styles, kept at install. Icons are fetched as they are drawn.
      const files = Object.keys(bundle).filter((name) => name.startsWith("assets/") && !tryOnly.has(name)).sort();
      this.emitFile({ type: "asset", fileName: "sw.js", source: stamped("src/web/sw.js", stamp, files) });
    },
  };
}

export default defineConfig({
  plugins: [react(), icons(), appIcons(), serviceWorker()],
  resolve: {
    alias: {
      "@vemi/shared": source("./src/shared/index.ts"),
      "@vemi/icons": source("./src/icons/index.ts"),
    },
    // One React. A second copy through a peer dependency breaks every hook.
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    // Every browser that installs this app loads modules and their preloads on its own; the
    // polyfill is a request more on the way to the first screen.
    modulePreload: { polyfill: false },
    // Nothing inlined as a data: URL. The page's policy allows fonts from this origin only,
    // and Vite inlined the smallest font subsets, which the browser then refused to load.
    assetsInlineLimit: 0,
    // Three pages: the app, the setup page at /get/, which shares the app's tokens, fonts and
    // icons but runs none of its code and calls none of its routes, and the copy at /try/,
    // which is the app with its data kept in the browser. Only that page loads the database.
    rollupOptions: {
      input: { main: source("./index.html"), get: source("./get/index.html"), try: source("./try/index.html"), home: source("./home/index.html") },
      output: {
        // What the screens share goes in one file, not a dozen small ones: every file is a
        // request, and a phone on a slow link pays for each.
        codeSplitting: { groups: [{ name: "shell", test: /[\\/]src[\\/](?:web[\\/](?!local[\\/]|main\.tsx)|icons[\\/]|shared[\\/](?!setup))|[\\/]node_modules[\\/](?:react|react-dom|scheduler)[\\/]/, minShareCount: 2 }] },
      },
    },
  },
  // The database worker and the wasm it loads are served under /try/ so that the policy for
  // /try/* (the one that allows wasm) is the one on the worker's own response.
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        entryFileNames: "try/assets/[name]-[hash].js",
        chunkFileNames: "try/assets/[name]-[hash].js",
        assetFileNames: "try/assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    port: 5173,
    // Dev only. In production the Worker serves this client from its own origin. Locally,
    // `wrangler dev` answers on 8787; set ORIGIN=http://localhost:5173 in .dev.vars
    // so the sign-in and the WebSocket accept this page.
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
      "/auth": { target: "http://127.0.0.1:8787" },
    },
  },
});
