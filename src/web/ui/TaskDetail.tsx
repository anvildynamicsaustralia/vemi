import { useEffect, useMemo, useRef, useState } from "react";
import { PRIORITIES, type Link, type Tree } from "@vemi/shared";
import { api, createOnce, paths } from "../api.js";
import { checklistCount } from "../checklistCount.js";
import { keyed, movedTo, stored, type KeyedStep } from "../checklistSteps.js";
import { shortDate } from "../format.js";
import { taskRequest } from "../newTask.js";
import { navigate, taskPage } from "../router.js";
import { worthSendingAgain } from "../sendAgain.js";
import { useResource, type Resource } from "../state/resources.js";
import { firstOfKind, indexTree, orderedStates, stateOf, type Located, type TreeIndex } from "../treeIndex.js";
import { useLevelWords } from "../levelNames.js";
import { RemindRepeat } from "./TaskOptions.js";
import { useApp } from "./appContext.js";
import { AddLine, EditableText, Pending, StateDot, trapTab, useFocusReturn } from "./controls.js";
import { Chip } from "./Chip.js";
import { Group, Kv } from "./Group.js";
import { LockableText } from "./LockableText.js";
import { MarkdownField } from "./MarkdownField.js";
import { MoreMenu } from "./Menu.js";
import { OrderedRows } from "./OrderedRows.js";
import { DatePick, Pick } from "./Picker.js";
import type { Outcome } from "../outcome.js";
import { inOrder, pathOf } from "../projectNest.js";
import { ventureMove } from "../ventureMove.js";
import { Tags } from "./TagPicker.js";
import { PriorityMark } from "./TaskMarks.js";

/**
 * A task's sheet, from the right (VEMI-006): the trail, the title, its state as the venture's
 * own chips, what it is blocked by, when it is due, and whether it is on today. Under a
 * hairline, everything else a task has — priority, where it sits, its steps and
 * links — because the sheet is what was asked for, and hiding it again behind a second press
 * would only move the density somewhere harder to reach.
 */
export function TaskDetail({ taskId, onClose }: { readonly taskId: string; readonly onClose: () => void }) {
  const tree = useResource<Tree>(paths.tree);
  const links = useResource<Link[]>(paths.list("links", { task: taskId }));
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);
  const located = index?.tasks.get(taskId) ?? null;
  useFocusReturn();
  const words = useLevelWords();

  return (
    <aside className="detail" role="dialog" aria-label={words.task.toLowerCase()} onKeyDown={trapTab}>
      <div className="detail-head">
        <span className="detail-trail">
          {located === null ? words.task : `${located.venture.name}${located.project === null ? "" : ` · ${located.project.name}`}`}
        </span>
        {located !== null && (
          <button type="button" className="row-action open-page" title={`open this ${words.task.toLowerCase()} as a page of its own`}
            onClick={() => navigate(taskPage(located.venture.id, taskId))}>Open as page</button>
        )}
        <button type="button" className="close-button" aria-label="close" autoFocus onClick={onClose}>×</button>
      </div>
      {index === null ? <Pending error={tree.error} onRetry={tree.refetch} />
        : located === null ? <p className="rows-empty">This {words.task.toLowerCase()} is archived or does not exist. The archive can restore it.</p>
        : <TaskBody key={taskId} located={located} index={index} links={links} onClose={onClose} />}
    </aside>
  );
}

const newStepId = (): string => crypto.randomUUID();

/** A write that goes with a checklist edit as one step on the undo stack. */
interface Beside {
  first(): Promise<unknown>;
  undo(): Promise<unknown>;
  redo(): Promise<unknown>;
}

export function TaskBody({ located, index, links, onClose }: {
  readonly located: Located;
  readonly index: TreeIndex;
  readonly links: Resource<Link[]>;
  readonly onClose: () => void;
}) {
  const app = useApp();
  const words = useLevelWords();
  const { task, venture, project } = located;
  const [blocking, setBlocking] = useState(false);
  const states = orderedStates(venture);
  const current = stateOf(task, venture) ?? firstOfKind(venture, "not_started");
  const picked = app.today !== null && task.pickedOn === app.today;
  const blocker = task.blocker;

  /**
   * One change to the task, with the way back: the same fields as they are now, read before
   * the write is sent. Decision 20. It answers whether the Worker took it, for the few
   * fields that travel whole and so must be written one at a time.
   *
   * `held` is for exactly those fields. A value that travels whole is changed on screen and
   * may be changed again before the Worker answers, so `task` is a change behind and the
   * way back has to be the value the caller replaced. Any key it names wins; the rest are
   * read off `task` as before.
   */
  const change = (
    fields: Readonly<Record<string, unknown>>,
    what: string,
    held?: Readonly<Record<string, unknown>>,
  ): Promise<Outcome> => app.edit("tasks", task.id, fields, held === undefined ? task : { ...task, ...held }, `${what} on ${task.title}`);

  /**
   * Into another venture. The Worker takes its project and milestone off and finds it the
   * new venture's first state of the same kind, so the way back names all four, read
   * before the move is sent; a way back of the venture alone would bring it home with no
   * project, no milestone and maybe another column.
   */
  const moveVenture = (ventureId: string): void => {
    const { forward, back } = ventureMove(task, ventureId);
    void app.act(() => api.update("tasks", task.id, forward), {
      what: `moved ${words.space.toLowerCase()} on ${task.title}`,
      undo: () => api.update("tasks", task.id, back),
      redo: () => api.update("tasks", task.id, forward),
    });
  };

  // The checklist travels whole, so two quick edits built from the last answer would each
  // undo the other. Edits apply to what is on screen and go one after another. Each step
  // carries an id on this device only (`checklistSteps.ts`), which keys its row and is what
  // the grip moves; what is sent is the text and the tick, as it always was.
  const [items, setItems] = useState<readonly KeyedStep[]>(() => keyed([], task.checklist, newStepId));
  const sending = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (sending.current === 0) setItems((held) => keyed(held, task.checklist, newStepId));
  }, [task.checklist]);
  /**
   * `beside` is a write that goes with this one as one step: the task a step was made into.
   * It is sent first, taken back after the list is, and brought back before it.
   */
  const setChecklist = (next: readonly KeyedStep[], what: string, beside?: Beside): Promise<Outcome> => {
    // The way back is the list this edit replaces, held here rather than read again when
    // the write lands: by then `items` is already whatever the edit after it started from.
    // The chain below sends them one at a time, so each step's undo is the one before it
    // and they unwind in the order they were made. Decision 20.
    const was = stored(items);
    const now = stored(next);
    setItems(next);
    sending.current += 1;
    const run = chain.current.then(() => app.act(async () => {
      await beside?.first();
      try {
        return await api.update("tasks", task.id, { checklist: now });
      } catch (err) {
        // Refused: no step goes on the stack, so what was sent beside it is taken back now,
        // the way Undo would. Unanswered, it stays for the second go `act` offers.
        if (beside !== undefined && !worthSendingAgain(err)) await beside.undo();
        throw err;
      }
    }, {
      what: `${what} on ${task.title}`,
      // Each way hands back both answers, so a way back this device only keeps is said as kept.
      undo: async () => [await api.update("tasks", task.id, { checklist: was }), await beside?.undo()],
      redo: async () => [await beside?.redo(), await api.update("tasks", task.id, { checklist: now })],
    }));
    chain.current = run.finally(() => {
      sending.current -= 1;
    });
    return run;
  };
  const count = checklistCount(items);
  const setStep = (id: string, change: Partial<KeyedStep>, what: string): Promise<Outcome> =>
    setChecklist(items.map((c) => (c.id === id ? { ...c, ...change } : c)), what);

  /**
   * A step that turned out to be work of its own becomes a task: same venture, same project,
   * its text for a title, and the step leaves the list. One step on the undo stack: undo puts
   * the step back and archives the task, so nothing is deleted either way.
   */
  const promote = (step: KeyedStep): void => {
    const request = taskRequest(step.text, venture, { projectId: task.projectId });
    if (request === null) return;
    const id = crypto.randomUUID();
    // Made once: a second go after an unanswered checklist write sends only the checklist.
    let made = false;
    void setChecklist(items.filter((c) => c.id !== step.id), `made a step a ${words.task.toLowerCase()}`, {
      first: async () => {
        if (made) return;
        await api.create("tasks", { ...request, id });
        made = true;
      },
      undo: () => api.archive("tasks", id),
      redo: () => api.unarchive("tasks", id),
    }).then((ok) => {
      // A promote only kept on this device has its own notice already, and is not said over.
      if (ok === "sent") app.notify(`${step.text} is a ${words.task.toLowerCase()} of its own now.`, { undo: true });
    });
  };

  const archiveTask = async (): Promise<void> => {
    if (await app.archive("tasks", task.id, words.task.toLowerCase())) onClose();
  };

  return (
    <>
      <h2 className="detail-title" dir="auto">
        <EditableText value={task.title} placeholder="title" onSave={(title, was) => change({ title }, "renamed", { title: was })} />
      </h2>

      <div className="detail-groups">
        <Group title="Status">
          <Kv label="State">
            <div className="chips">
              {states.map((s) => (
                <Chip key={s.id} on={current?.id === s.id} aria-pressed={current?.id === s.id}
                  onClick={() => { if (current?.id !== s.id) change({ stateId: s.id }, `moved to ${s.name}`); }}>
                  <StateDot kind={s.kind} />{s.name}
                </Chip>
              ))}
            </div>
          </Kv>

          {blocker !== null ? (
            <Kv label="Blocked by">
              <div className="blocked-by">
                <EditableText value={blocker.reason} placeholder="why, in words"
                  onSave={(reason, was) => app.edit("blockers", blocker.id, { reason }, { reason: was }, `changed why ${task.title} is blocked`)} />
                <div className="blocked-meta">
                  <span>Waiting on</span>
                  <EditableText value={blocker.person} placeholder="a person, if it is one" allowEmpty
                    onSave={(person, was) => app.edit("blockers", blocker.id, { person }, { person: was }, `changed who ${task.title} waits on`)} />
                  {blocker.sinceOn !== null && <span>since {shortDate(blocker.sinceOn, app.today)}</span>}
                </div>
              </div>
              <button type="button" className="row-action" onClick={() => void app.act(() => api.archive("blockers", blocker.id), {
                what: `unblocked ${task.title}`,
                undo: () => api.unarchive("blockers", blocker.id),
                redo: () => api.archive("blockers", blocker.id),
              })}>Unblock</button>
            </Kv>
          ) : (
            <Kv label="Blocked">
              {blocking ? (
                <AddLine placeholder="what it waits on, in words" label="Block" autoFocus
                  onAdd={async (reason) => {
                    const ok = await app.act(createOnce("blockers", { taskId: task.id, reason, sinceOn: app.today }));
                    if (ok) setBlocking(false);
                    return ok;
                  }} />
              ) : (
                <>
                  <div className="more-empty">Not blocked.</div>
                  <button type="button" className="row-action" onClick={() => setBlocking(true)}>Block</button>
                </>
              )}
            </Kv>
          )}

          <Kv label="Due">
            {/* The date is the button that changes it, as in a phone's own reminders. */}
            <DatePick value={task.dueOn} label="due" className="detail-due-pick" onSave={(dueOn) => change({ dueOn }, dueOn === null ? "cleared the date" : "set the date")} />
          </Kv>

          <Kv label="Today">
            <button type="button" className={`today-toggle${picked ? " on" : ""}`} disabled={app.today === null} aria-pressed={picked}
              onClick={() => change({ pickedOn: picked ? null : app.today }, picked ? "took off today" : "put on today")}>
              {picked ? `On today: ${app.phone ? "tap" : "click"} to take it off` : "Put on today"}
            </button>
          </Kv>

          {app.today !== null && <RemindRepeat task={task} on={app.today} />}
        </Group>

        {/* Above the details, not below them: what a task actually is was the single biggest
            gap, and it cannot be the thing you scroll past the fold to reach. */}
        <Group title="Body" className="detail-body">
          <LockableText kind="tasks" id={task.id} field="body" value={task.body}
            save={(body, was) => change({ body }, "edited the body", { body: was })}>
            {(editor) => (
              <MarkdownField value={editor.value} label="body"
                placeholder="What this is, in a line or two. A heading, a list or a link if it helps."
                onSave={editor.onSave} />
            )}
          </LockableText>
        </Group>

        <Group title="Details">
          {/* Each mark beside its word, the way a state chip carries its dot: the board's
              card has room for the mark alone, and this is where the mark is read. */}
          <Kv label="Priority">
            <div className="chips">
              {PRIORITIES.map((p) => (
                <Chip key={p} on={task.priority === p} aria-pressed={task.priority === p}
                  onClick={() => change({ priority: task.priority === p ? null : p }, task.priority === p ? "cleared the priority" : `set ${p} priority`)}>
                  {/* Silent: the chip's own text is the word, and a mark that named it too
                      would have the row announce "high priority high". */}
                  <PriorityMark priority={p} silent />{p}
                </Chip>
              ))}
            </div>
          </Kv>
          <Kv label={words.project}>
            <Pick label={words.project.toLowerCase()} value={task.projectId ?? ""}
              onPick={(id) => change({ projectId: id === "" ? null : id, milestoneId: null }, `moved ${words.project.toLowerCase()}`)}
              options={[{ id: "", name: `No ${words.project.toLowerCase()}` }, ...inOrder(venture.projects).map((p) => ({ id: p.id, name: pathOf(p, venture.projects), nested: p.parentId !== null }))]} />
          </Kv>
          {project !== null && project.milestones.length > 0 && (
            <Kv label={words.milestone}>
              <Pick label={words.milestone.toLowerCase()} value={task.milestoneId ?? ""}
                onPick={(id) => change({ milestoneId: id === "" ? null : id }, `moved ${words.milestone.toLowerCase()}`)}
                options={[{ id: "", name: `No ${words.milestone.toLowerCase()}` }, ...project.milestones.map((m) => ({ id: m.id, name: m.name }))]} />
            </Kv>
          )}
          <Kv label={words.space}>
            <Pick label={words.space.toLowerCase()} value={venture.id} onPick={moveVenture}
              options={index.ordered.map((v) => {
                const owner = v.parentId === null ? undefined : index.ventures.get(v.parentId)?.name;
                return { id: v.id, name: v.name, nested: v.parentId !== null, ...(owner === undefined ? {} : { sub: `in ${owner}` }) };
              })} />
          </Kv>
          <Tags tagIds={task.tagIds} of="task"
            onChange={(tagIds, was) => change({ tagIds }, "changed the tags", { tagIds: was })} />
        </Group>

        <Group title="Checklist" actions={count.said !== "" ? <span className="column-count">{count.said}</span> : undefined}>
          <OrderedRows items={items} className="check" label={(item) => item.text}
            move={(id, to) => void setChecklist(movedTo(items, id, to), "moved a step")}
            row={(item, grip) => (
              <>
                {grip}
                <button type="button" className={`tick${item.done ? " done" : ""}`} aria-pressed={item.done}
                  aria-label={item.done ? `${item.text}: not done` : `${item.text}: done`}
                  onClick={() => void setStep(item.id, { done: !item.done }, item.done ? "unticked a step" : "ticked a step")}>
                  {item.done ? "✓" : ""}
                </button>
                {/* Emptied is not an edit: removing a step is the ×, which says what it does. */}
                <EditableText value={item.text} placeholder="a step" className={`text${item.done ? " done" : ""}`}
                  onSave={(text) => setStep(item.id, { text }, "renamed a step")} />
                <MoreMenu label={`step ${item.text}`} items={[{ label: `Make it a ${words.task.toLowerCase()}`, run: () => promote(item) }]} />
                <button type="button" className="close-button" aria-label="remove step"
                  onClick={() => void setChecklist(items.filter((c) => c.id !== item.id), "removed a step")}>×</button>
              </>
            )} />
          <AddLine placeholder="a step" onAdd={(text) => setChecklist([...items, { id: newStepId(), text, done: false }], "added a step")}
            onAddMany={(lines) => setChecklist([...items, ...lines.map((text) => ({ id: newStepId(), text, done: false }))], `added ${lines.length} steps`)
              .then((ok) => { if (ok === "sent") app.notify(`Added ${lines.length} steps, one a line.`, { undo: true }); })} />
        </Group>

        <Group title="Links">
          {(links.data ?? []).map((l) => (
            <div key={l.id} className="more-line note-line">
              <a className="fill" href={l.url} target="_blank" rel="noreferrer noopener">{l.label ?? l.url}</a>
              <button type="button" className="close-button" aria-label="archive link" onClick={() => void app.archive("links", l.id, "link")}>×</button>
            </div>
          ))}
          <AddLine placeholder="a link" onAdd={(url) => {
            // A link is an address: no spaces, and a dot in its domain. Anything else was saved as
            // "https://words like these", a link that goes nowhere.
            if (/\s/.test(url.trim()) || !/\.[a-z]{2,}/i.test(url)) {
              app.notify("That does not look like a web address. Try one like example.com/page.");
              return Promise.resolve(false);
            }
            return app.act(createOnce("links", { taskId: task.id, url }));
          }} />
        </Group>

        <div className="more-foot">
          <button type="button" className="row-action" onClick={() => void archiveTask()}>Archive {words.task.toLowerCase()}</button>
        </div>
      </div>
    </>
  );
}
