/**
 * What the project header writes (VEMI-013, project page): the arguments to `app.edit`, so a
 * pin and a stage change both reach the undo stack with the way back already in them. Pure.
 */
export interface ProjectEdit {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
  readonly what: string;
}

/** Pin it if it is not pinned, unpin it if it is. `now` is the stamp a new pin takes. */
export function pinEdit(project: { readonly name: string; readonly pinnedAt: string | null }, now: string): ProjectEdit {
  const was = project.pinnedAt;
  return {
    fields: { pinnedAt: was === null ? now : null },
    current: { pinnedAt: was },
    what: was === null ? `pinned ${project.name}` : `unpinned ${project.name}`,
  };
}

/** Set the stage, or clear it with null. Null when the stage would not change. */
export function stageEdit(project: { readonly name: string; readonly stageId: string | null }, next: string | null): ProjectEdit | null {
  if (next === project.stageId) return null;
  return { fields: { stageId: next }, current: { stageId: project.stageId }, what: `changed the stage of ${project.name}` };
}
