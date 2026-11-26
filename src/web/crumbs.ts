import { HOME, venture, type Route, type Tab } from "./router.js";

/** One step of where-am-I. A step with no route is the page itself. */
export interface Crumb {
  readonly label: string;
  readonly to: Route | null;
}

const SURFACE_NAMES = { map: "Map", today: "Today", add: "Add", search: "Search", archive: "Archive", account: "Account", review: "Weekly review" } as const;

/**
 * Where the person is, from what the app already knows: the route and the names it has read.
 * A page of a space reads Map, the space, then the board or project or task; every other
 * surface is its own name. Pure. A space's name not yet known (the tree still loading) is
 * left out rather than guessed.
 */
export function crumbsFor(
  route: Pick<Route, "surface" | "ventureId" | "tab" | "itemId">,
  ventureName: string | null,
  itemName: string | null,
  tabLabels: Record<Tab, string>,
): readonly Crumb[] {
  if (route.surface !== "venture" && route.surface !== "project" && route.surface !== "task") {
    return [{ label: SURFACE_NAMES[route.surface], to: null }];
  }
  const trail: Crumb[] = [{ label: "Map", to: HOME }];
  const id = route.ventureId;
  const tab = route.tab ?? "board";
  if (id === null) return trail;
  if (ventureName !== null) trail.push({ label: ventureName, to: route.surface === "venture" ? null : venture(id, tab) });
  if (route.surface === "venture") {
    trail.push({ label: tabLabels[tab], to: null });
  } else {
    trail.push({ label: itemName ?? (route.surface === "project" ? "Project" : "Task"), to: null });
  }
  return trail;
}
