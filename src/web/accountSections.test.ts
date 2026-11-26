import { describe, expect, it } from "vitest";
import { openSection, SECTIONS, visibleSections } from "./accountSections.js";

const ids = (owner: boolean, privacy?: boolean): string[] => visibleSections({ owner }, privacy).map((s) => s.id);

describe("account sections", () => {
  it("lists ten in the brief's order", () => {
    expect(SECTIONS.map((s) => s.title)).toEqual([
      "Profile and sign-in", "Names", "Reminders", "Look and feel", "Extras",
      "AI", "Privacy and security", "People", "Your data", "About",
    ]);
  });

  it("shows Privacy and security to every account", () => {
    expect(ids(true)).toContain("privacy");
    expect(ids(false)).toContain("privacy");
    expect(ids(true, false)).not.toContain("privacy");
  });

  it("shows People only to the owner", () => {
    expect(ids(true)).toContain("people");
    expect(ids(false)).not.toContain("people");
    expect(ids(false)).toHaveLength(9);
  });

  it("opens the first section on a desk and the list on a phone", () => {
    const shown = visibleSections({ owner: false });
    expect(openSection(null, shown, false)).toBe("profile");
    expect(openSection(null, shown, true)).toBeNull();
    expect(openSection("about", shown, true)).toBe("about");
  });

  it("ignores a section that is not shown", () => {
    const shown = visibleSections({ owner: false });
    expect(openSection("people", shown, false)).toBe("profile");
    expect(openSection("privacy", shown, true)).toBe("privacy");
  });
});

describe("account sections in local mode", () => {
  const local = visibleSections({ owner: true }, true, true);

  it("shows these and no others, in order", () => {
    expect(local.map((s) => s.title)).toEqual([
      "Profile", "Names", "Reminders", "Look and feel", "Extras", "Privacy and security", "Your data", "About",
    ]);
  });

  it("draws no AI and no People, even for the owner", () => {
    expect(local.map((s) => s.id)).not.toContain("ai");
    expect(local.map((s) => s.id)).not.toContain("people");
  });

  it("leaves the signed-in list as it was", () => {
    expect(visibleSections({ owner: true }).map((s) => s.id)).toContain("ai");
    expect(visibleSections({ owner: true })[0]?.title).toBe("Profile and sign-in");
  });
});
