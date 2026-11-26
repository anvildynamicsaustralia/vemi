import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acceptInvite, asksForCode, AuthError, claim, finishSignOut, googleStart, invite, invitePerson, invites, linkEmail, linkHolder, me, newRecoveryCode,
  people, post, recover, removePerson, resetPersonLink, signIn, withdrawPerson,
  signOut, signOutPending, twoStepOff, twoStepSetup, twoStepVerify, UNREACHABLE, withdrawInvite,
} from "./auth.js";

function answer(status: number, body: unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
}

afterEach(() => vi.unstubAllGlobals());

describe("the calls to the Worker", () => {
  it("posts JSON, and throws the Worker's own sentence when it refuses", async () => {
    answer(429, { error: "Too many tries. Wait a while." });
    await expect(signIn("a@b.example", "pw")).rejects.toThrow("Too many tries. Wait a while.");
    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/auth/sign-in");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.example", password: "pw" });
  });

  it("says what went wrong in a sentence when the body is not JSON, status text or not", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502, statusText: "Bad Gateway" })));
    await expect(post("/auth/anything")).rejects.toThrow("Something went wrong (502). Try again.");
    // Over HTTP/2 there is no status text at all.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(invites()).rejects.toThrow("Something went wrong (500). Try again.");
  });

  it("says the Worker could not be reached, not the browser's own words", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(signIn("a@b.example", "pw")).rejects.toThrow(UNREACHABLE);
    await expect(invites()).rejects.toMatchObject({ status: 0, message: UNREACHABLE });
    // Asked straight after every sign-in, so a connection dropped there says the same.
    await expect(me({ patient: false })).rejects.toMatchObject({ status: 0, message: UNREACHABLE });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(me()).rejects.toMatchObject({ status: 500, message: "Something went wrong (500). Try again." });
  });

  it("carries the Worker's status and code, so a page tells refusals apart without reading the sentence", async () => {
    answer(400, { error: "That link has expired or was already used. Ask for a new one.", code: "link" });
    await expect(post("/auth/reset", {})).rejects.toMatchObject({ status: 400, code: "link" });
    answer(401, { error: "That email and password don't match." });
    const refused = await signIn("a@b.example", "pw").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AuthError);
    expect(refused).toMatchObject({ status: 401, code: null });
  });

  it("asks whose a mailed link is without spending it", async () => {
    answer(200, { email: "a@b.example" });
    expect(await linkEmail("invite", "tok")).toBe("a@b.example");
    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/auth/link");
    expect(JSON.parse(init.body as string)).toEqual({ token: "tok", purpose: "invite" });
  });

  it("sends the token and the new password to the invite page's route", async () => {
    answer(200, { signedIn: true });
    await acceptInvite("tok", "a long enough password");
    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/auth/invite/accept");
    expect(JSON.parse(init.body as string)).toEqual({ token: "tok", password: "a long enough password" });
  });

  it("asks who is signed in with patience, or without it after a sign-in already made", async () => {
    vi.useFakeTimers();
    try {
      const slow = (): Promise<Response> => new Promise((resolve) => {
        setTimeout(() => resolve(new Response(JSON.stringify({ signedIn: true, googleReady: false, email: "a@b.example" }))), 10_000);
      });
      vi.stubGlobal("fetch", vi.fn(slow));
      const patient = me();
      const waiting = me({ patient: false });
      const refused = expect(patient).rejects.toThrow("slow");
      await vi.advanceTimersByTimeAsync(10_000);
      await refused;
      expect((await waiting).email).toBe("a@b.example");
    } finally {
      vi.useRealTimers();
    }
  });

  it("withdraws a waiting invite by its address", async () => {
    answer(200, { ok: true });
    await withdrawInvite("a@b.example");
    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/auth/invite/withdraw");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.example" });
    answer(404, { error: "No invite is waiting for that address." });
    await expect(withdrawInvite("a@b.example")).rejects.toThrow("No invite is waiting for that address.");
  });

  it("claims the owner account with an email and a password", async () => {
    answer(200, { signedIn: true });
    await claim("a@b.example", "a long enough password");
    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/auth/claim");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.example", password: "a long enough password" });
  });

  it("gives back the link the Worker made for an invite", async () => {
    answer(200, { ok: true, link: "https://vemi.example/invite#tok" });
    expect(await invite("a@b.example")).toBe("https://vemi.example/invite#tok");
    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/auth/invite");
    expect(JSON.parse(init.body as string)).toEqual({ email: "a@b.example" });
  });

  it("lists the pending invites, and throws on a refusal", async () => {
    answer(200, { invites: [{ email: "a@b.example", expiresAt: "2026-10-22T00:00:00Z" }] });
    expect(await invites()).toEqual([{ email: "a@b.example", expiresAt: "2026-10-22T00:00:00Z" }]);
    answer(403, { error: "Only the operator can invite." });
    await expect(invites()).rejects.toThrow("Only the operator can invite.");
  });

  it("reads a first-name invite as a name, and a mailed link as an address", async () => {
    answer(200, { firstName: "Sam" });
    expect(await linkHolder("invite", "tok")).toEqual({ firstName: "Sam" });
    answer(200, { email: "a@b.example" });
    expect(await linkHolder("reset", "tok")).toEqual({ email: "a@b.example" });
  });

  it("accepts a first-name invite with the address the person types", async () => {
    answer(200, { signedIn: true });
    await acceptInvite("tok", "a long enough password", "sam@b.example");
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ token: "tok", password: "a long enough password", email: "sam@b.example" });
  });

  it("makes an invite from a first name and lists people", async () => {
    answer(200, { ok: true, link: "https://vemi.example/invite#tok" });
    expect(await invitePerson("Sam")).toBe("https://vemi.example/invite#tok");
    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/auth/people/invite");
    expect(JSON.parse(init.body as string)).toEqual({ firstName: "Sam" });
    answer(200, { people: [{ id: "a", firstName: "Sam", email: "s@b.example", deleteOn: null }], invites: [] });
    expect((await people()).people).toHaveLength(1);
    answer(403, { error: "Only the owner can do this." });
    await expect(people()).rejects.toThrow("Only the owner can do this.");
  });

  it("removes, resets and withdraws by id", async () => {
    answer(200, { ok: true, deleteOn: "2026-11-26T00:00:00Z" });
    expect(await removePerson("a")).toBe("2026-11-26T00:00:00Z");
    answer(200, { ok: true, link: "https://vemi.example/reset#tok" });
    expect(await resetPersonLink("a")).toBe("https://vemi.example/reset#tok");
    answer(200, { ok: true });
    await withdrawPerson("i1");
    const [path, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/auth/people/withdraw");
    expect(JSON.parse(init.body as string)).toEqual({ id: "i1" });
  });

  it("leaves for the address Google start returns, carrying the invite token", async () => {
    answer(200, { url: "https://accounts.google.example/auth?x=1" });
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    await googleStart("invite", "tok");
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ intent: "invite", token: "tok" });
    expect(assign).toHaveBeenCalledWith("https://accounts.google.example/auth?x=1");
  });
});

describe("a sign-out with no connection", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const offline = (): void => {
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
  };

  it("is kept, and sent once there is a connection", async () => {
    values.clear();
    offline();
    expect(await signOut()).toBe(false);
    expect(signOutPending()).toBe(true);
    expect(await finishSignOut()).toBe(false);

    answer(200, { ok: true });
    vi.stubGlobal("localStorage", storage);
    expect(await finishSignOut()).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/auth/sign-out");
    expect(signOutPending()).toBe(false);
  });

  it("asks nothing of the Worker when none is waiting", async () => {
    values.clear();
    offline();
    expect(await finishSignOut()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is sent before a sign-in, then let go", async () => {
    values.clear();
    offline();
    await signOut();
    answer(200, { signedIn: true });
    vi.stubGlobal("localStorage", storage);
    await signIn("a@b.example", "pw");
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual(["/auth/sign-out", "/auth/sign-in"]);
    expect(signOutPending()).toBe(false);
  });

  it("is let go by a sign-in the Worker took, even when it still did not hear the sign-out", async () => {
    values.clear();
    offline();
    await signOut();
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path === "/auth/sign-out"
      ? new Response("{}", { status: 503 })
      : new Response(JSON.stringify({ signedIn: true }), { status: 200 })));
    await signIn("a@b.example", "pw");
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual(["/auth/sign-out", "/auth/sign-in"]);
    expect(signOutPending()).toBe(false);
  });

  it("is not invented by a sign-in when none is waiting", async () => {
    values.clear();
    answer(200, { signedIn: true });
    vi.stubGlobal("localStorage", storage);
    await signIn("a@b.example", "pw");
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual(["/auth/sign-in"]);
  });
});

describe("2-step, the recovery code and the code step", () => {
  const sent = (): { path: string; body: unknown } => {
    const [path, init] = vi.mocked(fetch).mock.calls.at(-1) as [string, RequestInit];
    return { path, body: JSON.parse(init.body as string) };
  };

  it("sends the code at sign-in only when there is one, and reads the code step by its code", async () => {
    answer(200, { signedIn: true });
    await signIn("a@b.example", "pw", "123456");
    expect(sent().body).toEqual({ email: "a@b.example", password: "pw", code: "123456" });
    answer(401, { error: "Enter the code from your authenticator app.", code: "two-step" });
    const asked = await signIn("a@b.example", "pw").catch((e: unknown) => e);
    expect(asksForCode(asked)).toBe(true);
    expect(asksForCode(new AuthError(401, "That email and password don't match."))).toBe(false);
    expect(asksForCode(new Error("plain"))).toBe(false);
  });

  it("hands back the recovery code a sign-up or a recovery returns, once", async () => {
    answer(200, { signedIn: true, recoveryCode: "AAAA-BBBB" });
    expect(await claim("a@b.example", "a long enough password")).toBe("AAAA-BBBB");
    expect(await acceptInvite("tok", "a long enough password")).toBe("AAAA-BBBB");
    expect(await recover("a@b.example", "CCCC-DDDD", "a long enough password")).toBe("AAAA-BBBB");
    expect(sent()).toEqual({ path: "/auth/recover", body: { email: "a@b.example", recoveryCode: "CCCC-DDDD", password: "a long enough password" } });
    answer(200, { signedIn: true });
    expect(await claim("a@b.example", "a long enough password")).toBe("");
  });

  it("sets up 2-step, turns it on with a code and returns the backup codes", async () => {
    answer(200, { secret: "JBSWY3DP", uri: "otpauth://totp/VEMI:a@b.example?secret=JBSWY3DP" });
    expect(await twoStepSetup()).toEqual({ secret: "JBSWY3DP", uri: "otpauth://totp/VEMI:a@b.example?secret=JBSWY3DP" });
    expect(sent().path).toBe("/auth/two-step/setup");
    answer(200, { ok: true, backupCodes: ["a1", "b2"] });
    expect(await twoStepVerify("123456")).toEqual(["a1", "b2"]);
    expect(sent()).toEqual({ path: "/auth/two-step/verify", body: { code: "123456" } });
  });

  it("asks for the password to turn 2-step off and to make a new recovery code", async () => {
    answer(200, { ok: true });
    await twoStepOff("pw");
    expect(sent()).toEqual({ path: "/auth/two-step/off", body: { password: "pw" } });
    answer(200, { recoveryCode: "EEEE-FFFF" });
    expect(await newRecoveryCode("pw")).toBe("EEEE-FFFF");
    expect(sent()).toEqual({ path: "/auth/recovery/new", body: { password: "pw" } });
    answer(403, { error: "That isn't your password." });
    await expect(twoStepOff("nope")).rejects.toThrow("That isn't your password.");
  });
});
