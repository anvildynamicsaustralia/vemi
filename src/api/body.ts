/**
 * Reading a request body with a ceiling, so no route holds more than it was built to take.
 * A length header over the limit refuses before a byte is read, and a body that lies about
 * its length is cut off as soon as it runs past the limit.
 */

export type Capped = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly response: Response };

const tooBig = (message: string): Capped => ({
  ok: false,
  response: new Response(JSON.stringify({ error: message }), {
    status: 413,
    headers: { "content-type": "application/json; charset=utf-8" },
  }),
});

/** The body as text, or a 413 when it runs past `limit` bytes. A false length header does not help. */
export async function capBody(request: Request, limit: number, message = "That is too big to take in one go."): Promise<Capped> {
  const header = request.headers.get("content-length");
  if (header !== null && Number(header) > limit) return tooBig(message);
  if (request.body === null) return { ok: true, text: "" };

  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return tooBig(message);
    }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}
