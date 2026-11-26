/**
 * Reminders on this device: whether the browser can show them, asking its permission, and
 * keeping the subscription in step with the Worker.
 *
 * The browser is passed in (`PushBrowser`) and so is the Worker (`PushCalls`), so each case,
 * an iPhone outside the home screen app, a refused permission, a Worker that will not keep
 * the subscription, is tested without either. `browserNow()` and `callsNow` are the real
 * ones. Nothing here keeps a copy of the key or the subscription: the browser holds the
 * subscription and the Worker holds the key.
 */
import { pushForget, pushKey, pushSave } from "./api.js";

/** What a person is told about this device. */
export type DeviceState = "on" | "off" | "denied" | "install" | "unsupported";

/** The part of a browser's `PushSubscription` this module uses. */
export interface Subscribed {
  readonly endpoint: string;
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

export interface PushBrowser {
  readonly ua: string;
  /** Running as the installed app (the home screen on an iPhone). */
  readonly standalone: boolean;
  /** The browser has service workers, push and notifications. */
  readonly supported: boolean;
  readonly zone: string;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  current(): Promise<Subscribed | null>;
  subscribe(key: Uint8Array): Promise<Subscribed>;
}

export interface PushCalls {
  key(): Promise<string>;
  subscribe(body: Readonly<Record<string, unknown>>): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
}

const isIphone = (ua: string): boolean => /iPhone|iPad|iPod/.test(ua);

/** A name the person will know the device by, from what the browser says it is. */
export function deviceLabel(ua: string): string {
  if (isIphone(ua)) return /iPad/.test(ua) ? "iPad" : "iPhone";
  const system = /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac"
    : /Linux|X11/.test(ua) ? "Linux"
    : null;
  const app = /Edg\//.test(ua) ? "Edge"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : null;
  if (app !== null && system !== null) return `${app} on ${system}`;
  return app ?? system ?? "This device";
}

/** The public key as the browser wants it: base64url to bytes. */
export function keyBytes(key: string): Uint8Array {
  const padded = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function deviceState(b: PushBrowser): Promise<DeviceState> {
  // An iPhone only offers push to the home screen app, and says nothing about it elsewhere.
  if (isIphone(b.ua) && !b.standalone) return "install";
  if (!b.supported) return "unsupported";
  if (b.permission() === "denied") return "denied";
  if (b.permission() !== "granted") return "off";
  return (await b.current()) === null ? "off" : "on";
}

/**
 * Asks permission, then subscribes and tells the Worker. The question comes first and
 * straight away, as the browser only asks on the tap that wanted it.
 */
export async function turnOn(b: PushBrowser, calls: PushCalls): Promise<DeviceState> {
  const answer = await b.requestPermission();
  if (answer === "denied") return "denied";
  if (answer !== "granted") return "off";
  const subscribed = await b.subscribe(keyBytes(await calls.key()));
  try {
    const { endpoint, keys } = subscribed.toJSON() as { endpoint: string; keys: unknown };
    await calls.subscribe({ endpoint, keys, label: deviceLabel(b.ua), tz: b.zone });
  } catch (e) {
    // A subscription the Worker does not know would never be sent to; do not keep it.
    await subscribed.unsubscribe().catch(() => false);
    throw e;
  }
  return "on";
}

export async function turnOff(b: PushBrowser, calls: PushCalls): Promise<void> {
  const subscribed = await b.current();
  if (subscribed === null) return;
  await calls.unsubscribe(subscribed.endpoint);
  await subscribed.unsubscribe();
}

/** This browser, for real. */
export function browserNow(): PushBrowser {
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const registration = () => navigator.serviceWorker.ready;
  return {
    ua: navigator.userAgent,
    standalone: (navigator as { standalone?: boolean }).standalone === true
      || window.matchMedia("(display-mode: standalone)").matches,
    supported,
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    current: async () => (await registration()).pushManager.getSubscription(),
    subscribe: async (key) => (await registration()).pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key as BufferSource,
    }),
  };
}

/** The Worker, for real. */
export const callsNow: PushCalls = {
  key: pushKey,
  subscribe: pushSave,
  unsubscribe: pushForget,
};
