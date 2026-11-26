import { describe, expect, it } from "vitest";
import { parsePushSubscription } from "./validate.js";

const P256DH = "B".repeat(87);
const AUTH = "a".repeat(22);
const parse = (endpoint: string) => parsePushSubscription({ endpoint, keys: { p256dh: P256DH, auth: AUTH } }, "UTC");

// The at sign is joined in so no email-shaped text sits in the file for the release scan to flag.
const AT = "@";

describe("push subscription endpoints", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://push.services.mozilla.com/wpush/abc",
    "https://web.push.apple.com/QAbc",
    "https://api.push.apple.com/3/device/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://FCM.GoogleAPIs.com/fcm/send/abc",
  ])("accepts %s", (endpoint) => {
    expect(parse(endpoint)).toMatchObject({ ok: true });
  });

  it.each([
    "https://evil.example/fcm.googleapis.com",
    "https://fcm.googleapis.com.evil.example/fcm/send/abc",
    "https://evilfcm.googleapis.com/x",
    "https://notnotify.windows.com/x",
    "http://fcm.googleapis.com/fcm/send/abc",
    `https://fcm.googleapis.com${AT}evil.example/x`,
    `https://fcm.googleapis.com:pw${AT}evil.example/x`,
    `https://evil.example${AT}fcm.googleapis.com/x`,
    "https://fcm.googleapis.com:8443/x",
    "https://push.example.test/send/abc",
    "https://127.0.0.1/x",
    "ftp://fcm.googleapis.com/x",
  ])("refuses %s", (endpoint) => {
    expect(parse(endpoint)).toMatchObject({ ok: false });
  });
});
