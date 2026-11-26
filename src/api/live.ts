/**
 * Live updates. One Durable Object per owner, holding that owner's open WebSockets.
 *
 * Hibernation keeps an idle socket free: the object sleeps between messages, and a ping
 * is answered by the runtime without waking it. It never touches the database. A change
 * message names what changed and carries no record, so it cannot disagree with D1; a
 * client that hears one refetches.
 */
import { DurableObject } from "cloudflare:workers";

export class Live extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Called over RPC after a write commits. */
  publish(message: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A socket that is closing drops the message. Its client refetches on reconnect.
      }
    }
  }

  override async webSocketMessage(): Promise<void> {
    // Clients have nothing to say beyond "ping", which the auto-response answers.
  }

  override async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed by the runtime.
    }
  }
}
