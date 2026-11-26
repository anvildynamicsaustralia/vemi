/**
 * What the page and the database worker say to each other. Kept apart from the worker so a
 * page that only talks to it (`leader.ts`) does not pull the worker's imports, the API and
 * its Cloudflare types, into the web project's type check.
 */
import type { WireRequest, WireResponse } from "./bridge.js";

export type WorkerIn =
  | { type: "open" }
  | { type: "request"; id: number; wire: WireRequest }
  | { type: "close" };

export type WorkerOut =
  | { type: "ready"; volatile: boolean }
  | { type: "answer"; id: number; wire: WireResponse }
  | { type: "failed"; id: number; message: string }
  | { type: "closed" }
  | { type: "broken"; message: string };
