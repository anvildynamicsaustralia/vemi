/**
 * A socket that is a `BroadcastChannel`: what `connectLive` holds in local mode in place of a
 * WebSocket to the Worker. Every change another context of this copy posts (the database's own
 * worker for a write this tab made, another tab's database worker for one it made) reaches the
 * live client as a message, so the screens refetch the same way they do on the signed-in app.
 *
 * It is always open: there is no connection to lose. It answers `ping` with `pong` so the live
 * client's own keep-alive stays satisfied, and says nothing it did not hear.
 */
import type { LocalChannel } from "../../local/channel.js";
import type { SocketLike } from "../state/live.js";

/** Runs `work` after the caller has had the chance to set its handlers. */
export type Defer = (work: () => void) => void;

export function channelSocket(channel: LocalChannel, defer: Defer = queueMicrotask): SocketLike {
  let closed = false;
  let stop: (() => void) | null = null;
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (closed || data !== "ping") return;
      defer(() => { if (!closed) socket.onmessage?.({ data: "pong" }); });
    },
    close() {
      if (closed) return;
      closed = true;
      stop?.();
      channel.close();
    },
  };
  const hear = channel.listen.bind(channel);
  stop = hear((change) => {
    if (!closed) socket.onmessage?.({ data: JSON.stringify(change) });
  });
  defer(() => { if (!closed) socket.onopen?.({}); });
  return socket;
}
