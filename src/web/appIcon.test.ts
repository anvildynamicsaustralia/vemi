import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_DIR, ICON_FILES, iconBytes } from "./appIcon.js";

/** The width and height a PNG's header declares. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

describe("the app icon files", () => {
  it("names the six files the build emits", () => {
    expect(ICON_FILES.map((file) => file.fileName).sort()).toEqual(
      ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "icon-maskable.svg", "icon.svg"],
    );
  });

  it("has every file on disk, and each PNG is the size it says", () => {
    for (const file of ICON_FILES) {
      expect(existsSync(join(ICON_DIR, file.fileName)), file.fileName).toBe(true);
      if (file.size === 0) continue;
      const png = iconBytes(file.fileName);
      expect([...png.subarray(0, 8)], file.fileName).toEqual(PNG_SIGNATURE);
      expect(pngSize(png), file.fileName).toEqual({ width: file.size, height: file.size });
    }
  });

  it("draws the SVGs as a 100-unit square carrying the mark and the accent dot", () => {
    for (const name of ["icon.svg", "icon-maskable.svg"]) {
      const svg = readFileSync(join(ICON_DIR, name), "utf8");
      expect(svg, name).toContain('viewBox="0 0 100 100"');
      expect(svg, name).toContain("<path");
      expect(svg, name).toContain("#e85c24");
      expect(svg, name).not.toContain(String.fromCharCode(0x2014));
    }
  });

  it("keeps the maskable mark smaller than the regular one, clear of a circular crop", () => {
    const scale = (name: string): number => Number(/scale\(([\d.]+)\)/.exec(readFileSync(join(ICON_DIR, name), "utf8"))?.[1]);
    expect(scale("icon-maskable.svg")).toBeLessThan(scale("icon.svg"));
  });
});

describe("the animated wordmarks", () => {
  it("carry exactly one title, so a screen reader says VEMI once", () => {
    for (const name of ["vemi-animated.svg", "vemi-animated-white.svg"]) {
      const svg = readFileSync(join(ICON_DIR, "..", name), "utf8");
      expect(svg.match(/<title>/g)?.length, name).toBe(1);
    }
  });
});
