import type { ReactNode } from "react";
import "./projectPage.css";

/**
 * The two columns of a project's page (VEMI-013, project phase, mock 3): the Brief, milestones
 * and notes in the wide one, the Next step and its neighbours in the narrow one. The stylesheet
 * stacks them on a phone, main first.
 */
export function ProjectColumns({ main, side }: { readonly main: ReactNode; readonly side: ReactNode }) {
  return (
    <div className="pj">
      <div className="pjmain">{main}</div>
      <div className="pjside">{side}</div>
    </div>
  );
}
