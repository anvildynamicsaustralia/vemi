// Checks the links in the public docs: README.md, CONTRIBUTING.md, SECURITY.md, CHANGELOG.md and
// every docs/**/*.md. Fails on a relative link whose file is missing, a #anchor with no matching
// heading in its target, an image with no alt text, a link into .works, and a docs page that
// docs/index.md does not list. Absolute https links are listed and never fetched: this script
// touches no network.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"];
const skipDir = new Set(["node_modules", "dist", ".git", ".wrangler"]);

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function* markdownIn(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (isDir(full)) {
      if (!skipDir.has(name)) yield* markdownIn(full);
    } else if (name.endsWith(".md")) {
      yield full;
    }
  }
}

/** The text with code fences and inline code blanked, line count kept. */
function prose(text) {
  let fence = null;
  return text.split(/\r?\n/).map((line) => {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
      return "";
    }
    if (m) {
      fence = m[1];
      return "";
    }
    return line.replace(/`+[^`]*`+/g, (s) => " ".repeat(s.length));
  });
}

/** GitHub's heading id: lower case, punctuation dropped, spaces to hyphens, repeats numbered. */
function anchorsOf(text) {
  const seen = new Map();
  const out = new Set();
  for (const line of prose(text)) {
    const m = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const plain = m[1]
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    const n = seen.get(plain) ?? 0;
    seen.set(plain, n + 1);
    out.add(n === 0 ? plain : `${plain}-${n}`);
  }
  return out;
}

const LINK = /(!?)\[((?:[^\][]|!\[[^\]]*\]\([^)]*\))*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g;

export function check(root) {
  const problems = [];
  const external = [];
  const rel = (file) => relative(root, file).split(sep).join("/");
  const files = [];
  for (const name of ROOT_FILES) if (isFile(join(root, name))) files.push(join(root, name));
  const docsDir = join(root, "docs");
  if (isDir(docsDir)) files.push(...markdownIn(docsDir));

  const texts = new Map();
  const textOf = (file) => {
    if (!texts.has(file)) texts.set(file, readFileSync(file, "utf8"));
    return texts.get(file);
  };
  const anchorCache = new Map();
  const anchorsFor = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(textOf(file)));
    return anchorCache.get(file);
  };

  const linkedFromIndex = new Set();
  const indexFile = join(docsDir, "index.md");

  for (const file of files) {
    const lines = prose(textOf(file));
    lines.forEach((line, i) => {
      const where = `${rel(file)}:${i + 1}`;
      for (const m of line.matchAll(LINK)) {
        const [, bang, label, target] = m;
        if (bang && label.trim() === "") problems.push(`${where}: image has no alt text (${target})`);
        if (target === "") continue;
        if (/^https?:\/\//i.test(target)) {
          external.push(`${where}: ${target}`);
          continue;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // mailto:, tel: and the like
        const hash = target.indexOf("#");
        const pathPart = decodeURI(hash === -1 ? target : target.slice(0, hash));
        const anchor = hash === -1 ? "" : decodeURI(target.slice(hash + 1));
        const dest = pathPart === ""
          ? file
          : pathPart.startsWith("/") ? join(root, pathPart) : resolve(dirname(file), pathPart);
        const inside = relative(root, dest).split(sep);
        if (inside.includes(".works")) {
          problems.push(`${where}: link to a .works path (${target})`);
          continue;
        }
        if (!existsSync(dest)) {
          problems.push(`${where}: link to a missing file (${target})`);
          continue;
        }
        if (file === indexFile && isFile(dest)) linkedFromIndex.add(dest);
        if (anchor !== "" && isFile(dest) && dest.endsWith(".md") && !anchorsFor(dest).has(anchor.toLowerCase())) {
          problems.push(`${where}: no heading for #${anchor} in ${rel(dest)}`);
        }
      }
    });
  }

  // A docs folder that holds only pictures has no pages to list yet.
  if (isDir(docsDir) && [...markdownIn(docsDir)].length > 0) {
    if (!isFile(indexFile)) {
      problems.push("docs/index.md: missing, so no page is listed");
    } else {
      for (const file of markdownIn(docsDir)) {
        if (file !== indexFile && !linkedFromIndex.has(file)) {
          problems.push(`${rel(file)}: page not listed in docs/index.md`);
        }
      }
    }
  }
  return { problems, external };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { problems, external } = check(process.cwd());
  for (const link of external) console.log(`external, not fetched: ${link}`);
  if (problems.length) {
    for (const p of problems) console.error(p);
    console.error(`link check: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log("link check: clean");
}
