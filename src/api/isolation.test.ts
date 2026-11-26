/**
 * The isolation proof. Two tenants, A and B, each built to the same full shape through the
 * store's own create paths. Every `Store` method is then run as B, aimed at A where its
 * signature takes an id, and the assertions are two: a read never lets any of A's ids into
 * its result, and a write aimed at A refuses and leaves A's exported data byte-identical.
 *
 * `CASES` is checked for completeness against the store's own prototype, so a new method
 * with no case here fails the build rather than shipping unexamined.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { openStore, type Outcome, type Store } from "./store.js";
import { testDb, type TestDb } from "./testing/d1.js";

let t: TestDb;
let store: Store;

beforeAll(async () => {
  t = await testDb();
  store = openStore({ DB: t.db }, () => new Date("2026-09-14T02:00:00Z"));
});

function must<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(`${outcome.status}: ${outcome.error}`);
  return outcome.value;
}

const NOW = new Date("2026-09-14T02:00:00Z");

interface Archived {
  readonly ventures: string;
  readonly states: string;
  readonly stages: string;
  readonly projects: string;
  readonly milestones: string;
  readonly tasks: string;
  readonly blockers: string;
  readonly notes: string;
  readonly decisions: string;
  readonly risks: string;
  readonly links: string;
  readonly tags: string;
  /** A project archived inside the live parent project. */
  readonly nestedProject: string;
}

/** Everything a tenant's full shape hands back, for the cases that aim at it. */
interface Ids {
  readonly owner: string;
  readonly label: string;
  readonly venture: string;
  /** The venture and project point at this stage, and both are at risk. */
  readonly stage: string;
  /** Every live stage the venture was seeded with, the pointed-at one included. */
  readonly seededStages: readonly string[];
  readonly childVenture: string;
  readonly project: string;
  /** A top-level project holding `child` and, archived, `archived.nestedProject`. */
  readonly parent: string;
  readonly child: string;
  readonly childTask: string;
  readonly milestone: string;
  readonly tag: string;
  readonly task: string;
  readonly taskWaitOn: string;
  readonly blocker: string;
  readonly note: string;
  readonly decision: string;
  readonly risk: string;
  readonly link: string;
  /** Registry links: one on the venture, one on the project, and an archived one on each. */
  readonly registerOnVenture: string;
  readonly registerOnProject: string;
  readonly archivedRegisterOnVenture: string;
  readonly archivedRegisterOnProject: string;
  /** The account is the owner: `id = owner`. */
  readonly email: string;
  readonly passwordHash: string;
  readonly googleSub: string;
  readonly inviteToken: string;
  readonly personInvite: string;
  readonly keyRow: string;
  readonly keyPairing: string;
  readonly inviteEmail: string;
  readonly resetToken: string;
  readonly throttleKey: string;
  readonly archived: Archived;
}

/**
 * Builds one tenant's full shape: a venture owning another venture, and a link; a project
 * with a milestone; a task with a blocker, tags on the task and on the project; a
 * note, a decision, a risk and a link; a backup run; and one archived item of
 * every kind, built and archived separately from the live ones so the live ones stay put
 * for the write-side cases to aim at.
 */
async function buildTenant(owner: string, label: string): Promise<Ids> {
  const archive = async (kind: Parameters<Store["setArchived"]>[1], id: string): Promise<void> => {
    must(await store.setArchived(owner, kind, id, true));
  };

  const venture = must(await store.create(owner, "ventures", { name: `${label} HQ` })).record.id;
  const childVenture = must(await store.create(owner, "ventures", { name: `${label} Sub`, parentId: venture })).record.id;

  const seededStages = must(await store.list(owner, "stages", { venture })).map((s) => s.id);
  const stage = seededStages[0];
  if (stage === undefined) throw new Error("a new venture was not seeded with stages");

  const tag = must(await store.create(owner, "tags", { name: `${label}-tag` })).record.id;
  const project = must(await store.create(owner, "projects", { ventureId: venture, name: `${label} Project`, tagIds: [tag] })).record.id;
  const parent = must(await store.create(owner, "projects", { ventureId: venture, name: `${label} Parent` })).record.id;
  const child = must(await store.create(owner, "projects", { ventureId: venture, name: `${label} Child`, parentId: parent })).record.id;
  const childTask = must(await store.create(owner, "tasks", { ventureId: venture, projectId: child, title: `${label} Child Task` })).record.id;
  must(await store.update(owner, "ventures", venture, { stageId: stage, atRisk: true }));
  must(await store.update(owner, "projects", project, { stageId: stage, atRisk: true }));
  const milestone = must(await store.create(owner, "milestones", { projectId: project, name: `${label} Milestone` })).record.id;

  const taskWaitOn = must(await store.create(owner, "tasks", { ventureId: venture, title: `${label} Task Wait` })).record.id;
  const task = must(await store.create(owner, "tasks", {
    ventureId: venture, projectId: project, milestoneId: milestone, title: `${label} Task`, tagIds: [tag],
  })).record.id;
  const blocker = must(await store.create(owner, "blockers", {
    taskId: task, reason: `${label} blocked`, waitsOnTaskId: taskWaitOn,
  })).record.id;

  const note = must(await store.create(owner, "notes", { ventureId: venture, body: `${label} note body` })).record.id;
  const decision = must(await store.create(owner, "decisions", { ventureId: venture, title: `${label} decision`, body: `${label} decision body` })).record.id;
  const risk = must(await store.create(owner, "risks", { projectId: project, title: `${label} risk`, body: `${label} risk body` })).record.id;
  const link = must(await store.create(owner, "links", { taskId: task, url: `https://example.test/${label}` })).record.id;

  const registerOnVenture = must(await store.create(owner, "links", {
    ventureId: venture, role: "repo", url: `https://example.test/${label}-repo`, label: `${label} venture link`,
  })).record.id;
  const registerOnProject = must(await store.create(owner, "links", {
    projectId: project, role: "docs", url: `https://example.test/${label}-docs`, label: `${label} project link`,
  })).record.id;

  const email = `${label.toLowerCase()}@example.test`;
  const passwordHash = `${label}-password-hash`;
  const googleSub = `${label}-google-sub`;
  if (!(await store.createAccount({ id: owner, email, passwordHash, googleSub, confirmed: true }))) throw new Error("account was refused");
  const inviteToken = `${label}-invite-token`;
  const inviteEmail = `${label.toLowerCase()}-guest@example.test`;
  await store.putEmailToken({ id: inviteToken, owner, purpose: "invite", email: inviteEmail, expiresAt: "2999-01-01T00:00:00.000Z" });
  const personInvite = `${label}-person-invite`;
  await store.putInvite({ id: personInvite, owner, firstName: `${label}Guest`, expiresAt: "2999-01-01T00:00:00.000Z" });
  const keyRow = `${label}-key-row`;
  must(await store.addKeys(owner, {
    keyRef: `${label}-key-ref`, keyCheck: `${label}-key-check`,
    wraps: [{ id: keyRow, kind: "device", label: `${label} device`, deviceId: null, credentialId: null, salt: null, iterations: null, wrapped: null }],
  }));
  const keyPairing = `${label}-key-pairing`;
  must(await store.openPairing(owner, keyPairing));
  must(await store.fillPairing(owner, keyPairing, { sealed: `${label}-key-sealed` }));
  const resetToken = `${label}-reset-token`;
  await store.putEmailToken({ id: resetToken, owner, purpose: "reset", email, expiresAt: "2999-01-01T00:00:00.000Z" });
  const throttleKey = `${label}-throttle-key`;
  await store.attempt(null, [{ key: throttleKey, limit: 100 }], "2026-09-14T01:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");

  // One archived item of every kind, built fresh so the live ones above are untouched.
  const archivedVentures = must(await store.create(owner, "ventures", { name: `${label} Archived Venture` })).record.id;
  await archive("ventures", archivedVentures);

  const archivedStates = must(await store.create(owner, "states", { ventureId: venture, name: `${label} Old State`, kind: "not_started" })).record.id;
  await archive("states", archivedStates);

  const archivedStages = must(await store.create(owner, "stages", { ventureId: venture, name: `${label} Old Stage`, kind: "paused" })).record.id;
  await archive("stages", archivedStages);

  const archivedProjects = must(await store.create(owner, "projects", { ventureId: venture, name: `${label} Archived Project` })).record.id;
  await archive("projects", archivedProjects);

  const nestedProject = must(await store.create(owner, "projects", { ventureId: venture, name: `${label} Archived Child`, parentId: parent })).record.id;
  await archive("projects", nestedProject);

  const archivedMilestones = must(await store.create(owner, "milestones", { projectId: project, name: `${label} Archived Milestone` })).record.id;
  await archive("milestones", archivedMilestones);

  const archivedTasks = must(await store.create(owner, "tasks", { ventureId: venture, title: `${label} Archived Task` })).record.id;
  await archive("tasks", archivedTasks);

  const archivedBlockers = must(await store.create(owner, "blockers", { taskId: taskWaitOn, reason: `${label} archived blocker` })).record.id;
  await archive("blockers", archivedBlockers);


  const archivedNotes = must(await store.create(owner, "notes", { ventureId: venture, body: `${label} archived note` })).record.id;
  await archive("notes", archivedNotes);

  const archivedDecisions = must(await store.create(owner, "decisions", { ventureId: venture, title: `${label} archived decision` })).record.id;
  await archive("decisions", archivedDecisions);

  const archivedRisks = must(await store.create(owner, "risks", { projectId: project, title: `${label} archived risk` })).record.id;
  await archive("risks", archivedRisks);

  const archivedLinks = must(await store.create(owner, "links", { taskId: task, url: `https://example.test/${label}-archived` })).record.id;
  await archive("links", archivedLinks);

  const archivedRegisterOnVenture = must(await store.create(owner, "links", {
    ventureId: venture, role: "repo", url: `https://example.test/${label}-old-repo`, label: `${label} archived venture link`,
  })).record.id;
  await archive("links", archivedRegisterOnVenture);
  const archivedRegisterOnProject = must(await store.create(owner, "links", {
    projectId: project, role: "docs", url: `https://example.test/${label}-old-docs`, label: `${label} archived project link`,
  })).record.id;
  await archive("links", archivedRegisterOnProject);

  const archivedTags = must(await store.create(owner, "tags", { name: `${label}-archived-tag` })).record.id;
  await archive("tags", archivedTags);

  return {
    owner, label, venture, stage, seededStages, childVenture, project, parent, child, childTask, milestone, tag, task, taskWaitOn, blocker,
    note, decision, risk, link, registerOnVenture, registerOnProject, archivedRegisterOnVenture,
    archivedRegisterOnProject,
    email, passwordHash, googleSub, inviteToken, personInvite, keyRow, keyPairing, inviteEmail, resetToken, throttleKey,
    archived: {
      ventures: archivedVentures, states: archivedStates, stages: archivedStages,
      projects: archivedProjects, milestones: archivedMilestones, tasks: archivedTasks, blockers: archivedBlockers,
      notes: archivedNotes, decisions: archivedDecisions, risks: archivedRisks, links: archivedLinks, tags: archivedTags,
      nestedProject,
    },
  };
}

/** Every string A's shape produced, for scanning a result that must never carry one. */
function tokensOf(ids: Ids): string[] {
  return [
    ids.owner, ids.venture, ...ids.seededStages, ids.childVenture, ids.project, ids.parent, ids.child, ids.childTask, ids.milestone, ids.tag, ids.task,
    ids.taskWaitOn, ids.blocker, ids.note, ids.decision, ids.risk, ids.link, ids.registerOnVenture, ids.registerOnProject,
    ids.archivedRegisterOnVenture, ids.archivedRegisterOnProject,
    ids.email, ids.passwordHash, ids.googleSub, ids.inviteToken, ids.personInvite, ids.keyRow, ids.keyPairing, `${ids.label}-key-ref`, `${ids.label}-key-check`, `${ids.label}-key-public`, `${ids.label}-key-sealed`, ids.inviteEmail, ids.resetToken, ids.throttleKey,
    ...Object.values(ids.archived),
  ];
}

function noLeak(result: unknown, tokens: readonly string[]): void {
  const json = JSON.stringify(result) ?? "";
  for (const token of tokens) expect(json).not.toContain(token);
}

/**
 * Every private helper on `D1Store`'s prototype, by name, exactly as
 * `Object.getOwnPropertyNames` reports them at runtime — TypeScript's `private` is erased,
 * so these are visible alongside the public interface methods and have to be named to be
 * subtracted. See `store.ts`'s Contracts note in the scout for the `file:line` of each.
 */
const PRIVATE_HELPERS = new Set([
  "constructor", "now", "one", "madeBefore", "cascade", "detachments",
  "createUnguarded", "updateUnguarded", "insertStatement", "updateStatement",
  "tagStatements", "tagIdsIn", "write", "explain", "failureCounts", "nextTask", "spawnStatements",
  "settingsUpdate", "ownedTables", "insertWrap", "deviceRefsHold", "writeKeys", "stateOf", "plainRefused", "planRestore",
]);

type CaseFn = (b: string, a: Ids) => Promise<unknown>;

/** What `exportAll` cannot see of a tenant: the account, and the invitations it sent. */
const accountState = async (a: Ids) => ({
  account: await store.account(a.owner),
  invites: await store.invites(a.owner),
  people: await store.people(a.owner),
  keys: await store.keys(a.owner),
  export: await store.exportAll(a.owner, NOW),
});

/** The five methods that mutate a record by id. Everything else here is a plain read. */
const WRITE_METHODS = new Set<keyof Store>(["create", "update", "setArchived", "deletePreview", "remove", "actOnReminder"]);

/**
 * Methods keyed by something secret and global, not by a tenant: an address, a Google
 * `sub`, a token hash or a throttle key. They take no owner, so the generic case above
 * (run as B, aimed at A) does not fit them. Each says why, and each has its own assertion.
 */
const SECRET_METHODS = ["attempt", "accountsForGoogle", "takeEmailToken", "pendingToken", "acceptInvite", "pendingPersonInvite", "acceptPersonInvite", "forgetAttempts", "vapidKey", "keepVapidKey", "sessionKey", "keepSessionKey", "setupClaim", "keepSetupClaim", "frontLanding", "setFrontLanding", "updateCheck", "keepUpdateCheck", "updateRun", "keepUpdateRun", "openUpdateRun", "takeUpdateStep", "expireUpdateCheck", "removeSetupKey", "reminderAccounts",
  "registerClient", "client", "takeCode", "grantByToken", "rotateGrant", "purgeConnector", "purgeAccounts"] as const;
type SecretMethod = (typeof SECRET_METHODS)[number];

const CASES: Record<Exclude<keyof Store, SecretMethod>, CaseFn> = {
  overview: (b) => store.overview(b),
  tree: (b) => store.tree(b),
  today: (b) => store.today(b, "2026-09-14"),
  dateFilters: (b) => store.dateFilters(b, "2026-09-14"),
  search: (b, a) => store.search(b, a.label),
  archived: (b) => store.archived(b),
  locked: (b) => store.locked(b),
  list: (b, a) => store.list(b, "tasks", { venture: a.venture }),
  get: (b, a) => store.get(b, "tasks", a.task),

  create: (b, a) => store.create(b, "tasks", { ventureId: a.venture, title: "should not attach to A" }),
  update: (b, a) => store.update(b, "tasks", a.task, { title: "patched by B" }),
  setArchived: (b, a) => store.setArchived(b, "tasks", a.task, true),
  actOnReminder: async (b, a) => {
    expect(await store.actOnReminder(b, a.task, "done", "2026-09-14T09:00")).toMatchObject({ ok: false, status: 404 });
    return store.actOnReminder(b, a.task, "snooze", "2026-09-14T09:00");
  },
  deletePreview: (b, a) => store.deletePreview(b, "tasks", a.task),
  remove: (b, a) => store.remove(b, "tasks", a.task, "delete"),

  account: (b) => store.account(b),
  appearance: (b) => store.appearance(b),
  setAppearance: async (b, a) => {
    const before = await store.appearance(a.owner);
    const result = await store.setAppearance(b, { accent: "rose", spacing: "compact", theme: "dark" });
    expect(await store.appearance(a.owner)).toEqual(before);
    return result;
  },
  encryption: (b) => store.encryption(b),
  startEncryption: async (b, a) => {
    const before = await store.encryption(a.owner);
    const result = await store.startEncryption(b, "on");
    expect(await store.encryption(a.owner)).toEqual(before);
    return result;
  },
  sealBatch: async (b, a) => {
    // B is turning on, and names A's task: nothing of A's is written and A's state is unmoved.
    await store.startEncryption(b, "on");
    const before = await store.get(a.owner, "tasks", a.childTask);
    const result = await store.sealBatch(b, [{ kind: "tasks", id: a.childTask, fields: { title: `v1.${"A".repeat(11)}.${"B".repeat(16)}.${"C".repeat(30)}` } }]);
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(await store.get(a.owner, "tasks", a.childTask)).toEqual(before);
    return result;
  },
  finishEncryption: async (b, a) => {
    const before = await store.encryption(a.owner);
    const result = await store.finishEncryption(b);
    expect(await store.encryption(a.owner)).toEqual(before);
    return result;
  },
  firstRun: (b) => store.firstRun(b),
  setFirstRun: async (b, a) => {
    const before = await store.firstRun(a.owner);
    const result = await store.setFirstRun(b, { step: 5 });
    expect(await store.firstRun(a.owner)).toEqual(before);
    return result;
  },
  keys: (b) => store.keys(b),
  addKeys: async (b, a) => {
    // B's own key, beside A's row: A keeps its row and B sees none of it.
    const before = await accountState(a);
    const result = await store.addKeys(b, {
      keyRef: `b-ref-${b}`, keyCheck: "b-check",
      wraps: [{ id: `b-device-${b}`, kind: "device", label: "B device", deviceId: null, credentialId: null, salt: null, iterations: null, wrapped: null }],
    });
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  archiveKey: async (b, a) => {
    const before = await accountState(a);
    const result = await store.archiveKey(b, a.keyRow);
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  replaceRecovery: async (b, a) => {
    const before = await accountState(a);
    const result = await store.replaceRecovery(b, { id: `b-recovery-${b}`, kind: "recovery", label: "Recovery key", deviceId: null, credentialId: null, salt: null, iterations: null, wrapped: "aa.bb" });
    // B may or may not hold a key by now; either way only B's rows are touched and A's recovery row is not B's to replace.
    expect(result).toSatisfy((r: { ok: boolean; status?: number }) => r.ok || r.status === 409);
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  startAgain: async (b, a) => {
    // B starts again: only B's rows are archived, A's stay live.
    const before = await accountState(a);
    const result = await store.startAgain(b, {
      keyRef: `b-again-${b}`, keyCheck: "b-check",
      wraps: [{ id: `b-again-device-${b}`, kind: "device", label: "B device", deviceId: null, credentialId: null, salt: null, iterations: null, wrapped: null }],
    });
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  openPairing: async (b, a) => {
    // B opens a pairing under A's id: the id is taken, and A's stays filled.
    const result = await store.openPairing(b, a.keyPairing);
    expect(result).toMatchObject({ ok: false, status: 409 });
    return result;
  },
  fillPairing: async (b, a) => {
    const result = await store.fillPairing(b, a.keyPairing, { sealed: "b-sealed" });
    expect(result).toMatchObject({ ok: false, status: 404 });
    return result;
  },
  readPairing: async (b, a) => {
    // B reads A's filled pairing: nothing comes back, and A can still read it once.
    const result = await store.readPairing(b, a.keyPairing);
    expect(result).toMatchObject({ ok: false, status: 404 });
    return result;
  },
  filters: (b) => store.filters(b),
  createFilter: async (b, a) => {
    const before = await store.filters(a.owner);
    const result = await store.createFilter(b, { name: "B's", query: "q" });
    expect(await store.filters(a.owner)).toEqual(before);
    return result;
  },
  renameFilter: async (b, a) => {
    // A's filter is A's: B naming its id renames nothing.
    const mine = await store.createFilter(a.owner, { name: "A's", query: "q" });
    if (!mine.ok) throw new Error(mine.error);
    const result = await store.renameFilter(b, mine.value.id, "taken");
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect((await store.filters(a.owner)).find((f) => f.id === mine.value.id)?.name).toBe("A's");
    return result;
  },
  removeFilter: async (b, a) => {
    const mine = await store.createFilter(a.owner, { name: "A's", query: "q" });
    if (!mine.ok) throw new Error(mine.error);
    const result = await store.removeFilter(b, mine.value.id);
    expect(result).toBe(false);
    expect((await store.filters(a.owner)).some((f) => f.id === mine.value.id)).toBe(true);
    return result;
  },
  pushSubscriptions: (b) => store.pushSubscriptions(b),
  subscribePush: async (b, a) => {
    const before = await store.pushSubscriptions(a.owner);
    const result = await store.subscribePush(b, {
      endpoint: `https://push.example.test/send/${crypto.randomUUID()}`, p256dh: "k", auth: "a", label: null, tz: "UTC",
    });
    expect(await store.pushSubscriptions(a.owner)).toEqual(before);
    return result;
  },
  unsubscribePush: async (b, a) => {
    // A's device is A's: B naming its endpoint archives nothing.
    const endpoint = `https://push.example.test/send/${crypto.randomUUID()}`;
    await store.subscribePush(a.owner, { endpoint, p256dh: "k", auth: "a", label: null, tz: "UTC" });
    const before = await store.pushSubscriptions(a.owner);
    const result = await store.unsubscribePush(b, endpoint);
    expect(result).toBe(false);
    expect(await store.pushSubscriptions(a.owner)).toEqual(before);
    return result;
  },
  pushDevices: async (b, a) => {
    // A device is its owner's: B reads none of A's, keys included.
    const endpoint = `https://push.example.test/send/${crypto.randomUUID()}`;
    await store.subscribePush(a.owner, { endpoint, p256dh: "k", auth: "a", label: null, tz: "UTC" });
    const result = await store.pushDevices(b);
    expect(result.some((d) => d.endpoint === endpoint)).toBe(false);
    return result;
  },
  dueReminders: async (b, a) => {
    // A's due task is not B's: the same window answers B nothing of A's.
    const result = await store.dueReminders(b, "0000-01-01T00:00", "9999-12-31T23:59", 200);
    expect(result.some((d) => d.title === a.label)).toBe(false);
    return result;
  },
  reminderWasSent: async (b, a) => {
    await store.recordReminderSent(a.owner, "task", "iso-ref", "2026-09-14T09:00");
    expect(await store.reminderWasSent(b, "task", "iso-ref", "2026-09-14T09:00")).toBe(false);
    return store.reminderWasSent(a.owner, "task", "iso-ref", "2026-09-14T09:00");
  },
  recordReminderSent: async (b, a) => {
    await store.recordReminderSent(b, "task", "iso-own", "2026-09-14T09:00");
    expect(await store.reminderWasSent(a.owner, "task", "iso-own", "2026-09-14T09:00")).toBe(false);
  },
  pushWorked: async (b, a) => {
    // B naming A's device id marks nothing.
    const endpoint = `https://push.example.test/send/${crypto.randomUUID()}`;
    const mine = await store.subscribePush(a.owner, { endpoint, p256dh: "k", auth: "a", label: null, tz: "UTC" });
    await store.pushWorked(b, mine.id);
    expect((await store.pushSubscriptions(a.owner)).find((d) => d.id === mine.id)?.lastOkAt).toBeNull();
  },
  canvas: (b) => store.canvas(b),
  setCanvas: async (b, a) => {
    const before = await store.canvas(a.owner);
    const result = await store.setCanvas(b, [{ kind: "venture", id: a.venture, x: 1, y: 1 }]);
    expect(await store.canvas(a.owner)).toEqual(before);
    return result;
  },
  createAccount: async (b, a) => {
    // Aimed at A's address, then at A's Google identity, each under a fresh owner id.
    const before = await accountState(a);
    const byEmail = `owner-${crypto.randomUUID()}`;
    const first = await store.createAccount({ id: byEmail, email: a.email, passwordHash: "planted", googleSub: null, confirmed: true });
    expect(first).toBe(false);
    const byGoogle = `owner-${crypto.randomUUID()}`;
    const second = await store.createAccount({
      id: byGoogle, email: `planted-${crypto.randomUUID()}@example.test`, passwordHash: null, googleSub: a.googleSub, confirmed: true,
    });
    expect(second).toBe(false);
    // The refusal took the tenant with it: nothing was half made.
    expect(await rowsWhere("tenant", "id", byEmail)).toBe(0);
    expect(await rowsWhere("tenant", "id", byGoogle)).toBe(0);
    expect(await accountState(a)).toEqual(before);
    return first;
  },
  setPassword: async (b, a) => {
    const before = await accountState(a);
    const result = await store.setPassword(b, "set-by-b", true);
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  endSessions: async (b, a) => {
    const before = await accountState(a);
    const result = await store.endSessions(b);
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  setTwoStep: async (b, a) => {
    const before = await accountState(a);
    const result = await store.setTwoStep(b, { secret: "sealed-by-b", on: true, backupCodes: ["b-hash"] });
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  spendBackupCode: async (b, a) => {
    // B names a hash A holds: B has no such code, and A keeps its own.
    const before = await accountState(a);
    const result = await store.spendBackupCode(b, "a-hash");
    expect(result).toBe(false);
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  acceptTotpStep: async (b, a) => {
    // B records a step: A's own last step is not touched.
    const before = await accountState(a);
    const result = await store.acceptTotpStep(b, 99);
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  setRecoveryCode: async (b, a) => {
    const before = await rowsWhere("recovery_code", "owner", a.owner);
    await store.setRecoveryCode(b, "set-by-b");
    expect(await rowsWhere("recovery_code", "owner", a.owner)).toBe(before);
    const mine = await t.db.prepare(`SELECT code_hash FROM recovery_code WHERE owner = ?`).bind(a.owner).first<{ code_hash: string }>();
    expect(mine?.code_hash ?? null).not.toBe("set-by-b");
  },
  spendRecoveryCode: async (b, a) => {
    await store.setRecoveryCode(a.owner, "a-recovery");
    const result = await store.spendRecoveryCode(b, "a-recovery");
    expect(result).toBe(false);
    expect(await rowsWhere("recovery_code", "owner", a.owner)).toBe(1);
    return result;
  },
  linkGoogle: async (b, a) => {
    // A's `sub` is unique across accounts: B cannot take it, and A keeps it.
    const before = await accountState(a);
    const result = await store.linkGoogle(b, a.googleSub);
    expect(result).toBe(false);
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  unlinkGoogle: async (b, a) => {
    const before = await accountState(a);
    const result = await store.unlinkGoogle(b);
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  sessionHolds: async (b, a) => {
    // A's generation presented for B's id says nothing about A's session.
    const generation = (await store.account(a.owner))?.generation ?? 0;
    return [await store.sessionHolds(b, generation), await store.sessionHolds(b, -1)];
  },
  readingAs: async (b, a) => {
    // B's reads with A's generation along: B's rows, and nothing about A's session.
    const generation = (await store.account(a.owner))?.generation ?? 0;
    const reading = store.readingAs(b, generation);
    return [await reading.store.tree(b), await reading.store.search(b, a.label), await reading.holds()];
  },
  putEmailToken: async (b, a) => {
    // B invites A's guest address, and plants a reset for A's address. Both are B's own rows.
    const before = await accountState(a);
    const planted = [
      { id: crypto.randomUUID(), owner: b, purpose: "invite" as const, email: a.inviteEmail, expiresAt: "2999-01-01T00:00:00.000Z" },
      { id: crypto.randomUUID(), owner: b, purpose: "reset" as const, email: a.email, expiresAt: "2999-01-01T00:00:00.000Z" },
    ];
    for (const token of planted) await store.putEmailToken(token);
    expect(await accountState(a)).toEqual(before);
    // B's own rows name A's addresses, so B spends them again before the result is scanned.
    for (const token of planted) expect(await store.takeEmailToken(token.id, token.purpose)).not.toBeNull();
    return store.invites(b);
  },
  invites: (b) => store.invites(b),
  putInvite: async (b, a) => {
    const before = await accountState(a);
    await store.putInvite({ id: `b-invite-${b}`, owner: b, firstName: "BGuest", expiresAt: "2999-01-01T00:00:00.000Z" });
    expect(await accountState(a)).toEqual(before);
    return store.people(b);
  },
  people: (b) => store.people(b),
  withdrawPersonInvite: async (b, a) => {
    // B names A's waiting invitation: B has none there to withdraw, and A's stays.
    const before = await accountState(a);
    const result = await store.withdrawPersonInvite(b, a.personInvite);
    expect(result).toBe(false);
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  removePerson: async (b, a) => {
    // B names A's own account and A's waiting invitation: neither is B's person, and nothing is scheduled.
    const before = await accountState(a);
    const results = [await store.removePerson(b, a.owner), await store.removePerson(b, a.personInvite)];
    for (const result of results) expect(result).toMatchObject({ ok: false, status: 404 });
    expect(await store.deletion(a.owner)).toBeNull();
    expect(await accountState(a)).toEqual(before);
    return results;
  },
  withdrawInvite: async (b, a) => {
    // B names A's guest: B has no invitation there to withdraw, and A's stays.
    const before = await accountState(a);
    const result = await store.withdrawInvite(b, a.inviteEmail);
    expect(result).toBe(false);
    expect(await accountState(a)).toEqual(before);
    return result;
  },
  putCode: async (b, a) => {
    await connectorClient();
    const hash = `b-code-${crypto.randomUUID()}`;
    await store.putCode(b, { hash, clientId: CONNECTOR_CLIENT, challenge: "c", redirectUri: "https://c.example/cb", expiresAt: "2999-01-01T00:00:00.000Z" });
    const taken = await store.takeCode(hash);
    expect(taken?.owner).toBe(b);
    expect(taken?.owner).not.toBe(a.owner);
    return taken;
  },
  issueGrant: async (b, a) => {
    const mine = await grantFor(a.owner);
    const result = await grantFor(b);
    expect(result.owner).toBe(b);
    expect((await store.grants(a.owner)).some((g) => g.id === mine.id)).toBe(true);
    return result;
  },
  grants: async (b, a) => {
    await grantFor(a.owner);
    return store.grants(b);
  },
  revokeGrant: async (b, a) => {
    const mine = await grantFor(a.owner);
    const result = await store.revokeGrant(b, mine.id);
    expect(result).toBe(false);
    expect((await store.grants(a.owner)).some((g) => g.id === mine.id)).toBe(true);
    return result;
  },
  recordChange: async (b, a) => {
    const result = await store.recordChange(b, { grantId: "g", clientName: "Claude", tool: "add_task", kind: "tasks", recordId: `b-record-${b}`, before: null });
    expect((await store.changes(a.owner, "2000-01-01T00:00:00.000Z")).some((c) => c.id === result.id)).toBe(false);
    return { id: result.id };
  },
  changes: async (b, a) => {
    await store.recordChange(a.owner, { grantId: "g", clientName: "Claude", tool: "add_task", kind: "tasks", recordId: a.task, before: null });
    return store.changes(b, "2000-01-01T00:00:00.000Z");
  },
  change: async (b, a) => {
    const mine = await store.recordChange(a.owner, { grantId: "g", clientName: "Claude", tool: "add_task", kind: "tasks", recordId: a.task, before: null });
    return store.change(b, mine.id);
  },
  markChangeUndone: async (b, a) => {
    const mine = await store.recordChange(a.owner, { grantId: "g", clientName: "Claude", tool: "add_task", kind: "tasks", recordId: a.task, before: null });
    const result = await store.markChangeUndone(b, mine.id);
    expect(result).toBe(false);
    expect((await store.changes(a.owner, "2000-01-01T00:00:00.000Z")).find((c) => c.id === mine.id)?.undoneAt).toBeNull();
    return result;
  },

  exportAll: (b) => store.exportAll(b, NOW),
  restoreAll: async (_b, a) => {
    // A file with A's own rows, restored under a stranger: A keeps every row and id it had.
    const before = await store.exportAll(a.owner, NOW);
    const stranger = `owner-${crypto.randomUUID()}`;
    // Some tables name the account itself, so the person restored into has one.
    await store.createAccount({ id: stranger, email: `${stranger}@example.com`, passwordHash: "x", googleSub: null, confirmed: true });
    const result = await store.restoreAll(stranger, { tables: before.tables });
    expect(result.ok ? "" : result.error).toBe("");
    expect(await store.exportAll(a.owner, NOW)).toEqual(before);
    return { counts: result.ok ? result.value.counts : null };
  },
  checkRestore: async (_b, a) => {
    // The check reads no one's rows: it answers for the file alone, and writes nothing.
    const before = await store.exportAll(a.owner, NOW);
    const result = await store.checkRestore({ tables: {} });
    expect(result.ok ? "" : result.error).toBe("");
    expect(await store.exportAll(a.owner, NOW)).toEqual(before);
    return result;
  },
  deletion: (b) => store.deletion(b),
  scheduleDeletion: async (b, a) => {
    const result = await store.scheduleDeletion(b);
    expect(await store.deletion(a.owner)).toBeNull();
    return result;
  },
  cancelDeletion: async (b, a) => {
    await store.cancelDeletion(b);
    return store.deletion(a.owner);
  },
};

/** A table's rows for one key, read straight from the table, for the keyed cases. */
const rowsWhere = async (table: "email_token" | "throttle" | "tenant" | "recovery_code", column: "id" | "key" | "owner", value: string): Promise<number> =>
  (await t.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).bind(value).first<{ n: number }>())?.n ?? 0;

const CONNECTOR_CLIENT = "https://claude.example/client.json";
const connectorClient = (): Promise<void> => store.registerClient({ id: CONNECTOR_CLIENT, name: "Claude", redirectUris: ["https://c.example/cb"] });
const grantFor = async (owner: string) => {
  await connectorClient();
  return store.issueGrant(owner, {
    clientId: CONNECTOR_CLIENT, tokenHash: `t-${crypto.randomUUID()}`, refreshHash: `r-${crypto.randomUUID()}`, expiresAt: "2999-01-01T00:00:00.000Z",
  });
};

const KEYED_BY_SECRET: Record<SecretMethod, { reason: string; check: CaseFn }> = {
  attempt: {
    reason: "keyed by an address and by throttle keys; whoever holds the address is asked, not a tenant, and the sweep takes only rows older than the time it is given",
    check: async (b, a) => {
      const mine = await store.account(b);
      const found = await store.attempt(mine?.email ?? "", [{ key: `${b}-key`, limit: 100 }], "2026-09-14T01:30:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
      expect(found.account?.id).toBe(b);
      expect(found.reserved).toHaveLength(1);
      noLeak(found, tokensOf(a));
      // B's attempt counted against B's key only: A's row is as it was.
      expect(await rowsWhere("throttle", "key", a.throttleKey)).toBe(1);
      expect(await rowsWhere("throttle", "key", `${b}-key`)).toBe(1);
    },
  },
  accountsForGoogle: {
    reason: "keyed by a Google `sub` and an address, which the provider vouches for",
    check: async (b, a) => {
      const mine = await store.account(b);
      const found = await store.accountsForGoogle(mine?.googleSub ?? "", mine?.email ?? "");
      expect(found.map((x) => x.id)).toEqual([b]);
      noLeak(found, tokensOf(a));
      expect(await store.accountsForGoogle("no-such-sub", "no-one@example.test")).toEqual([]);
    },
  },
  takeEmailToken: {
    reason: "keyed by the hash of a mailed token, which only its recipient holds",
    check: async (_b, a) => {
      // A's reset token is not an invite or a confirmation, and A's invite is not a reset.
      expect(await store.takeEmailToken(a.resetToken, "invite")).toBeNull();
      expect(await store.takeEmailToken(a.resetToken, "confirm")).toBeNull();
      expect(await store.takeEmailToken(a.inviteToken, "reset")).toBeNull();
      expect(await store.takeEmailToken("no-such-token", "invite")).toBeNull();
      expect(await rowsWhere("email_token", "id", a.resetToken)).toBe(1);
      expect(await rowsWhere("email_token", "id", a.inviteToken)).toBe(1);
    },
  },
  pendingToken: {
    reason: "keyed by the hash of a mailed token, which only its recipient holds",
    check: async (_b, a) => {
      // A token answers only for its own purpose, and looking does not spend it.
      expect(await store.pendingToken(a.resetToken, "invite")).toBeNull();
      expect(await store.pendingToken("no-such-token", "reset")).toBeNull();
      expect((await store.pendingToken(a.inviteToken, "invite"))?.owner).toBe(a.owner);
      expect((await store.pendingToken(a.resetToken, "reset"))?.owner).toBe(a.owner);
      expect(await rowsWhere("email_token", "id", a.inviteToken)).toBe(1);
      expect(await rowsWhere("email_token", "id", a.resetToken)).toBe(1);
    },
  },
  acceptInvite: {
    reason: "keyed by the hash of a mailed token, which only its recipient holds",
    check: async (b, a) => {
      // A's reset token makes no account; B's own account id cannot take an invitation, and
      // the clash leaves A's invitation where it was.
      const fresh = `owner-${crypto.randomUUID()}`;
      expect(await store.acceptInvite(a.resetToken, { id: fresh, passwordHash: "h", googleSub: null })).toEqual({ made: false, why: "invalid" });
      expect(await store.acceptInvite(a.inviteToken, { id: b, passwordHash: "h", googleSub: null })).toEqual({ made: false, why: "taken" });
      expect(await rowsWhere("email_token", "id", a.inviteToken)).toBe(1);
      expect(await rowsWhere("email_token", "id", a.resetToken)).toBe(1);
      expect(await rowsWhere("tenant", "id", fresh)).toBe(0);
    },
  },
  pendingPersonInvite: {
    reason: "keyed by the hash of a link only the person invited holds; looking does not spend it",
    check: async (b, a) => {
      expect(await store.pendingPersonInvite(`b-guess-${b}`)).toBeNull();
      expect(await store.pendingPersonInvite(a.personInvite)).toEqual({ firstName: `${a.label}Guest` });
      expect(await store.pendingPersonInvite(a.personInvite)).not.toBeNull();
    },
  },
  acceptPersonInvite: {
    reason: "keyed by the hash of a link only the person invited holds",
    check: async (b, a) => {
      // A made-up link makes nothing, and B's own account id cannot take A's invitation, which stays unused.
      const fresh = `owner-${crypto.randomUUID()}`;
      expect(await store.acceptPersonInvite(`b-guess-${b}`, { id: fresh, email: `${fresh}@example.test`, passwordHash: "h", googleSub: null }))
        .toEqual({ made: false, why: "invalid" });
      expect(await store.acceptPersonInvite(a.personInvite, { id: b, email: `${b}-new@example.test`, passwordHash: "h", googleSub: null }))
        .toEqual({ made: false, why: "taken" });
      expect(await store.pendingPersonInvite(a.personInvite)).not.toBeNull();
      expect(await rowsWhere("tenant", "id", fresh)).toBe(0);
    },
  },
  vapidKey: {
    reason: "one row for the whole copy, holding a key pair and no tenant's data",
    check: async (_b, a) => {
      noLeak(await store.vapidKey(), tokensOf(a));
    },
  },
  sessionKey: {
    reason: "one row for the whole copy, holding a signing key and no tenant's data",
    check: async (_b, a) => {
      noLeak(await store.sessionKey(), tokensOf(a));
    },
  },
  keepSessionKey: {
    reason: "one row for the whole copy; a second key never replaces the first",
    check: async (_b, a) => {
      const first = await store.keepSessionKey("first-key");
      expect(await store.keepSessionKey("second-key")).toBe(first);
      noLeak(first, tokensOf(a));
    },
  },
  setupClaim: {
    reason: "one row for the whole copy, owned by the instance and holding no tenant's data",
    check: async (_b, a) => {
      noLeak(await store.setupClaim(), tokensOf(a));
    },
  },
  keepSetupClaim: {
    reason: "one row for the whole copy; a second claim never replaces the first",
    check: async (_b, a) => {
      const first = await store.keepSetupClaim("first-sealed", true);
      expect((await store.keepSetupClaim(null, false)).claim).toEqual(first.claim);
      noLeak(first.claim, tokensOf(a));
    },
  },
  frontLanding: {
    reason: "one row for the whole copy, a yes or no and no tenant's data",
    check: async (_b, a) => {
      noLeak(await store.frontLanding(), tokensOf(a));
    },
  },
  setFrontLanding: {
    reason: "one row for the whole copy; the route lets only the copy's owner write it",
    check: async () => {
      const before = await store.frontLanding();
      expect(await store.setFrontLanding(before)).toBe(before);
    },
  },
  updateCheck: {
    reason: "one row for the whole copy, owned by the instance and holding no tenant's data",
    check: async (_b, a) => {
      noLeak(await store.updateCheck(), tokensOf(a));
    },
  },
  keepUpdateCheck: {
    reason: "one row for the whole copy; it holds a signed release and no tenant's data",
    check: async (_b, a) => {
      noLeak(await store.keepUpdateCheck(null), tokensOf(a));
    },
  },
  updateRun: {
    reason: "one row for the whole copy, owned by the instance and holding no tenant's data",
    check: async (_b, a) => {
      noLeak(await store.updateRun(), tokensOf(a));
    },
  },
  keepUpdateRun: {
    reason: "one row for the whole copy; the route lets only the copy's owner start an update",
    check: async (_b, a) => {
      const run = {
        version: "9.9.9", step: "start", state: "running", accountId: null, databaseId: null, workerName: null,
        previousVersionId: null, previousVersion: null, newVersionId: null, bookmark: null, migrated: 0, startedAt: "2026-09-14T09:00:00.000Z", backUntil: null,
      };
      noLeak(await store.keepUpdateRun(run), tokensOf(a));
    },
  },
  openUpdateRun: {
    reason: "one row for the whole copy; it opens only when no run is open, and the route lets only the copy's owner start an update",
    check: async (_b, a) => {
      const run = {
        version: "9.9.9", step: "files", state: "running", accountId: null, databaseId: null, workerName: null,
        previousVersionId: null, previousVersion: null, newVersionId: null, bookmark: null, migrated: 0, startedAt: "2026-09-14T09:00:00.000Z", backUntil: null,
      };
      noLeak(await store.openUpdateRun(run), tokensOf(a));
    },
  },
  takeUpdateStep: {
    reason: "one row for the whole copy; it only marks the run busy, and answers whether the caller holds the step",
    check: async (_b, a) => {
      noLeak(await store.takeUpdateStep("files"), tokensOf(a));
    },
  },
  expireUpdateCheck: {
    reason: "one row for the whole copy; it only makes the daily check due again and holds no tenant's data",
    check: async (_b, a) => {
      noLeak(await store.expireUpdateCheck(), tokensOf(a));
    },
  },
  removeSetupKey: {
    reason: "one row for the whole copy, owned by the instance; the route lets only the copy's owner turn Update myself off",
    check: async (_b, a) => {
      noLeak(await store.removeSetupKey(), tokensOf(a));
    },
  },
  keepVapidKey: {
    reason: "one row for the whole copy; a second pair never replaces the first",
    check: async (_b, a) => {
      const first = await store.keepVapidKey({ publicKey: "first-public", privateKey: "first-private" });
      expect(await store.keepVapidKey({ publicKey: "second-public", privateKey: "second-private" })).toEqual(first);
      noLeak(first, tokensOf(a));
    },
  },
  reminderAccounts: {
    reason: "read by the tick alone, which tells every account its own; it answers settings and a zone, never a record",
    check: async (_b, a) => {
      noLeak(await store.reminderAccounts(), tokensOf(a));
    },
  },
  forgetAttempts: {
    reason: "keyed by a throttle key; it clears only the keys it is given",
    check: async (b, a) => {
      const { reserved } = await store.attempt(null, [{ key: `${b}-reserved`, limit: 100 }], "2026-09-14T01:30:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
      await store.attempt(null, [{ key: `${b}-forgotten`, limit: 100 }], "2026-09-14T01:30:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
      await store.forgetAttempts([`${b}-forgotten`], reserved ?? []);
      expect(await rowsWhere("throttle", "key", `${b}-reserved`)).toBe(0);
      expect(await rowsWhere("throttle", "key", `${b}-forgotten`)).toBe(0);
      expect(await rowsWhere("throttle", "key", a.throttleKey)).toBe(1);
    },
  },
  registerClient: {
    reason: "an app's own name and addresses, owned by nobody, keyed by the address it publishes",
    check: async (_b, a) => {
      await connectorClient();
      noLeak(await store.client(CONNECTOR_CLIENT), tokensOf(a));
    },
  },
  client: {
    reason: "keyed by the address an app publishes; it answers a name and addresses, never a record",
    check: async (_b, a) => {
      await connectorClient();
      noLeak(await store.client(CONNECTOR_CLIENT), tokensOf(a));
      expect(await store.client("https://nobody.example/c.json")).toBeNull();
    },
  },
  takeCode: {
    reason: "keyed by the hash of a code only the allowed app holds",
    check: async (b, a) => {
      await connectorClient();
      await store.putCode(a.owner, { hash: `a-code-${a.owner}`, clientId: CONNECTOR_CLIENT, challenge: "c", redirectUri: "https://c.example/cb", expiresAt: "2999-01-01T00:00:00.000Z" });
      expect(await store.takeCode(`b-guess-${b}`)).toBeNull();
      const kept = await t.db.prepare(`SELECT count(*) AS n FROM connector_code WHERE owner = ?`).bind(a.owner).first<{ n: number }>();
      expect(kept?.n).toBe(1);
    },
  },
  grantByToken: {
    reason: "keyed by the hash of an access token only the allowed app holds",
    check: async (b, a) => {
      expect(await store.grantByToken(`b-guess-${b}`)).toBeNull();
      noLeak(await store.grantByToken("no-such-token"), tokensOf(a));
    },
  },
  rotateGrant: {
    reason: "keyed by the hash of a refresh token only the allowed app holds",
    check: async (b) => {
      expect(await store.rotateGrant(`b-guess-${b}`, "c", { tokenHash: "x", refreshHash: "y", expiresAt: "2999-01-01T00:00:00.000Z" })).toBeNull();
    },
  },
  purgeAccounts: {
    reason: "removes only accounts whose own seven days have passed; one nobody asked to remove is left alone",
    check: async (_b, a) => {
      expect(await store.purgeAccounts("")).toBe(0);
      expect(await store.deletion(a.owner)).toBeNull();
    },
  },
  purgeConnector: {
    reason: "removes only what is already spent: expired codes and revoked grants",
    check: async (_b, a) => {
      const live = await grantFor(a.owner);
      await store.purgeConnector();
      expect((await store.grants(a.owner)).some((g) => g.id === live.id)).toBe(true);
    },
  },
};

describe("methods keyed by a secret, not a tenant", () => {
  let a: Ids;
  let ownerB: string;

  beforeAll(async () => {
    a = await buildTenant(`owner-${crypto.randomUUID()}`, "AlphaSecretMark");
    ownerB = `owner-${crypto.randomUUID()}`;
    await buildTenant(ownerB, "BetaSecretMark");
  });

  it.each(SECRET_METHODS)("%s reveals and changes nothing of A", async (key) => {
    expect(KEYED_BY_SECRET[key].reason).not.toBe("");
    const before = await accountState(a);
    await KEYED_BY_SECRET[key].check(ownerB, a);
    expect(await accountState(a)).toEqual(before);
  });
});

describe("no store method crosses tenants", () => {
  let a: Ids;
  let ownerB: string;

  beforeAll(async () => {
    const ownerA = `owner-${crypto.randomUUID()}`;
    ownerB = `owner-${crypto.randomUUID()}`;
    a = await buildTenant(ownerA, "AlphaTenantMark");
    await buildTenant(ownerB, "BetaTenantMark");
  });

  it("names a case for every Store method, and only those", () => {
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(store)) as string[];
    const publicMethods = proto.filter((name) => !PRIVATE_HELPERS.has(name)).sort();
    expect(publicMethods).toEqual([...Object.keys(CASES), ...SECRET_METHODS].sort());
    expect(Object.keys(KEYED_BY_SECRET).sort()).toEqual([...SECRET_METHODS].sort());
  });

  const keys = (Object.keys(CASES) as (keyof typeof CASES)[]);

  it.each(keys)("%s cannot reach tenant A", async (key) => {
    const tokens = tokensOf(a);
    const fn = CASES[key];

    if (WRITE_METHODS.has(key)) {
      const before = await store.exportAll(a.owner, NOW);
      const result = await fn(ownerB, a);
      if (key === "deletePreview") {
        expect(result).toBeNull();
      } else {
        expect(result).toMatchObject({ ok: false });
      }
      const after = await store.exportAll(a.owner, NOW);
      expect(after).toEqual(before);
    } else {
      const result = await fn(ownerB, a);
      noLeak(result, tokens);
    }
  });
});

describe("no ledger method crosses tenants", () => {
  let a: Ids;
  let ownerB: string;

  beforeAll(async () => {
    a = await buildTenant(`owner-${crypto.randomUUID()}`, "AlphaLedgerMark");
    ownerB = `owner-${crypto.randomUUID()}`;
    await buildTenant(ownerB, "BetaLedgerMark");
  });

  const kinds = ["decisions", "risks"] as const;
  const idOf = (kind: (typeof kinds)[number], ids: Ids): string => (kind === "decisions" ? ids.decision : ids.risk);

  /** Runs one refused write as B and proves A's export did not move. */
  async function refused(attempt: () => Promise<unknown>): Promise<void> {
    const before = await store.exportAll(a.owner, NOW);
    expect(await attempt()).toMatchObject({ ok: false });
    expect(await store.exportAll(a.owner, NOW)).toEqual(before);
  }

  it.each(kinds)("%s: B cannot create on A's venture", (kind) =>
    refused(() => store.create(ownerB, kind, { ventureId: a.venture, title: "planted by B" })));

  it.each(kinds)("%s: B cannot create on A's project", (kind) =>
    refused(() => store.create(ownerB, kind, { projectId: a.project, title: "planted by B" })));

  it.each(kinds)("%s: B cannot update A's record, live or archived", async (kind) => {
    await refused(() => store.update(ownerB, kind, idOf(kind, a), { title: "patched by B" }));
    await refused(() => store.update(ownerB, kind, a.archived[kind], { title: "patched by B" }));
  });

  it.each(kinds)("%s: B cannot archive or restore A's record", async (kind) => {
    await refused(() => store.setArchived(ownerB, kind, idOf(kind, a), true));
    await refused(() => store.setArchived(ownerB, kind, a.archived[kind], false));
  });

  it.each(kinds)("%s: B cannot remove A's record, live or archived", async (kind) => {
    await refused(() => store.remove(ownerB, kind, idOf(kind, a), "delete"));
    await refused(() => store.remove(ownerB, kind, a.archived[kind], "delete"));
  });

  it.each(kinds)("%s: B cannot read A's record", async (kind) => {
    noLeak(await store.get(ownerB, kind, idOf(kind, a)), tokensOf(a));
    noLeak(await store.list(ownerB, kind, { venture: a.venture }), tokensOf(a));
    noLeak(await store.list(ownerB, kind, { project: a.project }), tokensOf(a));
  });
});

describe("no stage or at-risk write crosses tenants", () => {
  let a: Ids;
  let b: Ids;

  beforeAll(async () => {
    a = await buildTenant(`owner-${crypto.randomUUID()}`, "AlphaStageMark");
    b = await buildTenant(`owner-${crypto.randomUUID()}`, "BetaStageMark");
  });

  /** Runs one refused write as B and proves A's export did not move. */
  async function refused(attempt: () => Promise<unknown>): Promise<void> {
    const before = await store.exportAll(a.owner, NOW);
    expect(await attempt()).toMatchObject({ ok: false });
    expect(await store.exportAll(a.owner, NOW)).toEqual(before);
  }

  it("B cannot create a stage on A's venture", () =>
    refused(() => store.create(b.owner, "stages", { ventureId: a.venture, name: "planted by B", kind: "paused" })));

  it("B cannot update A's stage, live or archived", async () => {
    await refused(() => store.update(b.owner, "stages", a.stage, { name: "patched by B" }));
    await refused(() => store.update(b.owner, "stages", a.archived.stages, { name: "patched by B" }));
  });

  it("B cannot archive or restore A's stage", async () => {
    await refused(() => store.setArchived(b.owner, "stages", a.stage, true));
    await refused(() => store.setArchived(b.owner, "stages", a.archived.stages, false));
  });

  it("B cannot remove A's stage, live or archived", async () => {
    await refused(() => store.remove(b.owner, "stages", a.stage, "delete"));
    await refused(() => store.remove(b.owner, "stages", a.archived.stages, "delete"));
  });

  it("B cannot set A's venture or project at risk or point it at a stage", async () => {
    await refused(() => store.update(b.owner, "ventures", a.venture, { atRisk: false }));
    await refused(() => store.update(b.owner, "ventures", a.venture, { stageId: null }));
    await refused(() => store.update(b.owner, "ventures", a.venture, { stageId: b.stage }));
    await refused(() => store.update(b.owner, "projects", a.project, { atRisk: false }));
    await refused(() => store.update(b.owner, "projects", a.project, { stageId: null }));
    await refused(() => store.update(b.owner, "projects", a.project, { stageId: b.stage }));
  });

  it("B cannot point its own venture or project at A's stage", async () => {
    const before = await store.exportAll(b.owner, NOW);
    const other = a.seededStages[1] ?? a.stage;
    for (const stageId of [a.stage, other, a.archived.stages]) {
      expect(await store.update(b.owner, "ventures", b.venture, { stageId })).toMatchObject({ ok: false });
      expect(await store.update(b.owner, "projects", b.project, { stageId })).toMatchObject({ ok: false });
    }
    expect(await store.exportAll(b.owner, NOW)).toEqual(before);
  });

  it("B's get and list of stages by A's venture leak nothing", async () => {
    noLeak(await store.get(b.owner, "stages", a.stage), tokensOf(a));
    noLeak(await store.get(b.owner, "stages", a.archived.stages), tokensOf(a));
    noLeak(await store.list(b.owner, "stages", { venture: a.venture }), tokensOf(a));
  });
});

describe("no register path crosses tenants", () => {
  let a: Ids;
  let ownerB: string;

  beforeAll(async () => {
    a = await buildTenant(`owner-${crypto.randomUUID()}`, "AlphaRegisterMark");
    ownerB = `owner-${crypto.randomUUID()}`;
    await buildTenant(ownerB, "BetaRegisterMark");
  });

  /** Runs one refused write as B and proves A's export did not move. */
  async function refused(attempt: () => Promise<unknown>): Promise<void> {
    const before = await store.exportAll(a.owner, NOW);
    expect(await attempt()).toMatchObject({ ok: false });
    expect(await store.exportAll(a.owner, NOW)).toEqual(before);
  }

  const url = "https://example.test/planted-by-b";
  const register = (): { live: string; archived: string }[] => [
    { live: a.registerOnVenture, archived: a.archivedRegisterOnVenture },
    { live: a.registerOnProject, archived: a.archivedRegisterOnProject },
  ];

  it("B cannot create a link on A's venture, project or task", async () => {
    await refused(() => store.create(ownerB, "links", { ventureId: a.venture, role: "repo", url }));
    await refused(() => store.create(ownerB, "links", { projectId: a.project, role: "docs", url }));
    await refused(() => store.create(ownerB, "links", { taskId: a.task, url }));
  });

  it("B cannot update the role, url or label of A's links, live or archived", async () => {
    for (const { live, archived } of register()) {
      for (const id of [live, archived]) {
        await refused(() => store.update(ownerB, "links", id, { role: "other" }));
        await refused(() => store.update(ownerB, "links", id, { url }));
        await refused(() => store.update(ownerB, "links", id, { label: "patched by B" }));
      }
    }
    // Each refused call exports A's whole account before and after, 18 times over. That outgrew the
    // 30 s default as tables were added; the checks are unchanged, only the time allowed is longer.
  }, 180_000);

  it("B cannot archive or restore A's links", async () => {
    for (const { live, archived } of register()) {
      await refused(() => store.setArchived(ownerB, "links", live, true));
      await refused(() => store.setArchived(ownerB, "links", archived, false));
    }
  });

  it("B cannot remove A's links, live or archived", async () => {
    for (const { live, archived } of register()) {
      await refused(() => store.remove(ownerB, "links", live, "delete"));
      await refused(() => store.remove(ownerB, "links", archived, "delete"));
    }
  });

  it("B's get and list of A's links leak nothing", async () => {
    const tokens = [...tokensOf(a), "AlphaRegisterMark"];
    for (const { live, archived } of register()) {
      noLeak(await store.get(ownerB, "links", live), tokens);
      noLeak(await store.get(ownerB, "links", archived), tokens);
    }
    noLeak(await store.list(ownerB, "links", { venture: a.venture }), tokens);
    noLeak(await store.list(ownerB, "links", { project: a.project }), tokens);
  });
});

describe("no nesting crosses tenants", () => {
  let a: Ids;
  let b: Ids;

  beforeAll(async () => {
    a = await buildTenant(`owner-${crypto.randomUUID()}`, "AlphaNestMark");
    b = await buildTenant(`owner-${crypto.randomUUID()}`, "BetaNestMark");
  });

  /** Runs one refused write as B and proves A's export did not move. */
  async function refused(attempt: () => Promise<unknown>, status?: number): Promise<void> {
    const before = await store.exportAll(a.owner, NOW);
    expect(await attempt()).toMatchObject(status === undefined ? { ok: false } : { ok: false, status });
    expect(await store.exportAll(a.owner, NOW)).toEqual(before);
  }

  it("B cannot create a project inside A's project", () =>
    refused(() => store.create(b.owner, "projects", { ventureId: b.venture, name: "planted by B", parentId: a.parent }), 404));

  it("B cannot put its own project inside A's project", () =>
    refused(() => store.update(b.owner, "projects", b.project, { parentId: a.parent })));

  it("B cannot move A's projects into or out of anything", async () => {
    await refused(() => store.update(b.owner, "projects", a.child, { parentId: null }));
    await refused(() => store.update(b.owner, "projects", a.project, { parentId: a.parent }));
    await refused(() => store.update(b.owner, "projects", a.project, { parentId: b.parent }));
    await refused(() => store.update(b.owner, "projects", a.child, { parentId: b.parent }));
  });

  it("B cannot archive or remove A's parent, and A still sees its child", async () => {
    await refused(() => store.setArchived(b.owner, "projects", a.parent, true));
    await refused(() => store.remove(b.owner, "projects", a.parent, "delete"));
    const seen = must(await store.list(a.owner, "projects", { venture: a.venture })).map((p) => p.id);
    expect(seen).toContain(a.child);
    expect(seen).toContain(a.parent);
  });

  it("B's archive never names an id of A's, holds included", async () => {
    const archive = await store.archived(b.owner);
    noLeak(archive, tokensOf(a));
    expect(archive.flatMap((item) => item.holds ?? []).filter((id) => id === a.child || id === a.archived.nestedProject)).toEqual([]);
  });

  it("A's archive does name its archived child", async () => {
    expect((await store.archived(a.owner)).some((i) => i.id === a.archived.nestedProject)).toBe(true);
  });
});

describe("the archived-venture count is its tenant's own", () => {
  it("never lets B's archived ventures change A's count", async () => {
    const ownerA = `owner-${crypto.randomUUID()}`;
    const ownerB = `owner-${crypto.randomUUID()}`;
    await buildTenant(ownerA, "AlphaCountMark");
    await buildTenant(ownerB, "BetaCountMark");
    const before = (await store.overview(ownerA)).archivedVentures;
    expect(before).toBe(1);

    for (const name of ["B one", "B two"]) {
      const v = must(await store.create(ownerB, "ventures", { name })).record.id;
      must(await store.setArchived(ownerB, "ventures", v, true));
    }

    expect((await store.overview(ownerB)).archivedVentures).toBe(3);
    expect((await store.overview(ownerA)).archivedVentures).toBe(before);
  });
});
