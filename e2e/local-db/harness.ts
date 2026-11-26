/**
 * A bare page that runs the pieces of local mode and nothing else: the leader, the bridge and the
 * channel, with a list drawn from the real API. `e2e/local.spec.ts` builds and drives it in a real
 * browser. It is a test fixture, not part of the app.
 */
import { installBridge } from "../../src/local/bridge.js";
import { createChannel } from "../../src/local/channel.js";
import { openBrowserLeader } from "../../src/local/leader.js";

const leader = openBrowserLeader();
installBridge({ origin: location.origin, send: (wire) => leader.send(wire) });
const channel = createChannel();

const state = document.getElementById("state") as HTMLElement;
const list = document.getElementById("list") as HTMLElement;
const form = document.getElementById("add") as HTMLFormElement;
const input = document.getElementById("title") as HTMLInputElement;

interface Row { id: string; title: string; venture_id: string }

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function draw(): Promise<void> {
  const exported = (await (await call("GET", "/api/export")).json()) as { tables: { task: Row[] } };
  list.replaceChildren(
    ...exported.tables.task.map((task) => {
      const item = document.createElement("li");
      item.dataset.task = task.id;
      item.textContent = task.title;
      return item;
    }),
  );
}

async function space(): Promise<string> {
  const exported = (await (await call("GET", "/api/export")).json()) as { tables: { venture: { id: string }[] } };
  const first = exported.tables.venture[0];
  if (first !== undefined) return first.id;
  const made = (await (await call("POST", "/api/ventures", { name: "Farm", description: "" })).json()) as { id: string };
  return made.id;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = input.value.trim();
  if (title === "") return;
  input.value = "";
  void (async () => {
    const ventureId = await space();
    await call("POST", "/api/tasks", { ventureId, title });
    await draw();
  })();
});

// A change another tab made reaches this one through the channel, with no reload.
channel.listen(() => void draw());

leader.onStatus((status) => {
  state.textContent = `${status.role} ${status.volatile === null ? "unknown" : status.volatile ? "volatile" : "kept"}`;
});

void draw().then(() => {
  document.body.dataset.ready = "yes";
});
