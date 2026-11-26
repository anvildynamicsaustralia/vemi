import { STAGE_KINDS, STATE_KINDS, type Stage, type StageKind, type StateKind, type TreeVenture } from "@vemi/shared";
import { api, createOnce } from "../api.js";
import type { Placed } from "../order.js";
import { byPosition, nextPosition, orderedStates } from "../treeIndex.js";
import { useApp } from "./appContext.js";
import { AddLine, EditableText, StateDot } from "./controls.js";
import { OrderedRows } from "./OrderedRows.js";
import { Pick } from "./Picker.js";

const STAGE_WORDS: Record<StageKind, string> = { early: "early", active: "active", paused: "paused", shipped: "shipped", stopped: "stopped" };

const STATE_WORDS: Record<StateKind, string> = { not_started: "not started", underway: "underway", finished: "finished" };

/** The venture's states in board order: named, kinded (the kind is the colour), ordered, added to, archived. */
export function StatesSection({ venture, moveIn }: {
  readonly venture: TreeVenture;
  readonly moveIn: (kind: "states", items: readonly Placed[], what: string) => (id: string, to: number) => void;
}) {
  const app = useApp();
  const states = orderedStates(venture);
  return (
    <section className="about-block">
      <h3 className="kicker more-kicker">States, in board order</h3>
      <OrderedRows items={states} className="more-row" label={(s) => s.name} move={moveIn("states", states, "the state")}
        row={(s, grip) => (
          <div className="more-line">
            {grip}
            <StateDot kind={s.kind} />
            <EditableText value={s.name} placeholder="name" onSave={(name, was) => app.edit("states", s.id, { name }, { name: was }, `renamed the state ${s.name}`)} />
            <Pick label="kind of state" value={s.kind} className="pick-inline" width={220}
              options={STATE_KINDS.map((k) => ({ id: k, name: STATE_WORDS[k] }))}
              onPick={(kind) => void app.edit("states", s.id, { kind }, s, `changed the kind of ${s.name}`)} />
            <button type="button" className="close-button" aria-label="archive state"
              onClick={() => void app.archive("states", s.id, "state")}>×</button>
          </div>
        )} />
      <AddLine placeholder="a new state" label="Add state"
        onAdd={(name) => app.act(createOnce("states", { ventureId: venture.id, name, kind: "underway", position: nextPosition(states) }))} />
    </section>
  );
}

/** A venture's stages in its own order. */
function orderedStages(venture: TreeVenture): Stage[] {
  return [...venture.stages].sort(byPosition);
}

/**
 * Where a venture or a project is in its life, picked from the venture's own stages and cleared
 * with "No stage". Set by hand; nothing moves it. The way back is the stage it replaced.
 */
export function StagePick({ kind, id, name, stageId, venture }: {
  readonly kind: "ventures" | "projects";
  readonly id: string;
  readonly name: string;
  readonly stageId: string | null;
  readonly venture: TreeVenture;
}) {
  const app = useApp();
  const stages = orderedStages(venture);
  const pick = (picked: string): void => {
    const next = picked === "" ? null : picked;
    const was = stageId;
    if (next === was) return;
    void app.act(() => api.update(kind, id, { stageId: next }), {
      what: `changed the stage of ${name}`,
      undo: () => api.update(kind, id, { stageId: was }),
      redo: () => api.update(kind, id, { stageId: next }),
    });
  };
  return (
    <Pick label="lifecycle stage" value={stageId ?? ""} placeholder="No stage" className="pick-inline" width={220}
      options={[{ id: "", name: "No stage" }, ...stages.map((s) => ({ id: s.id, name: s.name, sub: STAGE_WORDS[s.kind] }))]}
      onPick={pick} />
  );
}

/** The venture's lifecycle, edited the way its states are: named, kinded, ordered, added to, archived. */
export function LifecycleSection({ venture, moveIn }: {
  readonly venture: TreeVenture;
  readonly moveIn: (kind: "stages", items: readonly Placed[], what: string) => (id: string, to: number) => void;
}) {
  const app = useApp();
  const stages = orderedStages(venture);
  return (
    <section className="about-block">
      <h3 className="kicker more-kicker">Lifecycle, in order</h3>
      <OrderedRows items={stages} className="more-row" label={(s) => s.name} move={moveIn("stages", stages, "the stage")}
        row={(s, grip) => (
          <div className="more-line">
            {grip}
            <EditableText value={s.name} placeholder="name" onSave={(name, was) => app.edit("stages", s.id, { name }, { name: was }, `renamed the stage ${s.name}`)} />
            <Pick label="kind of stage" value={s.kind} className="pick-inline" width={220}
              options={STAGE_KINDS.map((k) => ({ id: k, name: STAGE_WORDS[k] }))}
              onPick={(kind) => void app.edit("stages", s.id, { kind }, s, `changed the kind of ${s.name}`)} />
            <button type="button" className="close-button" aria-label="archive stage"
              onClick={() => void app.archive("stages", s.id, "stage")}>×</button>
          </div>
        )} />
      <AddLine placeholder="a new stage" label="Add stage"
        onAdd={(name) => app.act(createOnce("stages", { ventureId: venture.id, name, kind: "active", position: nextPosition(stages) }))} />
    </section>
  );
}
