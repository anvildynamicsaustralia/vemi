/**
 * What the phone's share sheet hands VEMI: the installed app is a share target (a GET to
 * `/add` with `title`, `text` and `url`), and Add opens carrying it. The shared title is the
 * task's title, else the first line of the shared text; the body is the link, then whatever
 * other text came with it. Nothing is read twice: the params are removed from the address as
 * soon as Add has taken them.
 */
import { TASK_TITLE_MAX } from "@vemi/shared";

/** The title and the body a share becomes. */
export interface Shared {
  readonly title: string;
  readonly body: string;
}

const PARAMS = ["title", "text", "url"] as const;
const BODY_MAX = 20_000;

/** The share a query string carries, or null when it carries none. */
export function shareParams(search: string): Shared | null {
  const q = new URLSearchParams(search);
  const title = (q.get("title") ?? "").trim();
  const text = (q.get("text") ?? "").trim();
  const url = (q.get("url") ?? "").trim();
  const lines = text.split(/\r?\n/);
  const first = (lines[0] ?? "").trim();
  const rest = lines.slice(1).join("\n").trim();

  let heading = title;
  let more = text;
  if (heading === "" && first !== "") {
    heading = first;
    more = rest;
  }
  if (heading === "" && url !== "") return { title: url.slice(0, TASK_TITLE_MAX), body: "" };
  if (heading === "") return null;
  const body = [url, more].filter((part) => part !== "").join("\n\n");
  return { title: heading.slice(0, TASK_TITLE_MAX), body: body.slice(0, BODY_MAX) };
}

/** The query string with the share params taken out, `?` included when anything is left. */
export function withoutShared(search: string): string {
  const q = new URLSearchParams(search);
  for (const name of PARAMS) q.delete(name);
  const rest = q.toString();
  return rest === "" ? "" : `?${rest}`;
}

/** A share arrives at the Add path. */
export const isShareAddress = (pathname: string): boolean => pathname === "/add";
