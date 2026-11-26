import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { catalogue, iconFile, iconFiles } from "./assets.js";
import { drawingOf, forgetIcons, Icon, iconUrl, loadCatalogue, loadIcon, loadedIcon, parseIcon } from "./index.js";

const render = (name: string | null | undefined): string => renderToStaticMarkup(createElement(Icon, { name }));

/** The Worker, as far as icons go: the build's files, and the app's page for anything else. */
function worker(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const path = String(input).replace(/^\/icons\//, "");
    const body = iconFile(path);
    if (body === null) return new Response("<!doctype html><div id=root></div>", { status: 200, headers: { "content-type": "text/html" } });
    const type = path.endsWith(".json") ? "application/json" : "image/svg+xml";
    return new Response(body, { status: 200, headers: { "content-type": type } });
  }) as typeof fetch;
}

afterEach(() => forgetIcons());

describe("parseIcon", () => {
  it("reads a name in either set, and keeps identical names apart", () => {
    expect(parseIcon("lucide:apple")).toEqual({ set: "lucide", key: "apple" });
    expect(parseIcon("brand:apple")).toEqual({ set: "brand", key: "apple" });
    expect(iconUrl({ set: "brand", key: "apple" })).toBe("/icons/brand/apple.svg");
  });

  it("reads nothing, without throwing, from anything that cannot name an icon", () => {
    for (const name of [
      null, undefined, "", "rocket", ":rocket", "lucide:", "brand:", "streamline:rocket", "emoji:🚀",
      "lucide:../../secret", "lucide:Rocket", "brand:a/b",
    ]) {
      expect(parseIcon(name), String(name)).toBeNull();
    }
  });
});

describe("the files the build writes", () => {
  it("lists every Lucide icon and every brand mark, without mixing them", () => {
    const names = catalogue();
    expect(names.lucide).toContain("rocket");
    expect(names.lucide).toContain("apple");
    expect(names.lucide).not.toContain("github");
    expect(names.brands.length).toBeGreaterThan(3000);
    expect(names.brands).toContainEqual({ slug: "github", title: "GitHub" });
    expect(names.brands).toContainEqual({ slug: "apple", title: "Apple" });
  });

  it("puts each set under its own folder, one file an icon, and carries no brand hex or source", () => {
    const files = iconFiles();
    const names = catalogue();
    expect(files).toHaveLength(names.lucide.length + names.brands.length + 1);
    expect(files.every((f) => /^icons\/(lucide|brand)\/[a-z0-9_-]+\.svg$|^icons\/names\.json$/.test(f.fileName))).toBe(true);
    const list = files.find((f) => f.fileName === "icons/names.json")?.source ?? "";
    expect(list).not.toContain("\"hex\":");
    expect(list).not.toContain("https://");
  });

  it("serves nothing outside the two folders", () => {
    expect(iconFile("lucide/rocket.svg")).toContain("<svg");
    expect(iconFile("lucide/not-an-icon.svg")).toBeNull();
    expect(iconFile("../package.json")).toBeNull();
    expect(iconFile("lucide/../../package.json")).toBeNull();
  });
});

describe("drawingOf", () => {
  it("takes the drawing out of a Lucide file, notice and outer element off", () => {
    const d = drawingOf({ set: "lucide", key: "rocket" }, iconFile("lucide/rocket.svg") ?? "");
    expect(d?.markup).toMatch(/^<path d="M12 15v5/);
    expect(d?.markup).not.toContain("<svg");
    expect(d?.markup).not.toContain("license");
  });

  it("takes a brand mark's path and leaves its title", () => {
    const d = drawingOf({ set: "brand", key: "github" }, iconFile("brand/github.svg") ?? "");
    expect(d?.markup).toMatch(/^<path d="M12 \.297/);
    expect(d?.markup).not.toContain("<title>");
  });

  it("refuses a page, and anything that is not only shapes", () => {
    const ref = { set: "lucide", key: "x" } as const;
    expect(drawingOf(ref, "<!doctype html><div id=root></div>")).toBeNull();
    expect(drawingOf(ref, "<svg><script>alert(1)</script></svg>")).toBeNull();
    expect(drawingOf(ref, "<svg><path onload=\"x()\" d=\"M0 0\"/></svg>")).toBeNull();
  });
});

describe("loadIcon", () => {
  it("fetches an icon once, however many ask at once", async () => {
    const doFetch = vi.fn(worker());
    const [a, b] = await Promise.all([loadIcon("lucide:rocket", doFetch), loadIcon("lucide:rocket", doFetch)]);
    expect(a).toEqual(b);
    expect(a?.set).toBe("lucide");
    await loadIcon("lucide:rocket", doFetch);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("remembers an icon that does not exist, including when the page comes back instead", async () => {
    const doFetch = vi.fn(worker());
    expect(await loadIcon("lucide:not-an-icon", doFetch)).toBeNull();
    expect(loadedIcon("lucide:not-an-icon")).toBeNull();
    await loadIcon("lucide:not-an-icon", doFetch);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("tries again after a failure to reach the Worker", async () => {
    const doFetch = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await loadIcon("lucide:rocket", doFetch as unknown as typeof fetch)).toBeNull();
    expect(loadedIcon("lucide:rocket")).toBeUndefined();
    await loadIcon("lucide:rocket", doFetch as unknown as typeof fetch);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("loads the picker's lists once", async () => {
    const doFetch = vi.fn(worker());
    const names = await loadCatalogue(doFetch);
    await loadCatalogue(doFetch);
    expect(names.lucide).toContain("rocket");
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
});

describe("Icon", () => {
  it("renders nothing until it has loaded, and nothing for no name or an unknown one", async () => {
    expect(render("lucide:rocket")).toBe("");
    await loadIcon("lucide:not-an-icon", worker());
    await loadIcon("brand:not-a-brand", worker());
    for (const name of [null, undefined, "nonsense", "lucide:not-an-icon", "brand:not-a-brand"]) {
      expect(render(name), String(name)).toBe("");
    }
  });

  it("draws a brand mark from its own path, in currentColor rather than the brand's hex", async () => {
    await loadIcon("brand:apple", worker());
    const html = render("brand:apple");
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('data-icon-set="brand"');
    expect(html).toContain("<path d=");
    expect(html).not.toContain("#");
  });

  it("draws a different picture for lucide:apple than for brand:apple", async () => {
    await Promise.all([loadIcon("lucide:apple", worker()), loadIcon("brand:apple", worker())]);
    const lucide = render("lucide:apple");
    const brand = render("brand:apple");
    expect(lucide).toContain("lucide-apple");
    expect(lucide).toContain('stroke="currentColor"');
    expect(lucide).not.toBe(brand);
  });
});
