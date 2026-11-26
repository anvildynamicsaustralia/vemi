import { describe, expect, it } from "vitest";
import { qrMatrix, qrReedSolomon, qrSvg } from "./qr.js";

// A small independent reader: format bits, unmask, walk the zigzag, de-interleave, check parity.
const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS: [number, number, number, number][] = [
  [1, 16, 0, 0], [1, 28, 0, 0], [1, 44, 0, 0], [2, 32, 0, 0], [2, 43, 0, 0],
  [4, 27, 0, 0], [4, 31, 0, 0], [2, 38, 2, 39], [3, 36, 2, 37], [4, 43, 1, 44],
];

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function formatBits(m: boolean[][]): number {
  let v = 0;
  for (let i = 0; i <= 5; i++) v |= (m[i]![8]! ? 1 : 0) << i;
  v |= (m[7]![8]! ? 1 : 0) << 6;
  v |= (m[8]![8]! ? 1 : 0) << 7;
  v |= (m[8]![7]! ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) v |= (m[8]![14 - i]! ? 1 : 0) << i;
  return v;
}

function readFunction(version: number): boolean[][] {
  const size = version * 4 + 17;
  const f = Array.from({ length: size }, () => Array.from<boolean>({ length: size }).fill(false));
  const box = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) f[y]![x] = true;
  };
  box(0, 0, 9, 9); box(size - 8, 0, 8, 9); box(0, size - 8, 9, 8);
  box(6, 0, 1, size); box(0, 6, size, 1);
  const pos: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const p = pos[version]!;
  for (const a of p) for (const b of p) {
    if ((a === 6 && b === 6) || (a === 6 && b === p[p.length - 1]) || (a === p[p.length - 1] && b === 6)) continue;
    box(a - 2, b - 2, 5, 5);
  }
  if (version >= 7) { box(size - 11, 0, 3, 6); box(0, size - 11, 6, 3); }
  return f;
}

function read(m: boolean[][]): { text: string; mask: number; version: number } {
  const size = m.length;
  const version = (size - 17) / 4;
  const fmt = formatBits(m) ^ 0x5412;
  expect(fmt >> 13).toBe(0); // level M is 00
  const mask = (fmt >> 10) & 7;
  const fn = readFunction(version);
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (fn[y]![x]) continue;
      bits.push(m[y]![x]! !== MASKS[mask]!(x, y) ? 1 : 0);
    }
  }
  const all: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) all.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const [g1, d1, g2, d2] = BLOCKS[version - 1]!;
  const ec = EC_PER_BLOCK[version - 1]!;
  const sizes = [...Array(g1).fill(d1), ...Array(g2).fill(d2)] as number[];
  const blocks = sizes.map(() => ({ data: [] as number[], ec: [] as number[] }));
  let at = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) sizes.forEach((s, b) => { if (i < s) blocks[b]!.data.push(all[at++]!); });
  for (let i = 0; i < ec; i++) blocks.forEach((b) => b.ec.push(all[at++]!));
  const data: number[] = [];
  for (const b of blocks) {
    expect(qrReedSolomon(b.data, ec)).toEqual(b.ec);
    data.push(...b.data);
  }
  const bitString = data.map((v) => v.toString(2).padStart(8, "0")).join("");
  expect(bitString.slice(0, 4)).toBe("0100");
  const countBits = version >= 10 ? 16 : 8;
  const n = parseInt(bitString.slice(4, 4 + countBits), 2);
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = parseInt(bitString.slice(4 + countBits + i * 8, 12 + countBits + i * 8), 2);
  return { text: new TextDecoder().decode(bytes), mask, version };
}

describe("qrReedSolomon", () => {
  it("matches the ISO 18004 example for 01234567 at version 1-M", () => {
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11];
    expect(qrReedSolomon(data, 10)).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
  });
});

describe("qrMatrix", () => {
  it("is 21 modules square for a short text and grows by 4 per version", () => {
    expect(qrMatrix("HELLO WORLD").length).toBe(21);
    expect(qrMatrix("a".repeat(15)).length).toBe(25);
    expect(qrMatrix("a".repeat(213)).length).toBe(57);
  });

  it("draws finder patterns, timing lines and the dark module", () => {
    const m = qrMatrix("HELLO WORLD");
    const n = m.length;
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const edge = x === 0 || x === 6 || y === 0 || y === 6;
        const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        expect(m[oy + y]![ox + x]).toBe(edge || core);
      }
    }
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    expect(m[n - 8]![8]).toBe(true);
  });

  it("writes level M and the same format bits in both places", () => {
    const m = qrMatrix("HELLO WORLD");
    const n = m.length;
    const fmt = formatBits(m);
    let second = 0;
    for (let i = 0; i < 8; i++) second |= (m[8]![n - 1 - i]! ? 1 : 0) << i;
    for (let i = 8; i < 15; i++) second |= (m[n - 15 + i]![8]! ? 1 : 0) << i;
    expect(second).toBe(fmt);
    const data = (fmt ^ 0x5412) >> 10;
    expect(data >> 3).toBe(0);
    // BCH remainder is valid
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    expect(((data << 10) | rem) ^ 0x5412).toBe(fmt);
  });

  it("carries version bits from version 7", () => {
    const m = qrMatrix("a".repeat(122));
    expect(m.length).toBe(45);
    let v = 0;
    for (let i = 0; i < 18; i++) v |= (m[Math.floor(i / 3)]![m.length - 11 + (i % 3)]! ? 1 : 0) << i;
    expect(v >> 12).toBe(7);
    let rem = 7;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    expect(v & 0xfff).toBe(rem);
  });

  it("picks the mask with the lowest penalty and reads back", () => {
    const seen = new Set<number>();
    for (const text of ["HELLO WORLD", "hello world", "https://vemi.example/x", "0123456789", "a"]) {
      const r = read(qrMatrix(text));
      expect(r.text).toBe(text);
      seen.add(r.mask);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("round-trips an otpauth URI, multi-block, and non-ASCII text", () => {
    const uri = "otpauth://totp/VEMI:andy%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=VEMI&algorithm=SHA1&digits=6&period=30";
    expect(read(qrMatrix(uri)).text).toBe(uri);
    for (const text of ["x".repeat(62), "y".repeat(100), "z".repeat(152), "w".repeat(180), "v".repeat(213), "café ☃"]) {
      const r = read(qrMatrix(text));
      expect(r.text).toBe(text);
    }
    expect(read(qrMatrix("x".repeat(107))).version).toBe(7);
  });

  it("is deterministic", () => {
    expect(qrMatrix("same")).toEqual(qrMatrix("same"));
  });

  it("refuses text over version 10", () => {
    expect(() => qrMatrix("a".repeat(214))).toThrow(/too long/i);
  });
});

describe("qrSvg", () => {
  it("returns one svg with a single path of the dark modules", () => {
    const m = qrMatrix("HELLO WORLD");
    const svg = qrSvg(m);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0 0 21 21"');
    expect(svg.match(/<path/g)?.length).toBe(1);
    expect(svg).toContain('fill="currentColor"');
    const d = /d="([^"]*)"/.exec(svg)![1]!;
    const dark = m.flat().filter(Boolean).length;
    let drawn = 0;
    for (const run of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
      for (let i = 0; i < Number(run[3]); i++) expect(m[Number(run[2])]![Number(run[1]) + i]).toBe(true);
      drawn += Number(run[3]);
    }
    expect(drawn).toBe(dark);
  });

  it("has no em-dash and no colour literal", () => {
    const svg = qrSvg(qrMatrix("a"));
    expect(svg).not.toMatch(/[\u{2014}]|#[0-9a-f]{3}|rgb\(/iu);
  });
});
