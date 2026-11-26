import { describe, expect, it } from "vitest";
import { TASK_TITLE_MAX } from "@vemi/shared";
import { ApiError } from "./api.js";
import { addLine, addedTo, columnPrefill, makeTask, makeTasks, offersTags, prefillFrom, taskRequest, todayPicked, type Home, type TaskRequest } from "./newTask.js";
import { HOME, projectPage, surface, taskPage, venture } from "./router.js";

const shop: Home = { id: "shop", states: [{ id: "shop-idea" }, { id: "shop-making" }], projects: [{ id: "site" }] };
const band: Home = { id: "band", states: [{ id: "band-idea" }], projects: [{ id: "album" }] };

describe("todayPicked", () => {
  const none = { dueOn: null, repeat: null, remindAt: null };

  it("picks for today when nothing was read", () => {
    expect(todayPicked("shop", "2026-11-17", none)).toEqual({ ventureId: "shop", pickedOn: "2026-11-17", dueOn: null, repeat: null, remindAt: null });
  });

  it("files a task with a read date for that day and does not pick it for today", () => {
    const got = todayPicked("shop", "2026-11-17", { ...none, dueOn: "2026-11-18" });
    expect(got.dueOn).toBe("2026-11-18");
    expect(got.pickedOn).toBeNull();
  });

  it("keeps a repeat with no date picked for today", () => {
    const got = todayPicked("shop", "2026-11-17", { ...none, repeat: "week:5" });
    expect(got).toMatchObject({ pickedOn: "2026-11-17", repeat: "week:5" });
  });

  it("sends the read date, repeat and time with the title read out of the text", () => {
    const request = taskRequest("call vet", shop, todayPicked("shop", "2026-11-17", { dueOn: "2026-11-18", repeat: null, remindAt: "2026-11-18T15:00" }));
    expect(request).toEqual({ ventureId: "shop", title: "call vet", dueOn: "2026-11-18", remindAt: "2026-11-18T15:00" });
  });
});

describe("taskRequest", () => {
  it("makes a task from a title and a venture alone", () => {
    expect(taskRequest("Call the printer", shop, {})).toEqual({ ventureId: "shop", title: "Call the printer" });
  });

  it("sends a milestone only when the venture knows it", () => {
    const known: Home = { ...shop, milestones: [{ id: "launch" }] };
    expect(taskRequest("Call", known, { milestoneId: "launch" })?.milestoneId).toBe("launch");
    expect(taskRequest("Call", known, { milestoneId: "other" })).toEqual({ ventureId: "shop", title: "Call" });
    expect(taskRequest("Call", shop, { milestoneId: "launch" })).toEqual({ ventureId: "shop", title: "Call" });
  });

  it("trims the title it sends", () => {
    expect(taskRequest("  Call the printer  ", shop, {})?.title).toBe("Call the printer");
  });

  it("refuses a title that is only whitespace, the way Add does", () => {
    expect(taskRequest("", shop, {})).toBeNull();
    expect(taskRequest("   \t ", shop, { stateId: "shop-making" })).toBeNull();
  });

  it("refuses a task with no venture", () => {
    expect(taskRequest("Call the printer", null, { stateId: "shop-making" })).toBeNull();
  });

  it("sends a pre-filled state as it is", () => {
    expect(taskRequest("Glaze", shop, { ventureId: "shop", stateId: "shop-making" }))
      .toEqual({ ventureId: "shop", title: "Glaze", stateId: "shop-making" });
  });

  it("sends what a person changed a pre-fill to, not the pre-fill", () => {
    const prefill = { stateId: "shop-making", priority: "low" as const };
    expect(taskRequest("Glaze", shop, { ...prefill, stateId: "shop-idea", priority: "high" }))
      .toEqual({ ventureId: "shop", title: "Glaze", stateId: "shop-idea", priority: "high" });
  });

  it("sends nothing for a pre-fill a person took away", () => {
    expect(taskRequest("Glaze", shop, { stateId: null, projectId: null, priority: null, tagIds: [] }))
      .toEqual({ ventureId: "shop", title: "Glaze" });
  });

  it("drops a state and a project that are not the venture's, when the venture was changed", () => {
    expect(taskRequest("Mix", band, { stateId: "shop-making", projectId: "site" })).toEqual({ ventureId: "band", title: "Mix" });
    expect(taskRequest("Mix", band, { stateId: "band-idea", projectId: "album" }))
      .toEqual({ ventureId: "band", title: "Mix", stateId: "band-idea", projectId: "album" });
  });

  it("keeps a pre-filled tag, and a tag given twice once", () => {
    expect(taskRequest("File the return", shop, { tagIds: ["admin"] })?.tagIds).toEqual(["admin"]);
    expect(taskRequest("File the return", shop, { tagIds: ["admin", "admin", "legal"] })?.tagIds).toEqual(["admin", "legal"]);
  });

  it("carries when: a due date, or today", () => {
    expect(taskRequest("Post", shop, { dueOn: "2026-09-27", pickedOn: null }))
      .toEqual({ ventureId: "shop", title: "Post", dueOn: "2026-09-27" });
    expect(taskRequest("Post", shop, { pickedOn: "2026-09-20" }))
      .toEqual({ ventureId: "shop", title: "Post", pickedOn: "2026-09-20" });
  });
});

describe("remindAt and repeat", () => {
  it("are sent when picked, and left out when not", () => {
    expect(taskRequest("Bins", shop, { remindAt: "2026-11-20T09:00", repeat: "week:4" }))
      .toEqual({ ventureId: "shop", title: "Bins", remindAt: "2026-11-20T09:00", repeat: "week:4" });
    expect(taskRequest("Bins", shop, { remindAt: null, repeat: null })).toEqual({ ventureId: "shop", title: "Bins" });
  });
});

describe("makeTask", () => {
  const recorder = () => {
    const sent: TaskRequest[] = [];
    return {
      sent,
      act: async (work: () => Promise<unknown>) => { await work(); return true; },
      create: async (_kind: "tasks", input: TaskRequest) => { sent.push(input); },
    };
  };

  it("sends the one request and answers that it was made", async () => {
    const send = recorder();
    expect(await makeTask(send, "Glaze", shop, { stateId: "shop-making" }, "t1")).toBe(true);
    expect(send.sent).toEqual([{ ventureId: "shop", title: "Glaze", stateId: "shop-making", id: "t1" }]);
  });

  it("names the task once, so sending the same work again is the same task", async () => {
    const sent: { readonly id: string }[] = [];
    // An act that fails the first time and is tried again, as the notice's Try again does.
    const send = {
      act: async (work: () => Promise<unknown>) => { await work(); await work(); return "sent" as const; },
      create: async (_kind: "tasks", input: TaskRequest & { readonly id: string }) => { sent.push(input); },
    };
    expect(await makeTask(send, "Glaze", shop, {})).toBe("sent");
    expect(sent).toHaveLength(2);
    expect(typeof sent[0]?.id).toBe("string");
    expect(sent[1]?.id).toBe(sent[0]?.id);
  });

  it("sends nothing for a whitespace title, and says no task was made", async () => {
    const send = recorder();
    expect(await makeTask(send, "  ", shop, { stateId: "shop-making" })).toBe(false);
    expect(send.sent).toEqual([]);
  });

  it("answers as the write did", async () => {
    const send = { act: async () => false, create: async () => undefined };
    expect(await makeTask(send, "Glaze", shop, {})).toBe(false);
  });
});

describe("columnPrefill", () => {
  it("pre-fills the column's own grouping field", () => {
    expect(columnPrefill("state", "shop-making")).toEqual({ stateId: "shop-making" });
    expect(columnPrefill("project", "site")).toEqual({ projectId: "site" });
  });

  it("pre-fills nothing from a none-column: no project is what No project means", () => {
    expect(columnPrefill("project", "")).toEqual({});
  });

  it("lands a task from each column in that column's request", () => {
    expect(taskRequest("Glaze", shop, columnPrefill("project", "site")))
      .toEqual({ ventureId: "shop", title: "Glaze", projectId: "site" });
    expect(taskRequest("Glaze", shop, columnPrefill("project", ""))).toEqual({ ventureId: "shop", title: "Glaze" });
  });
});

describe("addedTo", () => {
  it("names the project when there is one, and the venture when not", () => {
    expect(addedTo("Shop", "Site")).toBe("Added to Site");
    expect(addedTo("Shop", null)).toBe("Added to Shop");
  });
});

describe("offersTags", () => {
  it("offers no tags on an ordinary Add", () => {
    expect(offersTags({})).toBe(false);
    expect(offersTags({ ventureId: "shop", stateId: "shop-making", projectId: "site", priority: "high" })).toBe(false);
    expect(offersTags({ tagIds: [] })).toBe(false);
  });

  it("offers them when a tag was pre-filled, so it can be changed before the task is made", () => {
    expect(offersTags({ tagIds: ["admin"] })).toBe(true);
    expect(offersTags({ ventureId: "shop", tagIds: ["admin"] })).toBe(true);
  });

});

describe("prefillFrom", () => {
  it("puts a task added from Today on today, by N, the rail's Add or the phone's +", () => {
    expect(prefillFrom(surface("today"))).toEqual({ onToday: true });
  });

  it("puts a task added from a project's page in that project", () => {
    expect(prefillFrom(projectPage("shop", "site"))).toEqual({ ventureId: "shop", projectId: "site" });
    expect(prefillFrom(projectPage("shop", "site", "t1"))).toEqual({ ventureId: "shop", projectId: "site" });
  });

  it("names the venture anywhere else inside one, and nothing outside", () => {
    expect(prefillFrom(venture("shop", "board"))).toEqual({ ventureId: "shop" });
    expect(prefillFrom(taskPage("shop", "t1"))).toEqual({ ventureId: "shop" });
    expect(prefillFrom(HOME)).toEqual({});
    expect(prefillFrom(surface("search"))).toEqual({});
  });
});

describe("makeTasks", () => {
  /** `fails` answers a create with an error, the way the Worker can, for the titles it names. */
  const sender = (fails: Record<string, Error> = {}) => {
    const sent: string[] = [];
    const said: string[] = [];
    let n = 0;
    const steps: { what: string; undo(): Promise<unknown>; redo(): Promise<unknown> }[] = [];
    // As the app's act: a step is kept only when the work lands, and the work is held for a second go.
    const held: { work: (() => Promise<unknown>) | null } = { work: null };
    return {
      sent, steps, said, held,
      send: {
        act: async (work: () => Promise<unknown>, step: { what: string; undo(): Promise<unknown>; redo(): Promise<unknown> }) => {
          held.work = work;
          try {
            await work();
          } catch {
            return false;
          }
          steps.push(step);
          return true;
        },
        create: async (_kind: "tasks", input: TaskRequest & { readonly id: string }) => {
          const err = fails[input.title];
          if (err !== undefined) throw err;
          sent.push(`create ${input.id} ${input.title} ${input.stateId ?? ""}`);
        },
        archive: async (_kind: "tasks", id: string) => { sent.push(`archive ${id}`); },
        unarchive: async (_kind: "tasks", id: string) => { sent.push(`unarchive ${id}`); },
        newId: () => `t${++n}`,
        say: (message: string) => { said.push(message); },
      },
    };
  };

  it("archives the tasks it made when the Worker refuses one partway, and keeps no step", async () => {
    const s = sender({ Glaze: new ApiError(400, "title cannot be empty") });
    expect(await makeTasks(s.send, ["Call", "Glaze", "Fire"], shop, {})).toBe(0);
    expect(s.sent).toEqual(["create t1 Call ", "archive t1"]);
    expect(s.steps).toEqual([]);
  });

  it("keeps what landed when a create goes unanswered, and the second go sends only the rest", async () => {
    const fails: Record<string, Error> = { Glaze: new ApiError(503, "the Worker is busy") };
    const s = sender(fails);
    expect(await makeTasks(s.send, ["Call", "Glaze", "Fire"], shop, {})).toBe(0);
    expect(s.sent).toEqual(["create t1 Call "]);
    delete fails.Glaze;
    await s.held.work?.();
    expect(s.sent).toEqual(["create t1 Call ", "create t2 Glaze ", "create t3 Fire "]);
  });

  it("sends nothing when a line is too long to be a title, and says which", async () => {
    const s = sender();
    expect(await makeTasks(s.send, ["Call", "x".repeat(TASK_TITLE_MAX + 1)], shop, {})).toBe(0);
    expect(s.sent).toEqual([]);
    expect(s.said).toEqual([`Line 2 is longer than ${TASK_TITLE_MAX} characters, so no tasks were added.`]);
  });

  it("makes one task a line, in order, with the column's pre-fill, as one step", async () => {
    const s = sender();
    expect(await makeTasks(s.send, ["Call", "  ", "Glaze"], shop, { stateId: "shop-making" })).toBe(2);
    expect(s.sent).toEqual(["create t1 Call shop-making", "create t2 Glaze shop-making"]);
    expect(s.steps.map((st) => st.what)).toEqual(["added 2 tasks"]);
  });

  it("takes back exactly the tasks it made, by archiving them, and brings them back", async () => {
    const s = sender();
    await makeTasks(s.send, ["Call", "Glaze"], shop, {});
    s.sent.length = 0;
    await s.steps[0]?.undo();
    await s.steps[0]?.redo();
    expect(s.sent).toEqual(["archive t1", "archive t2", "unarchive t1", "unarchive t2"]);
  });

  it("makes nothing with no venture, and says none were made", async () => {
    const s = sender();
    expect(await makeTasks(s.send, ["Call", "Glaze"], null, {})).toBe(0);
    expect(s.sent).toEqual([]);
  });

  it("addLine empties the line for a task this device kept, so a second Enter does not queue a copy", async () => {
    const s = sender();
    const kept = { ...s.send, create: async () => ({ queued: true }), act: async (work: () => Promise<unknown>) => { await work(); return "kept" as const; } };
    expect(await addLine(kept, "Call", shop, {})).toBe(true);
  });

  it("addLine empties the line for a task the Worker took, and keeps it when nothing was made", async () => {
    const s = sender();
    expect(await addLine(s.send, "Call", shop, {})).toBe(true);
    expect(await addLine(s.send, "   ", shop, {})).toBe(false);
    const failed = { ...s.send, act: async () => false as const };
    expect(await addLine(failed, "Call", shop, {})).toBe(false);
  });

  it("hands act every create's answer, and answers none for a paste this device only kept", async () => {
    const s = sender();
    const queued = { queued: true } as const;
    let answer: unknown;
    const kept = {
      ...s.send,
      create: async () => queued,
      act: async (work: () => Promise<unknown>) => {
        answer = await work();
        return "kept" as const;
      },
    };
    // The app's act tells a kept write by its answers; the notice it shows is the only one.
    expect(await makeTasks(kept, ["Call", "Glaze"], shop, {})).toBe(0);
    expect(answer).toEqual([queued, queued]);
  });
});

describe("taskRequest body", () => {
  it("sends a body when there is one and leaves it out when there is not", () => {
    const shop: Home = { id: "shop", states: [], projects: [] };
    expect(taskRequest("read", shop, { body: "https://a.example" })?.body).toBe("https://a.example");
    expect(taskRequest("read", shop, {})).not.toHaveProperty("body");
  });
});
