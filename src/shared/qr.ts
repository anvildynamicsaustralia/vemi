// QR encoder: byte mode, error level M, versions 1 to 10, no dependency. Draws the 2-step setup code.

const EC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
// Blocks per version at level M: [count of short blocks, data codewords each, count of long blocks, data codewords each].
const BLOCKS: [number, number, number, number][] = [
  [1, 16, 0, 0], [1, 28, 0, 0], [1, 44, 0, 0], [2, 32, 0, 0], [2, 43, 0, 0],
  [4, 27, 0, 0], [4, 31, 0, 0], [2, 38, 2, 39], [3, 36, 2, 37], [4, 43, 1, 44],
];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** The Reed-Solomon parity bytes for one block of data codewords. */
export function qrReedSolomon(data: readonly number[], parity: number): number[] {
  // Generator coefficients, highest degree first, leading 1 left out.
  let gen = [1];
  for (let i = 0; i < parity; i++) {
    const next = Array.from<number>({ length: gen.length + 1 }).fill(0);
    gen.forEach((c, j) => {
      next[j] = next[j]! ^ c;
      next[j + 1] = next[j + 1]! ^ mul(c, EXP[i]!);
    });
    gen = next;
  }
  const rem = Array.from<number>({ length: parity }).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0]!;
    rem.shift();
    rem.push(0);
    for (let i = 0; i < parity; i++) rem[i] = rem[i]! ^ mul(gen[i + 1]!, factor);
  }
  return rem;
}

const capacity = (v: number) => {
  const [g1, d1, g2, d2] = BLOCKS[v - 1]!;
  return g1 * d1 + g2 * d2;
};

function codewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const put = (value: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, capacity(version) * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity(version); pad ^= 0xec ^ 0x11) data.push(pad);

  const [g1, d1, g2, d2] = BLOCKS[version - 1]!;
  const parity = EC_PER_BLOCK[version - 1]!;
  const sizes = [...Array<number>(g1).fill(d1), ...Array<number>(g2).fill(d2)];
  let at = 0;
  const blocks = sizes.map((s) => {
    const part = data.slice(at, at + s);
    at += s;
    return { part, ec: qrReedSolomon(part, parity) };
  });
  const out: number[] = [];
  for (let i = 0; i < Math.max(d1, d2); i++) for (const b of blocks) if (i < b.part.length) out.push(b.part[i]!);
  for (let i = 0; i < parity; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

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

function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < n; i++) {
      if (get(i) === get(i - 1)) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) score += 3 + (run - 5);
    for (let i = 0; i + 11 <= n; i++) {
      let w = "";
      for (let k = 0; k < 11; k++) w += get(i + k) ? "1" : "0";
      if (w === "10111010000" || w === "00001011101") score += 40;
    }
  };
  for (let a = 0; a < n; a++) {
    line((i) => m[a]![i]!);
    line((i) => m[i]![a]!);
  }
  for (let y = 0; y + 1 < n; y++) for (let x = 0; x + 1 < n; x++) {
    const c = m[y]![x]!;
    if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
  }
  const dark = m.reduce((s, r) => s + r.filter(Boolean).length, 0);
  const total = n * n;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

function build(version: number, words: number[], mask: number): boolean[][] {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => Array.from<boolean>({ length: size }).fill(false));
  const fn = Array.from({ length: size }, () => Array.from<boolean>({ length: size }).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    m[y]![x] = dark;
    fn[y]![x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, dist !== 2 && dist !== 4);
    }
  }
  const pos = ALIGN[version]!;
  const last = pos[pos.length - 1];
  for (const a of pos) for (const b of pos) {
    if ((a === 6 && b === 6) || (a === 6 && b === last) || (a === last && b === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  // Format bits: level M is 00, then the mask; BCH(15,5) and the fixed xor.
  let rem = mask;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const fmt = ((mask << 10) | rem) ^ 0x5412;
  const f = (i: number) => ((fmt >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, f(i));
  set(8, 7, f(6));
  set(8, 8, f(7));
  set(7, 8, f(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, f(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, f(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, f(i));
  set(8, size - 8, true);

  if (version >= 7) {
    let r = version;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (version << 12) | r;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y]![x] && i < words.length * 8) {
        m[y]![x] = ((words[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y]![x] && MASKS[mask]!(x, y)) m[y]![x] = !m[y]![x];
  return m;
}

/** The module grid for `text` (true is dark), row by row. Throws when it does not fit version 10. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    if (bytes.length * 8 + 4 + (v >= 10 ? 16 : 8) <= capacity(v) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error("QR text is too long (version 10 holds 213 bytes).");
  const words = codewords(bytes, version);
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(version, words, mask);
    const score = penalty(m);
    if (score < bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best!;
}

/** A plain SVG for the grid, one path, drawn in the current text colour. The quiet zone is the caller's margin. */
export function qrSvg(matrix: boolean[][]): string {
  const n = matrix.length;
  let d = "";
  matrix.forEach((row, y) => {
    for (let x = 0; x < n; ) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < n && row[end]) end++;
      d += `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path fill="currentColor" d="${d}"/></svg>`;
}
