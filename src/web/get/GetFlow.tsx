import { useEffect, useReducer, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Icon } from "@vemi/icons";
import { THEMES } from "@vemi/shared";
import { SetupError, createCloudflare, type Cloudflare } from "../../shared/setup/cloudflareApi.js";
import { createBuild } from "../../shared/setup/buildSteps.js";
import type { ReleaseManifest } from "../../shared/setup/releaseManifest.js";
import {
  DEPLOY_LINK, KEY_LIST_LINK, MOVE_ROW, NUMBERED_STEPS, SIGN_UP_LINK, dotStep, buildRows, claimFor, fromLocalMode, fromOldAccount, keyProblem, nameFrom, nameProblem,
  restore, saveText, type FlowStep, type RowState,
} from "../../shared/setup/getFlow.js";
import { tokenLink } from "../../shared/setup/tokenLink.js";
import { canGoNext, canMove, initial, reduce, toSaved, type GetState } from "./getFlowState.js";
import { handOver } from "./handOver.js";
import { lightBundle, loadBundle, loadManifest } from "./loadRelease.js";
import { createRelayFetch } from "./relayFetch.js";
import { fileSource, moveToCloud, type MoveSource } from "../moveToCloud.js";
import { MoveDone, openLinkFor } from "./MoveDone.js";
import { MoveKey } from "./MoveKey.js";
import { lockedHeld, needsKey, openBeforeSend } from "../moveLocked.js";
import { MoveLogin, MoveMissing, moveRow, type MoveActions } from "./MoveBuild.js";
// The one piece of the app's own code this page takes: the small i and its note. It imports React and
// its own stylesheet and nothing else, and tests/get-page.test.ts holds it to that.
import { InfoTip } from "../ui/InfoTip.js";

/** The one place the page keeps its place for a closed tab. Never the key or the claim code. */
export const SAVED_KEY = "vemi:get:v1";

/** Words on the screens. Labels, with the one key line and the one key-key sentence the brief names. */
export const WORDS = {
  title: "Get my own VEMI",
  account: { title: "Cloudflare account", line: "Your copy runs in your own Cloudflare account.", make: "Make a free Cloudflare account", have: "I have one" },
  permission: {
    title: "Connect Cloudflare",
    lede: "Paste a key so this page can build your copy.",
    open: "Open the permission page",
    paste: "Paste",
    placeholder: "Paste your key here",
    field: "Your key",
    checking: "Checking the key",
    tipLabel: "Where to find the key",
    tip: "The button opens Cloudflare's page for new keys, with the name and permissions this page asks for. Create the key there, copy it and paste it here.",
    line: "The key can make your database, put VEMI in your Cloudflare account and give it an address, nothing more. This server never stores it.",
  },
  name: {
    title: "Name your copy", field: "Name", address: "Your address will be", checking: "Checking the name", build: "Build my VEMI",
    tipLabel: "About the name",
    tip: "Lowercase letters, numbers and dashes. The name is checked against the apps already in your Cloudflare account before anything is built.",
  },
  build: { title: "Building your VEMI", built: "Built", files: "Getting the VEMI files", again: "Try again", deploy: "Use the Deploy button instead" },
  update: {
    title: "Keep it up to date", switch: "Let my copy update itself", finish: "Finish", again: "Try again",
    tipLabel: "About the switch",
    tip: "On: your key is handed to your copy, which keeps it so it can update itself. Off: the key is not sent, and stays on Cloudflare until you remove it.",
  },
  done: {
    badge: "Done",
    title: "Your VEMI is ready",
    open: "Open my VEMI",
    kept: "Your copy can update itself.",
    tipLabel: "About updates",
    tip: "Your copy keeps the key you pasted, so it can update itself. You can update it from Account.",
    keyLeft: "VEMI could not remove your key. Remove the one named VEMI setup yourself.",
    keys: "Open my keys on Cloudflare",
  },
  next: "Next",
  back: "Back",
} as const;

export interface GetActions extends MoveActions {
  signUpOpened(): void;
  typeKey(text: string): void;
  pasteKey(): void;
  typeName(text: string): void;
  next(): void;
  back(): void;
  retry(): void;
  keepUpdated(on: boolean): void;
  finish(): void;
}

const ext = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * The dark side panel keeps the same dark ground in both themes. Its three colours are read from
 * the theme tables (the light table's ink, the dark table's ink and mid), so no colour is named here.
 */
const SIDE_COLOURS = { "--side-bg": THEMES.light.ink, "--side-ink": THEMES.dark.ink, "--side-mid": THEMES.dark.mid, "--side-dim": THEMES.dark.dim } as CSSProperties;

/** What the dark panel says beside each step: a headline (the accent word in `em`), one line, and the step's own label. */
interface Side {
  readonly lead: string;
  readonly accent: string;
  readonly tail: string;
  readonly line: string;
}

function sideFor(state: GetState): Side {
  switch (state.step) {
    case "account": return { lead: "Your own copy, in ", accent: "five", tail: " steps.", line: "Free on Cloudflare. You keep the account." };
    case "permission": return { lead: "One ", accent: "key", tail: ", nothing more.", line: "It can make your database, put VEMI in your account and give it an address." };
    case "name": return { lead: "Pick a ", accent: "name", tail: ".", line: "It becomes your address." };
    case "build":
    case "move":
      return canGoNext(state)
        ? { lead: "It is ", accent: "built", tail: ".", line: "One step left." }
        : { lead: "Building ", accent: "now", tail: ".", line: "Keep this page open until it finishes." };
    case "update": return { lead: "Stay ", accent: "up to date", tail: ".", line: "Choose whether your copy updates itself." };
    case "done":
      return state.move.kind === "ok"
        ? { lead: "Your stuff came ", accent: "with you", tail: ".", line: "Open it and carry on." }
        : { lead: "It is ", accent: "yours", tail: ".", line: "Open it, create your account, start." };
  }
}

function Dots({ step }: { step: FlowStep }): ReactElement | null {
  const at = NUMBERED_STEPS.indexOf(dotStep(step));
  if (at < 0) return null;
  return (
    <div className="get-dots" role="img" aria-label={`Step ${at + 1} of ${NUMBERED_STEPS.length}`}>
      {NUMBERED_STEPS.map((s, i) => <i key={s} className={i <= at ? "on" : ""} />)}
    </div>
  );
}

/** A step's own label under the dark panel's headline. */
const stepLabel = (step: FlowStep): string => {
  const at = NUMBERED_STEPS.indexOf(dotStep(step));
  return at < 0 ? "Done" : `Step ${at + 1} of ${NUMBERED_STEPS.length}`;
};

function Problem({ title, reason, children }: { title: string; reason: string; children?: ReactNode }): ReactElement {
  return (
    <div className="get-problem" role="alert">
      <b>{title}</b>
      <span>{reason}</span>
      {children}
    </div>
  );
}

function Nav({ state, on, last }: { state: GetState; on: GetActions; last?: string }): ReactElement {
  return (
    <div className="get-acts">
      <button type="button" className="get-primary" disabled={!canGoNext(state)} onClick={on.next}>
        {last ?? WORDS.next} <Icon name="lucide:arrow-right" size={18} />
      </button>
      <button type="button" className="get-link" onClick={on.back}>{WORDS.back}</button>
    </div>
  );
}

function Account({ state, on }: { state: GetState; on: GetActions }): ReactElement {
  return (
    <section className="get-step" aria-labelledby="get-h">
      <h1 id="get-h">{WORDS.account.title}</h1>
      <p className="get-lede">{WORDS.account.line}</p>
      <div className="get-acts">
        <a className="get-primary" href={SIGN_UP_LINK} {...ext} onClick={on.signUpOpened}>
          {WORDS.account.make} <Icon name="lucide:external-link" size={18} />
        </a>
        <button type="button" className={state.signUpOpened ? "get-secondary" : "get-link"} onClick={on.next}>{WORDS.account.have}</button>
      </div>
    </section>
  );
}

function Permission({ state, on }: { state: GetState; on: GetActions }): ReactElement {
  const check = state.keyCheck;
  return (
    <section className="get-step" aria-labelledby="get-h">
      <h1 id="get-h">{WORDS.permission.title}</h1>
      <p className="get-lede">{WORDS.permission.lede}</p>
      <div className="get-acts">
        <a className="get-primary" href={tokenLink()} {...ext}>
          {WORDS.permission.open} <Icon name="lucide:external-link" size={18} />
        </a>
      </div>
      <div className="get-field">
        <div className="get-label">
          <label htmlFor="get-key">{WORDS.permission.field}</label>
          <InfoTip label={WORDS.permission.tipLabel}>{WORDS.permission.tip}</InfoTip>
        </div>
        <div className="get-paste">
          <input
            id="get-key"
            type="text"
            value={state.key}
            placeholder={WORDS.permission.placeholder}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => on.typeKey(e.target.value)}
          />
          <button type="button" className="get-secondary" onClick={on.pasteKey}>{WORDS.permission.paste}</button>
        </div>
        <div className="get-status" aria-live="polite">
          {check.kind === "checking" && <p className="get-quiet">{WORDS.permission.checking}</p>}
          {check.kind === "ok" && (
            <p className="get-ok"><Icon name="lucide:check" size={18} /><span>Connected to {check.accountName}</span></p>
          )}
          {check.kind === "bad" && <Problem title="That key did not work" reason={check.reason} />}
        </div>
      </div>
      <p className="get-hint"><Icon name="lucide:lock" size={16} /><span>{WORDS.permission.line}</span></p>
      <Nav state={state} on={on} />
    </section>
  );
}

function Name({ state, on }: { state: GetState; on: GetActions }): ReactElement {
  const check = state.nameCheck;
  return (
    <section className="get-step" aria-labelledby="get-h">
      <h1 id="get-h">{WORDS.name.title}</h1>
      <div className="get-field">
        <div className="get-label">
          <label htmlFor="get-name">{WORDS.name.field}</label>
          <InfoTip label={WORDS.name.tipLabel}>{WORDS.name.tip}</InfoTip>
        </div>
        <input id="get-name" type="text" value={state.name} maxLength={40} autoComplete="off" spellCheck={false} onChange={(e) => on.typeName(e.target.value)} />
        <div className="get-address" aria-live="polite">
          {check.kind === "ok" && (<>{WORDS.name.address}<br /><b>{check.address.replace(/^https:\/\//, "")}</b></>)}
          {check.kind === "checking" && <span className="get-quiet">{WORDS.name.checking}</span>}
          {(check.kind === "idle" || check.kind === "bad") && <span className="get-quiet">{WORDS.name.address}</span>}
        </div>
      </div>
      {check.kind === "bad" && <Problem title="That name will not work" reason={check.reason} />}
      {state.withMove && <MoveLogin state={state} on={on} />}
      <Nav state={state} on={on} last={WORDS.name.build} />
    </section>
  );
}

function Row({ row }: { row: { state: RowState; label: string; note: string } }): ReactElement {
  return (
    <li className={`get-row ${row.state}`}>
      <span className="get-tick" aria-hidden="true">
        {row.state === "ok" ? <Icon name="lucide:check" size={14} /> : row.state === "bad" ? "!" : ""}
      </span>
      <span><b>{row.label}</b><small>{row.note}</small></span>
      <span className="get-state">{row.state === "ok" ? "done" : row.state === "run" ? "working" : ""}</span>
    </li>
  );
}

function Build({ state, on, loading }: { state: GetState; on: GetActions; loading: string | null }): ReactElement {
  const rows = buildRows(state.build);
  const finished = canGoNext(state);
  const failed = state.build.reason !== null;
  const copy = state.withMove ? moveRow(state) : null;
  const moveBad = state.move.kind === "bad" ? state.move.reason : null;
  const moveFinal = state.move.kind === "bad" && state.move.final === true;
  const total = rows.length + (copy === null ? 0 : 1);
  const percent = Math.round(((state.build.done.length + (copy?.state === "ok" ? 1 : 0)) / total) * 100);
  return (
    <section className="get-step" aria-labelledby="get-h">
      <h1 id="get-h">{finished ? WORDS.build.built : WORDS.build.title}</h1>
      <div className="get-meter" aria-hidden="true"><i style={{ width: `${percent}%` }} /></div>
      {loading !== null && !failed && <p className="get-quiet">{loading}</p>}
      <ul className="get-build">
        {rows.map((row) => <Row key={row.step} row={row} />)}
        {copy !== null && <Row key="move" row={copy} />}
      </ul>
      {state.step === "move" && <MoveMissing state={state} on={on} />}
      {state.move.kind === "key" && <MoveKey keys={state.move.keys} problem={state.move.reason} onProve={on.proveKey} />}
      {moveBad !== null && (
        <Problem title={`Something stopped at ${MOVE_ROW.label.toLowerCase()}`} reason={moveBad}>
          <div className="get-acts">
            {moveFinal && state.address !== null
              ? <a className="get-primary" href={state.address}>Open your copy</a>
              : <button type="button" className="get-primary" onClick={on.retry}>{WORDS.build.again}</button>}
          </div>
        </Problem>
      )}
      {failed && (
        <Problem title={state.build.failed !== null ? `Something stopped at ${rows.find((r) => r.step === state.build.failed)?.label.toLowerCase() ?? "a step"}` : "Something stopped the build"} reason={state.build.reason ?? ""}>
          <div className="get-acts">
            <button type="button" className="get-primary" onClick={on.retry}>{WORDS.build.again}</button>
            <a className="get-secondary" href={DEPLOY_LINK} {...ext}>{WORDS.build.deploy}</a>
          </div>
        </Problem>
      )}
      <div className="get-acts">
        <button type="button" className="get-primary" disabled={!finished} onClick={on.next}>{WORDS.next} <Icon name="lucide:arrow-right" size={18} /></button>
      </div>
    </section>
  );
}

function Update({ state, on }: { state: GetState; on: GetActions }): ReactElement {
  const working = state.finish.kind === "working";
  return (
    <section className="get-step" aria-labelledby="get-h">
      <h1 id="get-h">{WORDS.update.title}</h1>
      <div className="get-toggle">
        <span className="get-toggle-label">
          <b id="get-switch-label">{WORDS.update.switch}</b>
          <InfoTip label={WORDS.update.tipLabel}>{WORDS.update.tip}</InfoTip>
        </span>
        <button
          type="button"
          role="switch"
          className="get-switch"
          aria-checked={state.keepUpdated}
          aria-labelledby="get-switch-label"
          onClick={() => on.keepUpdated(!state.keepUpdated)}
        />
      </div>
      {state.finish.kind === "bad" && <Problem title="The hand-over did not finish" reason={state.finish.reason} />}
      <div className="get-acts">
        <button type="button" className="get-primary" disabled={working} onClick={on.finish}>
          {state.finish.kind === "bad" ? WORDS.update.again : WORDS.update.finish} <Icon name="lucide:arrow-right" size={18} />
        </button>
      </div>
    </section>
  );
}

function Done({ state }: { state: GetState }): ReactElement {
  const address = state.address ?? "";
  return (
    <section className="get-step" aria-labelledby="get-h">
      <span className="get-badge"><Icon name="lucide:check" size={14} />{WORDS.done.badge}</span>
      <h1 id="get-h">{WORDS.done.title}</h1>
      <p className="get-address"><b>{address.replace(/^https:\/\//, "")}</b></p>
      {state.move.kind === "ok" ? <MoveDone state={state} /> : (
        <div className="get-acts">
          <a className="get-primary" href={openLinkFor(state)}>{WORDS.done.open} <Icon name="lucide:external-link" size={18} /></a>
        </div>
      )}
      {state.kept === true && (
        <p className="get-hint">
          <span>{WORDS.done.kept}</span>
          <InfoTip label={WORDS.done.tipLabel}>{WORDS.done.tip}</InfoTip>
        </p>
      )}
      {state.kept === false && (
        <div className="get-key-left">
          <p className="get-hint"><Icon name="lucide:lock" size={16} /><span>{WORDS.done.keyLeft}</span></p>
          <a className="get-secondary" href={KEY_LIST_LINK} {...ext}>{WORDS.done.keys}</a>
        </div>
      )}
    </section>
  );
}

/** One screen, from state alone. The container below owns the effects. */
export function GetScreen({ state, on, loading = null }: { state: GetState; on: GetActions; loading?: string | null }): ReactElement {
  const side = sideFor(state);
  return (
    <div className="get-page">
      <aside className="get-side" style={SIDE_COLOURS}>
        <span className="get-mark" role="img" aria-label="VEMI" />
        <div>
          <p className="get-headline">{side.lead}<em>{side.accent}</em>{side.tail}</p>
          <p className="get-sub">{side.line}</p>
        </div>
        <small className="get-side-note" aria-hidden="true">{stepLabel(state.step)}</small>
      </aside>
      <main className="get-main">
        <div className="get-panel">
          <Dots step={state.step} />
          {state.step === "account" && <Account state={state} on={on} />}
          {state.step === "permission" && <Permission state={state} on={on} />}
          {state.step === "name" && <Name state={state} on={on} />}
          {(state.step === "build" || state.step === "move") && <Build state={state} on={on} loading={loading} />}
          {state.step === "update" && <Update state={state} on={on} />}
          {state.step === "done" && <Done state={state} />}
        </div>
      </main>
    </div>
  );
}

// ----- the container -----

function readSaved(): ReturnType<typeof restore> {
  try {
    return restore(window.sessionStorage.getItem(SAVED_KEY), Date.now());
  } catch {
    return null;
  }
}

function keep(text: string): void {
  try {
    window.sessionStorage.setItem(SAVED_KEY, text);
  } catch {
    // A browser that will not keep it simply starts at the first step next time.
  }
}

const sentence = (error: unknown): string => (error instanceof SetupError ? error.message : "Something went wrong. Try again.");

const KEY_WAIT_MS = 250;
const NAME_WAIT_MS = 350;

/** `source`: what to copy into the new copy, when the page was opened with something to move. */
export function GetFlow({ source: given }: { source?: MoveSource } = {}): ReactElement {
  const [state, dispatch] = useReducer(reduce, undefined, () => initial(readSaved(), given !== undefined, fromOldAccount(window.location.search), fromLocalMode(window.location.search)));
  const source = useRef<MoveSource | null>(given ?? null);
  const moving = useRef(false);
  /** The file as read for this move, and whether one of its own ways in has opened its key. Memory only. */
  const filed = useRef<{ document: Record<string, unknown>; proved: boolean } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const live = useRef(state);
  live.current = state;
  /** What one key has made: its relay, its client, and the manifest read so far. */
  const session = useRef<{ key: string; api: Cloudflare } | null>(null);
  const manifest = useRef<Promise<ReleaseManifest> | null>(null);
  const running = useRef(false);

  const apiFor = (key: string): Cloudflare => {
    if (session.current?.key === key) return session.current.api;
    const relay = createRelayFetch({ token: key });
    const api = createCloudflare({ fetch: relay.fetch, token: key });
    session.current = { key, api };
    return api;
  };
  const release = (): Promise<ReleaseManifest> => {
    manifest.current ??= loadManifest().catch((error: unknown) => {
      manifest.current = null;
      throw error;
    });
    return manifest.current;
  };

  // What a closed tab keeps: the step, the name and the address.
  useEffect(() => {
    keep(saveText(toSaved(state), Date.now()));
  }, [state.step, state.name, state.address]);

  // The key, checked as it arrives.
  useEffect(() => {
    const key = state.key;
    if (key === "") return;
    const problem = keyProblem(key);
    if (problem !== null) {
      dispatch({ type: "keyChecked", key, check: { kind: "bad", reason: problem } });
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const accounts = await apiFor(key).listAccounts();
          const first = accounts[0];
          if (!current) return;
          if (first === undefined) dispatch({ type: "keyChecked", key, check: { kind: "bad", reason: "That key cannot see a Cloudflare account." } });
          else dispatch({ type: "keyChecked", key, check: { kind: "ok", accountId: first.id, accountName: first.name } });
        } catch (error) {
          if (current) dispatch({ type: "keyChecked", key, check: { kind: "bad", reason: sentence(error) } });
        }
      })();
    }, KEY_WAIT_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [state.key]);

  // The name, checked for a clash, with the address it will have.
  useEffect(() => {
    if (state.step !== "name" || state.keyCheck.kind !== "ok" || nameProblem(state.name) !== null) return;
    const { key } = state;
    const { accountId } = state.keyCheck;
    const name = nameFrom(state.name);
    let current = true;
    dispatch({ type: "nameChecking" });
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const light = lightBundle(await release());
          const result = await createBuild({ api: apiFor(key), accountId, name, from: window.location.origin, claim: "", bundle: light }).preflight();
          if (!current) return;
          dispatch({ type: "nameChecked", name, check: result.ok ? { kind: "ok", address: result.address ?? "" } : { kind: "bad", reason: result.reason } });
        } catch (error) {
          if (current) dispatch({ type: "nameChecked", name, check: { kind: "bad", reason: sentence(error) } });
        }
      })();
    }, NAME_WAIT_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [state.step, state.name, state.keyCheck.kind]);

  // The build: starts on arriving at its step, and again on Try again. Safe to run again.
  useEffect(() => {
    const now = live.current;
    if (now.step !== "build" || now.keyCheck.kind !== "ok" || nameProblem(now.name) !== null || running.current) return;
    if (now.address !== null && now.build.done.length === 6) return;
    running.current = true;
    const { key } = now;
    const { accountId } = now.keyCheck;
    const name = nameFrom(now.name);
    dispatch({ type: "buildStarted" });
    void (async () => {
      try {
        const bundle = await loadBundle(await release(), undefined, (done, total) => setLoading(`${WORDS.build.files}, ${done} of ${total}`));
        setLoading(null);
        const claim = await claimFor(accountId, name);
        const build = createBuild({ api: apiFor(key), accountId, name, from: window.location.origin, claim, bundle });
        const outcome = await build.run(live.current.build.done, (step, s) => dispatch({ type: "buildStep", step, state: s }));
        if (outcome.ok) dispatch({ type: "buildDone", address: outcome.address });
        else dispatch({ type: "buildFailed", step: outcome.step, reason: outcome.reason });
      } catch (error) {
        setLoading(null);
        dispatch({ type: "buildFailed", step: null, reason: sentence(error) });
      } finally {
        running.current = false;
      }
    })();
  }, [state.step, state.keyCheck.kind, round]);

  // The move: starts once the file, the email and the password are all in hand, and again on Try again.
  useEffect(() => {
    const now = live.current;
    const from = source.current;
    if (!canMove(now) || from === null || now.address === null || now.keyCheck.kind !== "ok" || moving.current) return;
    moving.current = true;
    const { address, email, password } = now;
    const { accountId } = now.keyCheck;
    dispatch({ type: "moveStarted" });
    void (async () => {
      try {
        const read = await from.read();
        const document = typeof read === "object" && read !== null && !Array.isArray(read) ? (read as Record<string, unknown>) : null;
        const held = document === null ? null : lockedHeld(document);
        const finish = held !== null && needsKey(held);
        if (document !== null && finish && filed.current?.proved !== true) {
          // The key opens before anything is sent, so a move that could never be finished is not started.
          filed.current = { document, proved: false };
          dispatch({ type: "moveNeedsKey", keys: held.keys });
          return;
        }
        const code = await claimFor(accountId, nameFrom(now.name));
        const result = await moveToCloud({ address, code, email, password, source: document === null ? from : { read: () => Promise.resolve(document) }, finish });
        if (result.ok) {
          filed.current = null;
          dispatch({
            type: "moveDone", counts: result.counts, recoveryCode: result.recoveryCode, openLink: result.openLink,
            levelNames: result.levelNames, ids: result.ids, locked: held === null ? 0 : held.locked + held.typed,
          });
        } else {
          dispatch({ type: "moveFailed", reason: result.reason, ...(result.final === true ? { final: true as const } : {}) });
        }
      } catch {
        dispatch({ type: "moveFailed", reason: "Something went wrong. Try again." });
      } finally {
        moving.current = false;
      }
    })();
  }, [state.step, state.hasSource, state.email, state.password, state.move.kind, round]);

  const on: GetActions = {
    typeEmail: (text) => dispatch({ type: "emailTyped", email: text }),
    typePassword: (text) => dispatch({ type: "passwordTyped", password: text }),
    proveKey: (way) => {
      const read = filed.current;
      if (read === null) return;
      void (async () => {
        try {
          await openBeforeSend("file", read.document, way);
          filed.current = { document: read.document, proved: true };
          dispatch({ type: "keyProved" });
        } catch (error) {
          dispatch({ type: "keyFailed", reason: error instanceof Error ? error.message : "That did not open the key." });
        }
      })();
    },
    pickFile: (file) => {
      filed.current = null;
      source.current = fileSource(file);
      dispatch({ type: "sourceChosen" });
    },
    signUpOpened: () => dispatch({ type: "signUpOpened" }),
    typeKey: (text) => dispatch({ type: "keyTyped", key: text }),
    pasteKey: () => {
      void (async () => {
        try {
          dispatch({ type: "keyTyped", key: await navigator.clipboard.readText() });
        } catch {
          // The browser would not hand over the clipboard; pasting into the box still works.
        }
      })();
    },
    typeName: (text) => dispatch({ type: "nameTyped", name: text }),
    next: () => dispatch({ type: "next" }),
    back: () => dispatch({ type: "back" }),
    retry: () => {
      // On the move's step Try again repeats only the move; the build is not touched.
      if (live.current.step === "move") dispatch({ type: "moveReset" });
      else dispatch({ type: "buildStarted" });
      setRound((n) => n + 1);
    },
    keepUpdated: (value) => dispatch({ type: "keepUpdated", on: value }),
    finish: () => {
      const now = live.current;
      const address = now.address;
      if (address === null || now.keyCheck.kind !== "ok") return;
      const { accountId } = now.keyCheck;
      dispatch({ type: "finishing" });
      void (async () => {
        const code = await claimFor(accountId, nameFrom(now.name));
        const result = await handOver({ address, code, token: now.key, keepUpdated: now.keepUpdated });
        if (result.ok) dispatch({ type: "finished", kept: now.keepUpdated });
        else dispatch({ type: "finishFailed", reason: result.reason });
      })();
    },
  };

  return <GetScreen state={state} on={on} loading={loading} />;
}

