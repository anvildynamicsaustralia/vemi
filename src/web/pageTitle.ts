/**
 * What the browser tab says. Pure: where you are in, a title out.
 *
 * A surface of a venture says the venture's name first, because that is what the page is
 * about and a narrow tab shows only the start; then which of its surfaces. Everything
 * else names the surface.
 */
import type { Route } from "./router.js";

/**
 * The sign-in card's tab: the name alone, as index.html has it before anything is drawn.
 * Every surface names its own tab, so a card that named none kept the last
 * one: "Map · VEMI" after Sign out.
 */
export const SIGN_IN_TITLE = "VEMI";

const TAB_NAMES = { board: "Board", projects: "Projects" } as const;
const SURFACE_NAMES = { map: "Map", today: "Today", add: "Add", search: "Search", archive: "Archive", account: "Account", review: "Weekly review" } as const;

export function titleFor(route: Pick<Route, "surface" | "tab">, ventureName: string | null, itemName: string | null = null): string {
  // A project's or a task's page is about that thing first, then the venture it is in.
  if (route.surface === "project" || route.surface === "task") {
    const what = itemName ?? (route.surface === "project" ? "Project" : "Task");
    return ventureName === null ? `${what} · VEMI` : `${what} · ${ventureName} · VEMI`;
  }
  if (route.surface === "venture") {
    const tab = TAB_NAMES[route.tab ?? "board"];
    return ventureName === null ? `${tab} · VEMI` : `${ventureName} · ${tab} · VEMI`;
  }
  return `${SURFACE_NAMES[route.surface]} · VEMI`;
}
