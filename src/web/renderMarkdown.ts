/**
 * A task body, read as blocks. Pure, and with no dependency.
 *
 * There is no markdown library here on purpose. The whole grammar is three constructs —
 * a heading, a list, a link — and every library that renders them also renders a dozen we
 * refuse, arrives with more configuration than this file has code, carries an upgrade
 * chore forever, and brings a general HTML parser's attack surface for no gain. The rule
 * that judges every addition on the upkeep it creates decides the argument on its own.
 *
 * It returns blocks rather than an HTML string, so the component maps them to React
 * elements and nothing anywhere needs `dangerouslySetInnerHTML`. Markdown is the storage
 * format so that what is written here outlives this application; the reader below is the
 * only thing that has to know that.
 *
 * What is not in the grammar is text. No emphasis, no code, no images, no tables, no
 * quotes, no nesting and no ordered lists: a character that looks like syntax is the
 * character that was typed.
 */

export type Inline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

export type Block =
  | { readonly kind: "heading"; readonly spans: readonly Inline[] }
  | { readonly kind: "list"; readonly items: readonly (readonly Inline[])[] }
  | { readonly kind: "paragraph"; readonly spans: readonly Inline[] };

/**
 * The schemes a link may carry, and the security-relevant line in this module.
 *
 * A body is typed by its owner, but it is also pasted, restored from a backup and one day
 * imported, so the reader never assumes the writer. Anything that is not one of these
 * three — `javascript:`, `data:`, a bare word, no scheme at all — is given back as the
 * literal text it was written as and never becomes a link at all. Refusing here, where
 * the block is built, means there is nowhere later that a scheme could be let through.
 */
const ALLOWED = new Set(["http:", "https:", "mailto:"]);
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The `)` that closes the `(` at `open`, counting the pairs inside so a url may hold one. */
function closes(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** One line's text and links. Anything that does not complete a link stays as it was typed. */
function spansOf(line: string): readonly Inline[] {
  const out: Inline[] = [];
  let plain = "";
  const flush = (): void => {
    if (plain !== "") out.push({ kind: "text", text: plain });
    plain = "";
  };

  let i = 0;
  while (i < line.length) {
    if (line[i] !== "[") {
      plain += line[i];
      i++;
      continue;
    }
    const shut = line.indexOf("]", i + 1);
    const open = shut + 1;
    const end = shut === -1 || line[open] !== "(" ? -1 : closes(line, open);
    if (end === -1) {
      // An unclosed `[`, or one with no url after it, is a bracket someone typed.
      plain += line[i];
      i++;
      continue;
    }
    const href = line.slice(open + 1, end).trim();
    const scheme = SCHEME.exec(href);
    if (scheme === null || !ALLOWED.has(scheme[0].toLowerCase())) {
      plain += line.slice(i, end + 1);
    } else {
      flush();
      out.push({ kind: "link", text: line.slice(i + 1, shut), href });
    }
    i = end + 1;
  }
  flush();
  return out;
}

/**
 * A paragraph's spans, read a line at a time.
 *
 * A link is written **in a line**, which is the grammar this module states and the one the
 * field's Link control writes. So each line is read on its own and the newline between two
 * of them is text: `[the form](https://ok` with `.com)` beneath it is two lines someone
 * typed, not one link with a newline in its url. Neighbouring text joins back into a single
 * span, so a paragraph holding no link at all reads as the text it was written as.
 */
function spansOfLines(lines: readonly string[]): readonly Inline[] {
  const out: Inline[] = [];
  const add = (span: Inline): void => {
    const last = out.at(-1);
    if (span.kind === "text" && last !== undefined && last.kind === "text") {
      out[out.length - 1] = { kind: "text", text: last.text + span.text };
      return;
    }
    out.push(span);
  };
  lines.forEach((line, i) => {
    if (i > 0) add({ kind: "text", text: "\n" });
    for (const span of spansOf(line)) add(span);
  });
  return out;
}

/**
 * The blocks a body reads as. Null and a body of nothing but blank lines are both no
 * blocks at all, which is what an empty sheet shows a placeholder for.
 *
 * A heading is a line beginning with one to three hashes and a space: one level, because
 * the sheet has one heading size and an outline of levels is a document model, which is
 * refused. A run of lines each beginning with a dash and a space is one list. Everything
 * else is a paragraph, and a blank line is what separates one from the next.
 *
 * The lines of a paragraph are joined with the newline that was typed rather than a
 * space, so the component decides whether a line someone broke on purpose is shown broken.
 * They are read one at a time, because a link is written in a line and never reaches over
 * the break to find its closing bracket in the line below.
 */
export function renderMarkdown(body: string | null): readonly Block[] {
  if (body === null) return [];
  const blocks: Block[] = [];
  let lines: string[] = [];
  let items: (readonly Inline[])[] = [];

  const endParagraph = (): void => {
    if (lines.length > 0) blocks.push({ kind: "paragraph", spans: spansOfLines(lines) });
    lines = [];
  };
  const endList = (): void => {
    if (items.length > 0) blocks.push({ kind: "list", items });
    items = [];
  };

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/[ \t]+$/, "");
    if (line === "") {
      endParagraph();
      endList();
    } else if (/^#{1,3} /.test(line)) {
      // One heading size, reached by one, two or three hashes: "# Heading" is what most
      // people type, and it showed its hash as text.
      endParagraph();
      endList();
      blocks.push({ kind: "heading", spans: spansOf(line.replace(/^#{1,3} /, "")) });
    } else if (line.startsWith("- ")) {
      endParagraph();
      items.push(spansOf(line.slice(2)));
    } else {
      endList();
      lines.push(line);
    }
  }
  endParagraph();
  endList();
  return blocks;
}
