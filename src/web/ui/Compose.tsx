import { useEffect, useMemo, useRef, useState } from "react";
import { PRIORITIES, type Priority, type Tag, type Tree } from "@vemi/shared";
import { draftKeeper } from "../addDraft.js";
import { api, createOnce, paths } from "../api.js";
import { longDate } from "../format.js";
import { addDays, localToday, weekEnd } from "../monthGrid.js";
import { addedTo, makeTask, offersTags } from "../newTask.js";
import { navigate, surface, venture as ventureRoute } from "../router.js";
import { useLevelWords } from "../levelNames.js";
import { useResource } from "../state/resources.js";
import { tagIndex } from "../tagIndex.js";
import { indexTree, orderedStates } from "../treeIndex.js";
import { homeVentureId, rememberVenture, useApp, useNewTaskVenture, type ComposeSeed } from "./appContext.js";
import { isShareAddress, shareParams, withoutShared, type Shared } from "../shareParams.js";
import { SurfaceKicker } from "./Chrome.js";
import { SmartChips } from "./SmartChips.js";
import { useSmartTitle } from "./useSmartTitle.js";
import { Chip } from "./Chip.js";
import { MoreMenu } from "./Menu.js";
import { AddLine, Pending, StateDot } from "./controls.js";
import { MonthGrid } from "./Picker.js";
import { inOrder, pathOf } from "../projectNest.js";

/** What was typed or carried here and not yet made, kept for the next time Add opens. */
const draft = draftKeeper();

/**
 * What the share sheet handed over, read as the page loaded, before anything rewrites the
 * address. Held until Add has mounted and spent it, so the signed-out screen or a slow first
 * load in between cannot lose it.
 */
let arrived: Shared | null = typeof window === "undefined" || !isShareAddress(window.location.pathname)
  ? null
  : shareParams(window.location.search);

const arrivedShare = (): Shared | null => arrived;

/** Done with the share: forget it, and take its params out of the address. */
function spendShare(): void {
  arrived = null;
  if (!isShareAddress(window.location.pathname)) return;
  const rest = withoutShared(window.location.search);
  if (rest !== window.location.search) window.history.replaceState(null, "", `${window.location.pathname}${rest}`);
}

type When ="today" | "tomorrow" | "week" | "date";

const WHENS: readonly { readonly id: When; readonly label: string }[] = [
  { id: "today", label: "Today" },
  { id: "tomorrow", label: "Tomorrow" },
  { id: "week", label: "This week" },
  { id: "date", label: "Pick a date" },
];

/**
 * Add: one column, a title and a venture, and everything else a chip away (VEMI-006). A task
 * needs a title and a venture and nothing else, ever, so nothing below the venture is chosen
 * for you: Today is picked only when Add was opened from Today.
 *
 * When maps onto what a task already has. Today puts it on today. Tomorrow, This week and a
 * picked date give it a due date — the day, or the Sunday that ends this week. Submitting
 * lands on the venture's Today if it went on today, and on its Board if not.
 *
 * A seed is a pre-fill, and every pre-filled chip can be changed or taken off before the task
 * is made: a column's state, a project row's project, a column's priority or tag. The task
 * is made the one way every add makes one (`newTask.ts`).
 */
export function Compose({ seed, onClose }: { readonly seed: ComposeSeed; readonly onClose: () => void }) {
  const app = useApp();
  const words = useLevelWords();
  const tree = useResource<Tree>(paths.tree);
  const tags = useResource<Tag[]>(paths.list("tags"));
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);
  const [shared] = useState(arrivedShare);
  const [opened] = useState(() => draft.open(seed.title ?? shared?.title));
  const body = seed.body ?? shared?.body ?? "";
  // The share is taken once; the address stops carrying it, so a reload does not add it again.
  useEffect(() => { spendShare(); }, []);
  useNewTaskVenture();
  // The typed text, read for a date, a repeat and a time: the task is made from the title
  // left over, and the chips say what was read.
  const smart = useSmartTitle(opened, (text) => draft.keep(text));
  const title = smart.title;
  const [chosen, setChosen] = useState<string | null>(seed.ventureId ?? null);
  const [when, setWhen] = useState<When | null>(seed.onToday === true ? "today" : null);
  const [day, setDay] = useState<string | null>(null);
  const [stateId, setStateId] = useState<string | null>(seed.stateId ?? null);
  const [projectId, setProjectId] = useState<string | null>(seed.projectId ?? null);
  const [priority, setPriority] = useState<Priority | null>(seed.priority ?? null);
  const [tagIds, setTagIds] = useState<readonly string[]>(seed.tagIds ?? []);
  // Decided once, as Add opens: taking the pre-filled tag off must not make the group it
  // sits in vanish under the person's hand.
  const [tagsOffered] = useState(() => offersTags(seed));
  const [saving, setSaving] = useState(false);
  // The task this draft makes, named once. Add pressed again after a failure, or the
  // notice's Try again, sends the same id, so a first try that did land is still one task.
  // A draft changed since — another title, venture or pick — is another task, and another id.
  const named = useRef<{ readonly draft: string; readonly id: string } | null>(null);

  const today = app.today ?? localToday();
  const venture = index === null ? null
    : index.ventures.get(chosen ?? "") ?? index.ventures.get(homeVentureId() ?? "") ?? index.ordered[0] ?? null;
  const project = venture?.projects.find((p) => p.id === projectId) ?? null;
  const states = venture === null ? [] : orderedStates(venture);
  // Tags span ventures, so these are every tag there is, and a venture change keeps them.
  const tagChips = useMemo(() => tagIndex(tags.data ?? [], [], "").unchosen, [tags.data]);

  // A When chip the person chose wins over a date read from the title.
  const chosenDue = when === "tomorrow" ? addDays(today, 1) : when === "week" ? weekEnd(today) : when === "date" ? day : null;
  const dueOn = when === null ? smart.picked.dueOn : chosenDue;
  const summary = when === "today" ? "Goes on today"
    : when === "tomorrow" ? "Due tomorrow"
    : dueOn !== null ? `Due ${longDate(dueOn, today)}`
    : "";
  const ready = title.trim() !== "" && venture !== null && !saving && (when !== "date" || day !== null);

  const save = async (): Promise<void> => {
    if (!ready || venture === null) return;
    setSaving(true);
    const picked = { stateId, projectId, priority, tagIds, dueOn, pickedOn: when === "today" ? today : null, remindAt: smart.picked.remindAt, repeat: smart.picked.repeat, body };
    const said = JSON.stringify([title.trim(), venture.id, picked]);
    if (named.current?.draft !== said) named.current = { draft: said, id: crypto.randomUUID() };
    const ok = await makeTask({ act: (work) => app.act(work), create: api.create }, title, venture, picked, named.current.id);
    setSaving(false);
    if (!ok) return;
    named.current = null;
    draft.made();
    rememberVenture(venture.id);
    // Kept on this device, the notice already says so; "Added" over it would say it landed.
    if (ok === "sent") app.notify(addedTo(venture.name, project?.name ?? null));
    navigate(when === "today" ? surface("today") : ventureRoute(venture.id, "board"), { replace: true });
  };

  const pickWhen = (id: When): void => setWhen(when === id ? null : id);
  const pickVenture = (id: string): void => {
    if (id === venture?.id) return;
    // A state and a project are a venture's own, so neither survives a move to another.
    setChosen(id);
    setStateId(null);
    setProjectId(null);
  };

  return (
    <div className="add">
      <SurfaceKicker menu={<MoreMenu label="add" items={app.phoneMenu} />}>Add</SurfaceKicker>
      <input className="big-field" dir="auto" autoFocus value={smart.text} placeholder="What needs doing?" aria-label="title"
        onChange={(e) => smart.setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />
      <SmartChips chips={smart.chips} onRestore={smart.restore} />

      {index === null && tree.error !== null ? (
        <Pending error={tree.error} onRetry={tree.refetch} />
      ) : index !== null && index.ordered.length === 0 ? (
        <div className="add-groups">
          <p className="rows-empty">No {words.spaces.toLowerCase()}.</p>
          <AddLine placeholder={`name the first ${words.space.toLowerCase()}`} label={`Add ${words.space.toLowerCase()}`} onAdd={(name) => app.act(createOnce("ventures", { name }))} />
        </div>
      ) : (
        <div className="add-groups">
          <div>
            <div className="kicker add-label">{words.space}</div>
            <div className="chips" role="radiogroup" aria-label={words.space.toLowerCase()}>
              {(index?.ordered ?? []).map((v) => (
                <Chip key={v.id} role="radio" aria-checked={venture?.id === v.id}
                  on={venture?.id === v.id}
                  onClick={() => pickVenture(v.id)}>
                  {v.name}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <div className="kicker add-label">When</div>
            <div className="chips seg" role="radiogroup" aria-label="when">
              {WHENS.map((w) => (
                <Chip key={w.id} role="radio" aria-checked={when === w.id}
                  on={when === w.id} onClick={() => pickWhen(w.id)}>
                  {w.label}
                </Chip>
              ))}
            </div>
            {when === "date" && <MonthGrid value={day} today={today} onPick={setDay} />}
          </div>

          {/* Unpicked, the task has no state, and sits where it always has: the first
              not-started column. */}
          {states.length > 0 && (
            <div>
              <div className="kicker add-label">State</div>
              <div className="chips seg" role="radiogroup" aria-label="state">
                {states.map((s) => (
                  <Chip key={s.id} role="radio" aria-checked={stateId === s.id}
                    on={stateId === s.id}
                    onClick={() => setStateId(stateId === s.id ? null : s.id)}>
                    <StateDot kind={s.kind} />{s.name}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {venture !== null && venture.projects.length > 0 && (
            <div>
              <div className="kicker add-label">{words.project}</div>
              <div className="chips" role="radiogroup" aria-label={words.project.toLowerCase()}>
                {inOrder(venture.projects).map((p) => (
                  <Chip key={p.id} role="radio" aria-checked={projectId === p.id}
                    on={projectId === p.id}
                    onClick={() => setProjectId(projectId === p.id ? null : p.id)}>
                    {pathOf(p, venture.projects)}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          <div>
            <div className="kicker add-label">Priority</div>
            <div className="chips seg" role="radiogroup" aria-label="priority">
              {PRIORITIES.map((p) => (
                <Chip key={p} role="radio" aria-checked={priority === p}
                  on={priority === p} onClick={() => setPriority(priority === p ? null : p)}>
                  {p}
                </Chip>
              ))}
            </div>
          </div>

          {/* Only when a tag was pre-filled, so an ordinary Add is not a chip for every tag
              there is. Chosen from what exists: a new tag is made on the task, where the
              picker offers the ones there are before it offers to make one. */}
          {tagsOffered && tagChips.length > 0 && (
            <div>
              <div className="kicker add-label">Tags</div>
              <div className="chips" role="group" aria-label="tags">
                {tagChips.map((t) => {
                  const on = tagIds.includes(t.id);
                  return (
                    <Chip key={t.id} aria-pressed={on} on={on}
                      onClick={() => setTagIds(on ? tagIds.filter((id) => id !== t.id) : [...tagIds, t.id])}>
                      {t.name}
                    </Chip>
                  );
                })}
              </div>
            </div>
          )}

          <div className="add-submit">
            <button type="button" className="primary-button" disabled={!ready} onClick={() => void save()}>Add {words.task.toLowerCase()}</button>
            <span className="add-summary">{summary}</span>
            <span className="fill" />
            <button type="button" className="back-link" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
