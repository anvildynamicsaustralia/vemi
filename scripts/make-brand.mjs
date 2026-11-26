// Builds the brand files from brand/vemi-wordmark.svg (the traced wordmark, in the owner's
// own artwork): the app icons, the favicon, the social preview and the animated wordmark.
// Run by hand when the artwork changes: `node scripts/make-brand.mjs`. It uses the
// Playwright already in devDependencies to turn an SVG into a PNG, so nothing is added.
// The two typefaces the artwork was drawn from (Ibrand and JUST Sans) are not in this repo.
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INK = "#0b0b0b";
const WHITE = "#ffffff";
const LIVE = "#e85c24"; // THEME.live in src/shared/theme.ts

const wordmark = readFileSync(join(ROOT, "brand/vemi-wordmark.svg"), "utf8");
const grab = (id) => {
  const m = new RegExp(`<path id="${id}"[^>]*? d="([^"]+)"`).exec(wordmark);
  if (!m) throw new Error(`no ${id} path in the wordmark`);
  return m[1];
};
const V = grab("v");
const DOT = grab("dot");

// The mark: the v, with the dot lifted from the i and set over its right arm, as it sits
// over the i in the wordmark. Group box in wordmark units: x 196..485, y 481..898.
const GROUP = { x: 195.9, y: 481, w: 288.9, h: 416.8 };
const DOT_CENTRE_ORIGIN = { x: 1250.9, y: 533.5 };
const DOT_AT = { x: 447, y: 530 };

function markSvg(size, height) {
  const s = height / GROUP.h;
  const tx = (100 - GROUP.w * s) / 2 - GROUP.x * s;
  const ty = (100 - GROUP.h * s) / 2 - GROUP.y * s;
  const dx = DOT_AT.x - DOT_CENTRE_ORIGIN.x;
  const dy = DOT_AT.y - DOT_CENTRE_ORIGIN.y;
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="100" height="100" fill="${WHITE}"/>
  <g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${s.toFixed(5)})">
    <path fill="${INK}" d="${V}"/>
    <path fill="${LIVE}" transform="translate(${dx} ${dy})" d="${DOT}"/>
  </g>
</svg>
`;
}

const regular = markSvg(0, 54);
const maskable = markSvg(0, 40);
const out = (name, body) => writeFileSync(join(ROOT, "brand/icons", name), body);
mkdirSync(join(ROOT, "brand/icons"), { recursive: true });
out("icon.svg", regular.replace(' width="0" height="0"', ""));
out("icon-maskable.svg", maskable.replace(' width="0" height="0"', ""));

// The animated wordmark: the letters rise one after another and the dot drops.
// Motion stops for anyone who asked their device for less of it.
const body = (fill) => wordmark
  .replace(/<svg[^>]*>/, "")
  .replace("</svg>", "")
  .replace(/\s*<title>[^<]*<\/title>/, "")
  .replaceAll("#0b0b0b", fill);
const animated = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="155 447 1190 496" role="img" aria-label="VEMI">
  <title>VEMI</title>
  <style>
    .p { transform-box: fill-box; transform-origin: 50% 100%; animation: rise 700ms cubic-bezier(.2,.8,.2,1) both; }
    #v { animation-delay: 0ms } #em { animation-delay: 140ms } #i { animation-delay: 280ms }
    #dot { transform-origin: 50% 50%; animation: drop 900ms cubic-bezier(.3,1.4,.5,1) 520ms both; }
    @keyframes rise { from { opacity: 0; transform: translateY(40px) } to { opacity: 1; transform: none } }
    @keyframes drop { from { opacity: 0; transform: translateY(-120px) } 60% { opacity: 1 } to { opacity: 1; transform: none } }
    @media (prefers-reduced-motion: reduce) { .p, #dot { animation: none } }
  </style>
${body(fill).replace(/<path id="(\w+)"/g, (_, id) => `<path class="p" id="${id}"`)}</svg>
`;
writeFileSync(join(ROOT, "brand/vemi-animated.svg"), animated(INK));
writeFileSync(join(ROOT, "brand/vemi-animated-white.svg"), animated(WHITE));

// PNGs, drawn by Chromium from the SVGs above.
const browser = await chromium.launch();
const page = await browser.newPage();
async function png(svg, width, height, file) {
  await page.setViewportSize({ width, height });
  const uri = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  await page.setContent(`<style>html,body{margin:0;background:#fff}img{display:block;width:${width}px;height:${height}px}</style><img src="${uri}">`);
  await page.waitForFunction(() => document.images[0]?.complete);
  await page.screenshot({ path: file, omitBackground: false });
}
const clean = (s) => s.replace(' width="0" height="0"', "");
await png(clean(regular), 192, 192, join(ROOT, "brand/icons/icon-192.png"));
await png(clean(regular), 512, 512, join(ROOT, "brand/icons/icon-512.png"));
await png(clean(maskable), 512, 512, join(ROOT, "brand/icons/icon-maskable-512.png"));
await png(clean(regular), 180, 180, join(ROOT, "brand/icons/apple-touch-icon.png"));

// Social preview, 1280 by 640 (brand/social-preview.png): the wordmark, centred on white.
const social = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 640" width="1280" height="640">
  <rect width="1280" height="640" fill="${WHITE}"/>
  <svg x="290" y="174" width="700" height="${(700 * 496) / 1190}" viewBox="155 447 1190 496">${body(INK)}</svg>
</svg>`;
await png(social, 1280, 640, join(ROOT, "brand/social-preview.png"));
await browser.close();
console.log("brand files written");
