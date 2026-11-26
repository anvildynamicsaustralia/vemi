/**
 * A venture's projects read as parents and their children. Pure: lists in, lists out.
 *
 * One level at most. The Worker decides what may nest; `homesFor` is the client's copy of that
 * rule, for the picker only.
 */
import type { Project } from "@vemi/shared";
import { byPosition } from "./treeIndex.js";

type Nestable = Pick<Project, "id" | "ventureId" | "name" | "parentId" | "position" | "createdAt">;

export interface Nested<P extends Nestable> {
  readonly project: P;
  readonly children: readonly P[];
}

/**
 * Top-level projects in position order, each with its children in position order. A child whose
 * parent is not in the list (hidden, or in another venture) is treated as top-level, so it never
 * vanishes.
 */
export function nested<P extends Nestable>(projects: readonly P[]): Nested<P>[] {
  const ids = new Set(projects.map((p) => p.id));
  const kids = new Map<string, P[]>();
  const top: P[] = [];
  for (const project of [...projects].sort(byPosition)) {
    if (project.parentId !== null && project.parentId !== project.id && ids.has(project.parentId)) {
      const list = kids.get(project.parentId) ?? [];
      list.push(project);
      kids.set(project.parentId, list);
    } else {
      top.push(project);
    }
  }
  return top.map((project) => ({ project, children: kids.get(project.id) ?? [] }));
}

/** Each parent followed by its children: the order for chips, pickers and board columns. */
export const inOrder = <P extends Nestable>(projects: readonly P[]): P[] =>
  nested(projects).flatMap((n) => [n.project, ...n.children]);

/** "Parent › Child" for a child, the name alone for a top-level project. */
export function pathOf(project: Nestable, projects: readonly Nestable[]): string {
  const parent = project.parentId === null ? undefined : projects.find((p) => p.id === project.parentId);
  return parent ? `${parent.name} › ${project.name}` : project.name;
}

/**
 * The projects this one may go inside: top-level, same venture, not itself. Empty when it holds
 * any project.
 */
export function homesFor<P extends Nestable>(project: Nestable, projects: readonly P[]): P[] {
  if (projects.some((p) => p.parentId === project.id)) return [];
  return inOrder(projects).filter(
    (p) => p.id !== project.id && p.parentId === null && p.ventureId === project.ventureId,
  );
}
