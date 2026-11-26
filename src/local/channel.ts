/**
 * How a change in one open page reaches the others. Every tab of one copy shares one
 * database, so a write in one tab posts what changed here and the others hear it.
 *
 * `BroadcastChannel` reaches other tabs of the same origin only; it never leaves the device.
 */
import type { Change } from "@vemi/shared";

export interface LocalChannel {
  /** Tell every other open page what changed. */
  post(change: Change): void;
  /** Hear changes other pages post. Answers the way to stop hearing. */
  listen(onChange: (change: Change) => void): () => void;
  close(): void;
}

export const CHANNEL_NAME = "vemi-local";

export function createChannel(name: string = CHANNEL_NAME): LocalChannel {
  const channel = new BroadcastChannel(name);
  return {
    post: (change) => channel.postMessage(change),
    listen: (onChange) => {
      const listener = (event: MessageEvent<Change>): void => onChange(event.data);
      channel.addEventListener("message", listener);
      return () => channel.removeEventListener("message", listener);
    },
    close: () => channel.close(),
  };
}
