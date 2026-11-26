import { useMemo } from "react";
import type { Today, Tree } from "@vemi/shared";
import { paths } from "./api.js";
import { useResource } from "./state/resources.js";
import { indexTree, needsYou } from "./treeIndex.js";

/** What the badge says: the number itself up to nine, then "9+". Nothing for none. */
export function badgeText(count: number): string | null {
  return count <= 0 ? null : count > 9 ? "9+" : String(count);
}

/** What a screen reader is told of the badge. */
export function badgeSpoken(count: number): string {
  return count === 1 ? "1 needs you" : `${count} need you`;
}

/** How many tasks are late or blocked, from the same tree and today the Needs you list reads. */
export function useNeedsCount(): number {
  const tree = useResource<Tree>(paths.tree);
  const today = useResource<Today>(paths.today);
  return useMemo(
    () => (tree.data === null ? 0 : needsYou(indexTree(tree.data), today.data).length),
    [tree.data, today.data],
  );
}
