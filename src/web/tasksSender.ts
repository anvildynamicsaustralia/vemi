import { api } from "./api.js";
import type { AppActions } from "./ui/appContext.js";

/**
 * What `makeTasks` sends through: the app's own `act` and notice, and the Worker's create
 * and archive.
 */
export const tasksSender = (app: Pick<AppActions, "act" | "notify">) => ({
  act: app.act,
  create: api.create,
  archive: api.archive,
  unarchive: api.unarchive,
  newId: () => crypto.randomUUID(),
  say: (message: string) => app.notify(message),
});
