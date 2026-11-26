import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UPDATE_DOCS } from "../../shared/releaseKey.js";
import { KEY_LIST_LINK } from "../../shared/setup/getFlow.js";
import { updateSettingsApi, type UpdateSettings } from "../updateApi.js";
import { AccountUpdateView } from "./AccountUpdate.js";

const UNTIL = "2026-12-08T11:00:00.000Z";
const base: UpdateSettings = { goBack: null, backed: null, keyKept: true };

const draw = (settings: UpdateSettings, over: Partial<Parameters<typeof AccountUpdateView>[0]> = {}): string =>
  renderToStaticMarkup(
    <AccountUpdateView settings={settings} said={null} problem={null} busy={false} asking={false} word=""
      onBack={() => undefined} onAsk={() => undefined} onWord={() => undefined} onOff={() => undefined} {...over} />,
  );

describe("Go back", () => {
  it("shows the old version, the day it lasts to and a button, inside the window", () => {
    const out = draw({ ...base, goBack: { version: "0.1.0", until: UNTIL, restorePoint: null } });
    expect(out).toContain("Go back to 0.1.0");
    expect(out).toContain("Until ");
    expect(out).toContain(">Go back<");
    expect(out).not.toContain("Restore point");
  });

  it("shows the restore point, the docs link and the plain note when the update ran a migration", () => {
    const out = draw({ ...base, goBack: { version: "0.1.0", until: UNTIL, restorePoint: "00000042-bookmark" } });
    expect(out).toContain("Restore point");
    expect(out).toContain("00000042-bookmark");
    expect(out).toContain(`href="${UPDATE_DOCS}"`);
    expect(out).toContain("Data changes are not undone.");
  });

  it("is gone with no window: no row and no button", () => {
    const out = draw(base);
    expect(out).not.toContain("Go back");
  });

  it("reads Back on the old version once used, with no button", () => {
    const out = draw({ ...base, backed: "0.1.0" });
    expect(out).toContain("Back on 0.1.0");
    expect(out).not.toContain(">Go back<");
  });
});

describe("Update myself", () => {
  it("reads On with a way to turn it off", () => {
    const out = draw(base);
    expect(out).toContain("Update myself");
    expect(out).toContain(">On<");
    expect(out).toContain(">Turn off<");
  });

  it("asks for the word off, and the button waits for it", () => {
    const empty = draw(base, { asking: true });
    expect(empty).toContain('placeholder="off"');
    expect(empty).toMatch(/<button type="submit"[^>]*disabled/);
    const typed = draw(base, { asking: true, word: "off" });
    expect(typed).not.toMatch(/<button type="submit"[^>]*disabled/);
  });

  it("reads Off with no way to turn it on, and says what is left to do with the token page link", () => {
    const out = draw({ ...base, keyKept: false }, { said: "Key removed from this copy. Remove it in Cloudflare too." });
    expect(out).toContain(">Off<");
    expect(out).not.toContain("Turn off");
    expect(out).not.toContain(">On<");
    expect(out).toContain("Key removed from this copy. Remove it in Cloudflare too.");
    expect(out).toContain(`href="${KEY_LIST_LINK.replace(/&/g, "&amp;")}"`);
  });

  it("holds no em-dash", () => {
    expect(draw({ goBack: { version: "0.1.0", until: UNTIL, restorePoint: "bm" }, backed: "0.1.0", keyKept: true }, { asking: true })).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("updateSettingsApi", () => {
  it("reads what the Worker says and sends the typed word with Off", async () => {
    const seen: string[] = [];
    const api = updateSettingsApi((async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method} ${url} ${typeof init?.body === "string" ? init.body : ""}`.trim());
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ goBack: { version: "0.1.0", until: UNTIL, restorePoint: null }, backed: null, keyKept: true }));
      }
      return new Response(JSON.stringify(url.endsWith("/off") ? { said: "Key removed from this copy. Remove it in Cloudflare too." } : { version: "0.1.0" }));
    }) as unknown as typeof fetch);
    expect(await api.read()).toEqual({ goBack: { version: "0.1.0", until: UNTIL, restorePoint: null }, backed: null, keyKept: true });
    expect(await api.goBack()).toBe("0.1.0");
    expect(await api.turnOff()).toBe("Key removed from this copy. Remove it in Cloudflare too.");
    expect(seen).toEqual(["GET /api/update", "POST /api/update/back {}", 'POST /api/update/off {"confirm":"off"}']);
  });

  it("carries the Worker's sentence when it refuses", async () => {
    const api = updateSettingsApi((async () => new Response(JSON.stringify({ error: "The seven days for going back have passed." }), { status: 409 })) as unknown as typeof fetch);
    await expect(api.goBack()).rejects.toThrow("The seven days for going back have passed.");
  });
});
