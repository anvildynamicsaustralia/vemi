import { useMemo } from "react";
import type { Today, Tree } from "@vemi/shared";
import { paths } from "../api.js";
import { shortDate } from "../format.js";
import { useResource } from "../state/resources.js";
import { indexTree, needsYou } from "../treeIndex.js";
import { useApp } from "./appContext.js";

/**
 * What is late or stuck, beside Today on a desk. Overdue and blocked only: the tool never
 * picks your work, and this is the one list it keeps without being asked.
 */
export function NeedsYou() {
  const app = useApp();
  const tree = useResource<Tree>(paths.tree);
  const today = useResource<Today>(paths.today);
  const rows = useMemo(
    () => (tree.data === null ? [] : needsYou(indexTree(tree.data), today.data)),
    [tree.data, today.data],
  );

  return (
    <aside className="needs" aria-label="needs you">
      <div className="kicker">Needs you</div>
      <p className="needs-said">Late or stuck, and nothing else. The tool never picks your work.</p>
      {rows.map(({ kind, task, venture }) => (
        <button key={`${kind}:${task.id}`} type="button" className="needs-row" onClick={() => app.openTask(task.id)}>
          <span className="needs-top">
            <span className={kind === "blocked" ? "tag-blocked" : "needs-overdue"}>{kind}</span>
            <span className="needs-where">{venture.name}</span>
          </span>
          <span className="needs-title" dir="auto">{task.title}</span>
          <span className="needs-reason">
            {kind === "blocked"
              ? task.blocker?.reason
              : task.dueOn === null ? "" : `Was due ${shortDate(task.dueOn, app.today)}. Still here.`}
          </span>
        </button>
      ))}
      {tree.data !== null && rows.length === 0 && <div className="needs-said">Nothing needs you.</div>}
    </aside>
  );
}
