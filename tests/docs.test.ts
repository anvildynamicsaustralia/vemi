import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_DOCS } from "../src/shared/releaseKey.js";
import { levelWords } from "../src/web/levelWords.js";
import { shortcutRows } from "../src/web/shortcutRows.js";
import { ROOT } from "./walk.js";

/**
 * The pages in docs/ that explain using VEMI. Each claim a page makes about a screen is
 * checked against the words the screen uses, read from the code or the source text.
 */

const EM_DASH = String.fromCharCode(0x2014);
const COPY = ["try-it.md", "updating.md", "self-hosting.md", "releasing.md"] as const;
const USING = ["getting-started.md", "reminders.md", "connect-your-ai.md", "keyboard.md", "backups.md", "faq.md"] as const;

const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
const page = (name: string): string => (existsSync(join(ROOT, "docs", name)) ? read(`docs/${name}`) : "");
const flat = (text: string): string => text.replace(/\s+/g, " ").toLowerCase();
const before = (text: string, a: string, b: string): boolean => {
  const at = text.toLowerCase().indexOf(a.toLowerCase());
  const bt = text.toLowerCase().indexOf(b.toLowerCase());
  return at >= 0 && bt > at;
};

describe("the pages for using VEMI", () => {
  it("exist, each is linked from the index, and each starts with one heading", () => {
    expect(existsSync(join(ROOT, "docs", "index.md"))).toBe(true);
    const index = page("index.md");
    for (const name of USING) {
      expect(existsSync(join(ROOT, "docs", name)), name).toBe(true);
      expect(index, `index links ${name}`).toContain(`(${name})`);
      const body = page(name);
      const lines = body.split(/\r?\n/);
      expect(lines.find((l) => l.trim() !== "")?.startsWith("# "), `${name} opens with a heading`).toBe(true);
      expect(lines.filter((l) => /^# /.test(l)).length, `${name} has one top heading`).toBe(1);
    }
  });

  it("use no em-dash and no word of the old vocabulary", () => {
    for (const name of ["index.md", ...USING, ...COPY]) {
      const body = page(name);
      expect(body.includes(EM_DASH), `${name} em-dash`).toBe(false);
      expect(/\bventures?\b/i.test(body), `${name} says the old word`).toBe(false);
    }
  });

  it("leave nothing of the old in-app pages", () => {
    expect(existsSync(join(ROOT, "src", "web", "docs"))).toBe(false);
  });
});

describe("keyboard.md", () => {
  it("carries every key and every action the shortcuts sheet shows", () => {
    const body = page("keyboard.md");
    for (const [keys, what] of shortcutRows("Ctrl", levelWords(), true)) {
      expect(body, `key ${keys}`).toContain(keys);
      expect(body, `action ${what}`).toContain(what);
    }
  });

  it("says the single keys can be switched off in Extras", () => {
    const body = flat(page("keyboard.md"));
    expect(body).toContain("single-key shortcuts");
    expect(body).toContain("extras");
    expect(body).toContain("off");
  });
});

describe("getting-started.md", () => {
  const body = page("getting-started.md");

  it("names the three ways in in order, then first run, the levels, Today and Add", () => {
    expect(before(body, "Try it now", "Get my own VEMI")).toBe(true);
    expect(before(body, "Get my own VEMI", "Deploy button")).toBe(true);
    expect(before(body, "Deploy button", "## First run")).toBe(true);
    expect(before(body, "## First run", "## The four levels")).toBe(true);
    expect(before(body, "## The four levels", "## Today")).toBe(true);
    expect(before(body, "## Today", "## Add with smart dates")).toBe(true);
  });

  it("names the four levels and says they can be renamed", () => {
    for (const word of ["Spaces", "Projects", "Milestones", "Tasks"]) expect(body).toContain(word);
    expect(flat(body)).toMatch(/rename/);
  });

  it("lists the smart date words", () => {
    for (const word of ["tomorrow", "next week", "every day", "every weekday", "every friday", "every week", "every month", "at 3pm"]) {
      expect(body, word).toContain(word);
    }
    expect(flat(body)).toContain("extras");
  });
});

describe("reminders.md", () => {
  const body = flat(page("reminders.md"));
  it("says what is true of reminders", () => {
    for (const part of ["per device", "nothing is on", "first run", "morning summary", "quiet hours", "home screen", "ios 16.4", "no email"]) {
      expect(body, part).toContain(part);
    }
  });
});

describe("connect-your-ai.md", () => {
  const raw = page("connect-your-ai.md");
  const body = flat(raw);

  it("gives the Claude and ChatGPT steps in the words the screen uses", () => {
    const screen = read("src/web/ui/AccountAi.tsx");
    for (const word of ["Connector address", "Connector settings", "Revoke", "Undo"]) {
      expect(screen, `the screen says ${word}`).toContain(word);
      expect(raw, word).toContain(word);
    }
    expect(read("src/web/ui/Connect.tsx")).toContain("It can't delete anything.");
    for (const word of ["Claude", "ChatGPT", "Allow", "Customize", "Connectors", "Add custom MCP server"]) expect(raw, word).toContain(word);
  });

  it("says what it can and cannot do", () => {
    for (const can of ["list", "search", "add", "edit", "move", "tick", "reschedule", "pick for today"]) expect(body, can).toContain(can);
    for (const cannot of ["delete", "archive", "full-account encryption"]) expect(body, cannot).toContain(cannot);
    expect(body).toContain("undo lasts 7 days");
    expect(body).toContain("refused when the item has changed since, or was already put back");
    expect(body).not.toContain("every one of them can be undone");
    expect(body).toMatch(/vemi (itself )?(makes|calls) no model/);
  });
});

describe("backups.md", () => {
  const body = flat(page("backups.md"));
  it("covers export, restore, Time Travel, account deletion and locked notes", () => {
    const data = read("src/web/ui/AccountData.tsx");
    for (const word of ["Export everything", "Choose file", "Replace everything", "Delete my account"]) {
      expect(data, word).toContain(word);
      expect(body, word).toContain(word.toLowerCase());
    }
    expect(body).toContain("press delete, type delete, then press delete my account");
    for (const part of ["preview", "time travel", "7 days", "whoever runs the copy", "cancel", "locked notes", "recovery key"]) {
      expect(body, part).toContain(part);
    }
  });
});

describe("faq.md", () => {
  const body = flat(page("faq.md"));
  it("answers the questions the other pages raise", () => {
    for (const q of ["cost", "who can see my data", "can i leave", "lose my recovery key", "why no email"]) expect(body, q).toContain(q);
  });
});

describe("the pages for getting your own copy", () => {
  it("exist, each is linked from the index, and each starts with one heading", () => {
    const index = page("index.md");
    for (const name of COPY) {
      expect(existsSync(join(ROOT, "docs", name)), name).toBe(true);
      expect(index, `index links ${name}`).toContain(`(${name})`);
      const lines = page(name).split(/\r?\n/);
      expect(lines.find((l) => l.trim() !== "")?.startsWith("# "), `${name} opens with a heading`).toBe(true);
      expect(lines.filter((l) => /^# /.test(l)).length, `${name} has one top heading`).toBe(1);
    }
  });

  it("name no key, token, address or ID", () => {
    for (const name of COPY) {
      const body = page(name);
      expect(/[0-9a-f]{32}/i.test(body), `${name} holds a long hex string`).toBe(false);
      expect(/[\w.+-]+@[\w-]+\.[\w.]+/.test(body), `${name} holds an address`).toBe(false);
      expect(/\.works/.test(body), `${name} names the plans folder`).toBe(false);
    }
  });
});

describe("try-it.md", () => {
  const raw = page("try-it.md");
  const body = flat(raw);

  it("names the controls the screens draw", () => {
    const start = read("src/web/ui/MoveStart.tsx");
    const data = read("src/web/ui/AccountData.tsx");
    for (const word of ["Move to my own cloud", "I already have a copy"]) {
      expect(start, `the screen says ${word}`).toContain(word);
      expect(raw, word).toContain(word);
    }
    for (const word of ["Move code", "Make a code"]) {
      expect(data, `the screen says ${word}`).toContain(word);
      expect(raw, word).toContain(word);
    }
    expect(read("src/web/landingLinks.ts")).toContain("Try it now");
    expect(raw).toContain("Try it now");
  });

  it("says what local mode is, what it lacks and what clearing the browser does", () => {
    for (const part of [
      "in this browser", "nothing is sent anywhere", "push reminders", "ai", "people", "between devices",
      "site data", "export", "export file", "move code", "never goes through the front door", "never goes through the relay", "locked notes", "recovery key",
    ]) {
      expect(body, part).toContain(part);
    }
  });
});

describe("updating.md", () => {
  const raw = page("updating.md");
  const body = flat(raw);

  it("names the controls the screens draw", () => {
    const row = read("src/web/ui/UpdateRow.tsx");
    const account = read("src/web/ui/AccountUpdate.tsx");
    for (const word of ["Update", "How to update"]) {
      expect(row, `the screen says ${word}`).toContain(word);
      expect(raw, word).toContain(word);
    }
    for (const word of ["Go back", "Restore point", "Restore data", "Update myself", "Turn off"]) {
      expect(account, `the screen says ${word}`).toContain(word);
      expect(raw, word).toContain(word);
    }
    expect(raw).toContain("Account");
    expect(raw).toContain("About");
  });

  it("says what an update does and does not do", () => {
    for (const part of [
      "one tap", "7 days", "never starts without", "signed", "data changes are not undone", "additive",
      "deploy button", "restore point", "time travel", "--bookmark",
    ]) {
      expect(body, part).toContain(part);
    }
  });

  it("has the section the app links to", () => {
    expect(raw).toMatch(/^## Restore data from the restore point$/m);
  });
});

describe("UPDATE_DOCS", () => {
  it("points at a page and a section that exist", () => {
    const match = /\/blob\/main\/(docs\/[\w-]+\.md)(?:#([\w-]+))?$/.exec(UPDATE_DOCS);
    expect(match, "UPDATE_DOCS is a docs page").not.toBeNull();
    const target = match?.[1] ?? "";
    expect(existsSync(join(ROOT, target)), target).toBe(true);
    const slug = (h: string): string => h.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
    const slugs = read(target).split(/\r?\n/).filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, "")));
    if (match?.[2] !== undefined) expect(slugs, `section ${match[2]}`).toContain(match[2]);
    expect(slugs).toContain("restore-data-from-the-restore-point");
  });
});

describe("self-hosting.md", () => {
  const raw = page("self-hosting.md");
  const body = flat(raw);

  it("names every variable in .dev.vars.example", () => {
    const names = [...read(".dev.vars.example").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? "");
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(raw, name).toContain(name);
  });

  it("carries the same button address as the README", () => {
    const url = /\]\((https:\/\/deploy\.workers\.cloudflare\.com\/\?url=[^)]+)\)/.exec(read("README.md"))?.[1];
    expect(url).toBeDefined();
    expect(raw).toContain(url ?? "");
  });

  it("covers the setup helper, the free plan, the front page and removing a copy", () => {
    expect(read("src/web/ui/AccountAbout.tsx")).toContain("Front page");
    for (const part of [
      "setup helper", "deploy button", "first account", "invite only", "google", "custom domain", "front page",
      "free plan", "checked against cloudflare's documentation on", "developers.cloudflare.com/workers/platform/limits",
      "measured numbers are added after production use", "remove a copy",
    ]) {
      expect(body, part).toContain(part);
    }
  });
});

describe("README.md", () => {
  const raw = read("README.md");
  const at = (needle: string): number => raw.indexOf(needle);
  const pages = readdirSync(join(ROOT, "docs")).filter((n) => n.endsWith(".md"));
  const linked = [...raw.matchAll(/\]\(docs\/([\w-]+\.md)\)/g)].map((m) => m[1] ?? "");

  it("reads in order: button, free plan, line, shots, bullets, ways in, pages, maker, licence, issues", () => {
    const order = [
      "https://deploy.workers.cloudflare.com/button",
      "Free on Cloudflare's free plan",
      "Everything you're building, in one place.",
      "docs/images/map-desk.png",
      "docs/images/today-phone.png",
      "docs/images/project-desk.png",
      "Spaces, projects, milestones and tasks",
      "Today and a calm first run",
      "Locked notes and optional full-account encryption",
      "Reminders on your own devices",
      "Your own Claude or ChatGPT can work in it",
      "Try it now",
      "Get my own VEMI",
      "Deploy button",
      "Made by Anvil Dynamics",
      "MIT",
      "Issues welcome. Pull requests are not accepted yet.",
    ];
    let last = -1;
    for (const part of order) {
      const i = at(part);
      expect(i, part).toBeGreaterThan(last);
      last = i;
    }
  });

  it("gives each screenshot alt text", () => {
    for (const shot of ["map-desk", "today-phone", "project-desk"]) {
      expect(raw, shot).toMatch(new RegExp(`!\\[[^\\]]+\\]\\(docs/images/${shot}\\.png\\)`));
      expect(existsSync(join(ROOT, "docs", "images", `${shot}.png`)), shot).toBe(true);
    }
  });

  it("links every page in docs/, and only pages the index lists", () => {
    const index = page("index.md");
    for (const name of pages) expect(linked, `README links ${name}`).toContain(name);
    for (const name of linked) {
      expect(pages, `${name} exists`).toContain(name);
      if (name !== "index.md") expect(index, `index lists ${name}`).toContain(`(${name})`);
    }
  });

  it("names none of the plans, efforts, old repo, status or checks", () => {
    expect(raw.includes(EM_DASH)).toBe(false);
    expect(/\.works|VEMI-0\d\d|vemi-legacy|status|check\.sh/i.test(raw)).toBe(false);
  });
});

describe("releasing.md", () => {
  const body = flat(page("releasing.md"));
  it("is the signing runbook", () => {
    for (const part of [
      "manifest.json", "manifest.sig", "ed25519", "release_public_key", "release_feed", "make-release-key",
      "sign-release", "offline", "bad signature", "key is lost",
    ]) {
      expect(body, part).toContain(part);
    }
    for (const script of ["make-release-key.mjs", "sign-release.mjs", "build-release.mjs"]) {
      expect(existsSync(join(ROOT, "scripts", script)), script).toBe(true);
    }
  });
});

describe("the corrected claims", () => {
  it("privacy.md states the setup key's real reach", () => {
    const body = flat(page("privacy.md"));
    for (const part of ["workers scripts edit", "d1 edit", "account settings read", "other workers and databases in the same cloudflare account are within its reach"]) {
      expect(body, part).toContain(part);
    }
    expect(body).not.toContain("and nothing more");
  });
  it("faq.md links self-hosting.md for cost, not getting-started.md", () => {
    const body = page("faq.md");
    expect(body).toContain("(self-hosting.md)");
    expect(body).not.toContain("(getting-started.md)");
  });
  it("updating.md gives the Deploy button path as concrete steps", () => {
    const body = flat(page("updating.md"));
    expect(body).toContain("sync that repository with the public vemi repository");
    expect(body).toContain("starts the next build");
  });
  it("account-phone.png sits on a page about Account, not Connect your AI", () => {
    expect(page("connect-your-ai.md")).not.toContain("account-phone.png");
    expect(page("backups.md")).toContain("images/account-phone.png");
  });
  it("the private DEPLOY.md describes no off-site dump: the copy has none, so backups are Time Travel and export", () => {
    const body = read(".works/efforts/VEMI-013_release/DEPLOY.md");
    expect(body).not.toMatch(/BACKUP_|Backblaze|\bB2\b/);
    expect(flat(body)).toContain("time travel");
  });
  it("scan-em-dash.mjs keeps its spacing", () => {
    expect(read("scripts/scan-em-dash.mjs")).toContain("const isDir = (p) =>");
  });
  it("both vocabulary scans list the root markdown files", () => {
    for (const file of ["tests/no-observation.test.ts", "tests/vocabulary.test.ts"]) {
      expect(read(file), file).toContain("publicRootDocs()");
      expect(read(file), file).not.toContain('"CONTRIBUTING.md"');
    }
  });
});

describe("troubleshooting.md", () => {
  const raw = page("troubleshooting.md");
  const body = flat(raw);

  it("exists, is linked from the index and the README, and holds no em-dash", () => {
    expect(raw.length).toBeGreaterThan(0);
    expect(page("index.md")).toContain("(troubleshooting.md)");
    expect(read("README.md")).toContain("(docs/troubleshooting.md)");
    expect(raw.includes(EM_DASH)).toBe(false);
  });

  it("covers a failed deploy, signing in, a stuck update, reminders and lost work", () => {
    for (const part of ["deploy button fails", "cannot sign in", "update is stuck", "reminders do not arrive", "your work has gone"]) {
      expect(body, part).toContain(part);
    }
  });

  it("quotes the sentences the app says", () => {
    for (const sentence of [
      "cross-origin request refused",
      "this copy already has an owner",
      "this update could not be checked, so it was not installed",
      "this copy kept no key to update itself with",
    ]) {
      expect(body, sentence).toContain(sentence);
    }
  });
});
