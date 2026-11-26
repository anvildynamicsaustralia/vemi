import { describe, expect, it } from "vitest";
import { fromBase64Url, makeVapidKey, toBase64Url } from "./vapid.js";
import { encryptAes128gcm, sendPush, vapidAuthorization } from "./webPush.js";

const text = (s: string) => new TextEncoder().encode(s);

// RFC 8291 Appendix A.
const A = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const NOW = new Date("2026-11-18T01:00:00Z");
const payload = { kind: "test", title: "VEMI", body: "Reminders work here", tag: "test" } as const;

async function device() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, jwk, p256dh: toBase64Url(raw), auth: toBase64Url(auth) };
}

describe("RFC 8291 aes128gcm", () => {
  it("matches Appendix A byte for byte", async () => {
    const body = await encryptAes128gcm(text(A.plaintext), fromBase64Url(A.uaPublic), fromBase64Url(A.authSecret), {
      salt: fromBase64Url(A.salt),
      publicKey: fromBase64Url(A.asPublic),
      privateKey: A.asPrivate,
    });
    expect(toBase64Url(body)).toBe(A.body);
  });
});

describe("vapidAuthorization", () => {
  it("signs a token for the push service, at most 12 hours out", async () => {
    const key = await makeVapidKey();
    const header = await vapidAuthorization("https://push.example.net/send/abc", { ...key, subject: "https://vemi.example.org" }, NOW);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(m![2]!)));
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(m![1]!)))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(claims.aud).toBe("https://push.example.net");
    expect(claims.sub).toBe("https://vemi.example.org");
    const lead = claims.exp - NOW.getTime() / 1000;
    expect(lead).toBeGreaterThan(0);
    expect(lead).toBeLessThanOrEqual(12 * 3600);
    expect(m![4]).toBe(key.publicKey);
    const verify = await crypto.subtle.importKey(
      "raw",
      fromBase64Url(key.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verify, fromBase64Url(m![3]!), text(`${m![1]}.${m![2]}`));
    expect(ok).toBe(true);
  });
});

describe("sendPush", () => {
  it("posts a message the device can read, and says sent", async () => {
    const d = await device();
    const key = await makeVapidKey();
    let seen: { url: string; init: RequestInit } | undefined;
    const post = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const result = await sendPush({ endpoint: "https://push.example.net/send/abc", p256dh: d.p256dh, auth: d.auth }, payload, { ...key, subject: "https://vemi.example.org" }, NOW, post);
    expect(result).toEqual({ kind: "sent" });
    expect(seen!.url).toBe("https://push.example.net/send/abc");
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers["Authorization"]).toMatch(/^vapid t=/);
    expect(headers["TTL"]).toBeDefined();

    // Decrypt as the device would (RFC 8291 section 3.4).
    const body = seen!.init.body as Uint8Array;
    const salt = body.slice(0, 16);
    const idLen = body[20]!;
    const asPublic = body.slice(21, 21 + idLen);
    const cipher = body.slice(21 + idLen);
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const priv = await crypto.subtle.importKey("jwk", d.jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, priv, 256);
    const uaPublic = fromBase64Url(d.p256dh);
    const info = new Uint8Array([...text("WebPush: info\0"), ...uaPublic, ...asPublic]);
    const hk = async (ikm: ArrayBuffer | Uint8Array, s: Uint8Array, i: Uint8Array, bits: number) =>
      crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info: i }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), bits);
    const ikm = await hk(shared, fromBase64Url(d.auth), info, 256);
    const cek = await hk(ikm, salt, text("Content-Encoding: aes128gcm\0"), 128);
    const nonce = await hk(ikm, salt, text("Content-Encoding: nonce\0"), 96);
    const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, cipher));
    expect(plain[plain.length - 1]).toBe(2);
    expect(JSON.parse(new TextDecoder().decode(plain.slice(0, -1)))).toEqual(payload);
  });

  it("says gone for 404 and 410, failed with the status for others, failed for a throw", async () => {
    const d = await device();
    const key = await makeVapidKey();
    const vapid = { ...key, subject: "https://vemi.example.org" };
    const sub = { endpoint: "https://push.example.net/send/abc", p256dh: d.p256dh, auth: d.auth };
    const answer = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
    expect(await sendPush(sub, payload, vapid, NOW, answer(404))).toEqual({ kind: "gone" });
    expect(await sendPush(sub, payload, vapid, NOW, answer(410))).toEqual({ kind: "gone" });
    expect(await sendPush(sub, payload, vapid, NOW, answer(429))).toEqual({ kind: "failed", status: 429 });
    expect(await sendPush(sub, payload, vapid, NOW, answer(500))).toEqual({ kind: "failed", status: 500 });
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await sendPush(sub, payload, vapid, NOW, boom)).toEqual({ kind: "failed", status: null });
  });

  it("gives the push service a deadline and follows no redirect, so a slow or hostile address cannot hold the tick", async () => {
    const d = await device();
    const key = await makeVapidKey();
    const vapid = { ...key, subject: "https://vemi.example.org" };
    const sub = { endpoint: "https://push.example.net/send/abc", p256dh: d.p256dh, auth: d.auth };
    let seen: RequestInit | undefined;
    const spy = (async (_url: string, init: RequestInit) => {
      seen = init;
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    expect(await sendPush(sub, payload, vapid, NOW, spy)).toEqual({ kind: "sent" });
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.redirect).toBe("error");
    // An address that never answers is let go once the deadline passes.
    const hang = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const hung = sendPush(sub, payload, vapid, NOW, hang, 20);
    expect(await hung).toEqual({ kind: "failed", status: null });
  });
});
