import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./walk.js";
import { ICON_FILES } from "../src/web/appIcon.js";
import { parseRoute } from "../src/web/router.js";

/**
 * A browser offers to install the app only when the manifest meets its criteria, and it
 * says nothing when it does not. These hold the manifest and the page head to the list at
 * https://web.dev/articles/install-criteria, and to the files the build emits.
 */

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}
interface Manifest {
  id?: string;
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  prefer_related_applications?: boolean;
  icons: ManifestIcon[];
  share_target?: { action: string; method?: string; params: { title?: string; text?: string; url?: string } };
  shortcuts?: { name: string; url: string; icons?: Omit<ManifestIcon, "purpose">[] }[];
}

const manifest = JSON.parse(readFileSync(join(ROOT, "public/manifest.webmanifest"), "utf8")) as Manifest;
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const emitted = new Set(ICON_FILES.map((file) => `/${file.fileName}`));

describe("the web manifest", () => {
  it("meets each criterion on the web.dev install list", () => {
    expect(manifest.name || manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"]).toContain(manifest.display);
    expect(manifest.prefer_related_applications ?? false).toBe(false);
  });

  it("names the app by an id", () => {
    expect(manifest.id).toBe("/");
  });

  it("keeps a 192 and a 512 PNG", () => {
    const png = manifest.icons.filter((icon) => icon.type === "image/png");
    expect(png.some((icon) => icon.sizes === "192x192" && icon.src === "/icon-192.png")).toBe(true);
    expect(png.some((icon) => icon.sizes === "512x512" && icon.src === "/icon-512.png")).toBe(true);
  });

  it("keeps a maskable 512 PNG and the SVG", () => {
    expect(manifest.icons).toContainEqual({ src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" });
    expect(manifest.icons.some((icon) => icon.src === "/icon.svg" && icon.purpose === "any")).toBe(true);
  });

  it("names only icons the build emits", () => {
    for (const icon of manifest.icons) expect(emitted.has(icon.src), icon.src).toBe(true);
    for (const icon of (manifest.shortcuts ?? []).flatMap((s) => s.icons ?? [])) expect(emitted.has(icon.src), icon.src).toBe(true);
  });

  // A shortcut opens the app at its url as a page load, which the service worker and the
  // Worker's single-page fallback both answer with the app at any path the client routes.
  it("offers Add a task from the icon, at a path the app routes to Add", () => {
    const add = manifest.shortcuts?.find((s) => s.name === "Add a task");
    expect(add?.url).toBe("/add");
    expect(parseRoute(add?.url ?? "", "").surface).toBe("add");
  });

  // The share sheet is a GET to Add: a POST would never reach the Worker, because assets
  // are served without it.
  it("is a share target that opens Add with the title, text and url", () => {
    const target = manifest.share_target;
    expect(target?.method).toBe("GET");
    expect(target?.action).toBe("/add");
    expect(target?.params).toEqual({ title: "title", text: "text", url: "url" });
    expect(parseRoute(target?.action ?? "", "").surface).toBe("add");
  });
});

describe("the page head", () => {
  it("points the apple touch icon at a built PNG", () => {
    const tag = html.match(/<link[^>]*rel="apple-touch-icon"[^>]*>/)?.[0] ?? "";
    expect(tag).toMatch(/href="\/apple-touch-icon\.png"/);
    expect(tag).toMatch(/sizes="180x180"/);
    expect(emitted.has("/apple-touch-icon.png")).toBe(true);
  });

  it("names the app on a home screen and sets no status-bar style", () => {
    expect(html).toMatch(/<meta name="apple-mobile-web-app-title" content="VEMI" \/>/);
    expect(html).not.toMatch(/status-bar/);
  });
});
