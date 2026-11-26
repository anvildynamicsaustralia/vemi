// Fails on any em-dash (U+2014) in code or text that a person can see: string literals, template
// literals, JSX text and CSS content (comments are ignored), plus README and the root markdown
// files, docs/, .github/, the docs pages, index.html and the text files under public (every line
// counts). Generated files are skipped.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DASH = "—";
const exts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".css", ".html"]);
const skipDir = new Set(["node_modules", "dist", ".wrangler", "gen", "generated"]);

// Root markdown files that are rules and decisions for the builders, not text a visitor reads.
const INTERNAL_ROOT = new Set(["AGENTS.md", "CLAUDE.md"]);

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function* walk(dir, wanted) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!skipDir.has(name)) yield* walk(full, wanted);
    } else if (
      wanted.has(name.slice(name.lastIndexOf("."))) &&
      !name.endsWith(".d.ts") &&
      !/\.gen\./.test(name)
    ) {
      yield full;
    }
  }
}

// Blank out comments, keeping newlines so line numbers stay true. Comment markers inside string,
// template and regex literals are not comments. ' and " strings end at a newline, so a stray
// apostrophe in JSX text cannot swallow the rest of the file.
function stripComments(text, css) {
  let out = "";
  let i = 0;
  let last = ""; // last significant character outside comments, to tell a regex from a division
  const templates = []; // brace depth at each open ${ inside a template literal
  let depth = 0;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  const readTemplate = () => {
    // i is just after a ` or the closing } of a ${ ; copy template text up to the next ${ or `
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        out += text.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        out += c;
        i++;
        last = "`";
        return;
      } else if (c === "$" && text[i + 1] === "{") {
        out += "${";
        i += 2;
        templates.push(depth++);
        last = "{";
        return;
      } else {
        out += c;
        i++;
      }
    }
  };
  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blank(text.slice(i, stop));
      i = stop;
    } else if (!css && two === "//" && text[i - 1] !== ":") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, text.length);
      out += text.slice(i, stop);
      i = stop;
      last = c;
    } else if (!css && c === "`") {
      out += c;
      i++;
      readTemplate();
    } else if (!css && c === "{") {
      depth++;
      out += c;
      i++;
      last = c;
    } else if (!css && c === "}") {
      depth--;
      out += c;
      i++;
      last = c;
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop();
        readTemplate();
      }
    } else if (!css && c === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last))) {
      // A regex literal: copy it whole, honouring escapes and [...] classes.
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== "\n" && (inClass || text[j] !== "/")) {
        if (text[j] === "\\") j++;
        else if (text[j] === "[") inClass = true;
        else if (text[j] === "]") inClass = false;
        j++;
      }
      const stop = Math.min(j + 1, text.length);
      out += text.slice(i, stop);
      i = stop;
      last = "/";
    } else {
      out += c;
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out;
}

export function scan(root) {
  const found = [];
  const rel = (file) => relative(root, file).replaceAll("\\", "/");
  const report = (file, text, plain) => {
    if (!text.includes(DASH)) return;
    const lines = (plain ? text : stripComments(text, file.endsWith(".css"))).split("\n");
    lines.forEach((line, n) => {
      if (line.includes(DASH)) found.push(`${rel(file)}:${n + 1}`);
    });
  };
  // The root `src` holds every source folder: the Worker, the client, shared and icons.
  const src = join(root, "src");
  if (isDir(src)) for (const file of walk(src, exts)) report(file, readFileSync(file, "utf8"), false);
  // The public docs: README, every other root markdown file a visitor reads, docs/ and .github/.
  // The internal root files are rules and decisions for the people building VEMI, not its prose.
  if (isDir(root)) {
    for (const name of readdirSync(root)) {
      const file = join(root, name);
      if (name.endsWith(".md") && !INTERNAL_ROOT.has(name) && isFile(file)) report(file, readFileSync(file, "utf8"), true);
    }
  }
  const pages = join(root, "docs");
  if (isDir(pages)) for (const file of walk(pages, new Set([".md"]))) report(file, readFileSync(file, "utf8"), true);
  const github = join(root, ".github");
  if (isDir(github)) {
    for (const file of walk(github, new Set([".md", ".yml", ".yaml", ".json", ".txt"]))) {
      report(file, readFileSync(file, "utf8"), true);
    }
  }
  // The shell page and the plain-text files served as they are.
  const index = join(root, "index.html");
  if (isFile(index)) report(index, readFileSync(index, "utf8"), true);
  const pub = join(root, "public");
  if (isDir(pub)) {
    for (const file of walk(pub, new Set([".html", ".json", ".webmanifest", ".txt", ".svg"]))) {
      report(file, readFileSync(file, "utf8"), true);
    }
  }
  return found;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = scan(process.cwd());
  if (found.length) {
    for (const where of found) console.error(`${where}: no em-dash in a user-facing string`);
    console.error(`em-dash scan: ${found.length} finding(s)`);
    process.exit(1);
  }
  console.log("em-dash scan: clean");
}
