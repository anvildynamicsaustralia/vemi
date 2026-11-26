import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");

/** The detail screens read as a few groups, with every name the tests and the e2e specs look for kept. */
describe("the detail screens", () => {
  const task = read("./TaskDetail.tsx");

  it("group a task into Status, Body, Details, Checklist and Links under its h2 title", () => {
    expect(task).toContain('<h2 className="detail-title"');
    for (const title of ["Status", "Body", "Details", "Checklist", "Links"]) expect(task).toContain(`<Group title="${title}"`);
  });

  it("keeps the body's class and every control's name", () => {
    expect(task).toContain('className="detail-body"');
    for (const name of ['label="due"', 'aria-label="remove step"', 'aria-label="archive link"', ">Unblock<", ">Block<", "Put on today"]) {
      expect(task).toContain(name);
    }
  });

  it("gives the project's stage and the space's identity a card, and the account's sections one", () => {
    expect(read("./ProjectHead.tsx")).toContain('<Group title="Stage"');
    expect(read("./SpaceSettings.tsx")).toContain('<Group title="Identity"');
    expect(read("./Account.tsx")).toContain('<section className="group" aria-labelledby="account-panel-title">');
  });

  it("states a status in a word as well as a dot in Update, Reminders, Encryption and App lock", () => {
    for (const file of ["./AccountUpdate.tsx", "./AccountReminders.tsx", "./AccountEncryption.tsx", "./AppLock.tsx"]) {
      expect(read(file), file).toMatch(/<Status(Word)?[ >]/);
    }
  });

  it("has one h1 on the account and an h2 for the open section", () => {
    const account = read("./Account.tsx");
    expect(account.match(/<h1 /g)).toHaveLength(1);
    expect(account).toContain('<h2 className="account-panel-title"');
  });
});
