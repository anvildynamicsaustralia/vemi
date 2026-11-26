import { useRef, useState, type ReactElement } from "react";
import { paths } from "../api.js";
import { fetchExport } from "../exportLocked.js";
import { askCopy, tableCounts } from "../moveIntoCopy.js";
import { moveLines } from "../../shared/moveCounts.js";
import { levelWords, type LevelNames } from "../levelWords.js";
import { ClearDevice } from "./ClearDevice.js";

export type MovePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "preview"; readonly here: readonly string[]; readonly there: readonly string[] }
  | { readonly kind: "done"; readonly moved: readonly string[] }
  | { readonly kind: "stopped"; readonly reason: string };

/** The helper's page, where the move to a new copy starts. */
export const LOCAL_MOVE = "Move to my own cloud";
export const LOCAL_MOVE_HREF = "/get/?from=local";
export const HAVE_A_COPY = "I already have a copy";
const REPLACES = "This replaces what is in that copy";
const MOVED_KEY = "vemi:moved";

/** The counts in the person's own level names, which the export carries in its settings. */
export function lines(counts: Readonly<Record<string, number>>, document: Readonly<Record<string, unknown>>): string[] {
  const settings = document["settings"];
  const raw = typeof settings === "object" && settings !== null ? (settings as Record<string, unknown>)["levelNames"] : null;
  const given = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = (key: keyof LevelNames): string | undefined => (typeof given[key] === "string" ? (given[key] as string) : undefined);
  const names: Partial<LevelNames> = { space: pick("space"), project: pick("project"), milestone: pick("milestone"), task: pick("task") };
  return moveLines(counts, levelWords(names));
}

/** The card as the person sees it. Drawn from a phase, so every state can be seen without a copy to move into. */
export function MoveStartView({ phase, open, address, code, word, busy, onOpen, onAddress, onCode, onWord, onCheck, onReplace, onOpened }: {
  readonly phase: MovePhase;
  readonly open: boolean;
  readonly address: string;
  readonly code: string;
  readonly word: string;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onAddress: (text: string) => void;
  readonly onCode: (text: string) => void;
  readonly onWord: (text: string) => void;
  readonly onCheck: () => void;
  readonly onReplace: () => void;
  /** The person has opened their new copy; offered only when the page can keep that. */
  readonly onOpened?: () => void;
}): ReactElement {
  return (
    <>
      <div className="account-row">
        <a className="account-row-title" href={LOCAL_MOVE_HREF}>{LOCAL_MOVE}</a>
        <span className="account-row-actions">
          <button type="button" className="row-action" onClick={onOpen}>{HAVE_A_COPY}</button>
          {onOpened !== undefined && <button type="button" className="row-action" onClick={onOpened}>I have opened my new copy</button>}
        </span>
      </div>
      {open && phase.kind !== "done" && (
        <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && phase.kind !== "preview") onCheck(); }}>
          <input className="field" type="text" autoComplete="off" aria-label="Copy address" placeholder="https://"
            value={address} onChange={(e) => onAddress(e.target.value)} />
          <input className="field" type="text" autoComplete="off" aria-label="Move code"
            value={code} onChange={(e) => onCode(e.target.value)} />
          <button type="submit" className="primary-button" disabled={busy || address.trim() === "" || code.trim() === ""}>Check that copy</button>
        </form>
      )}
      {open && phase.kind === "preview" && (
        <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && word === "replace") onReplace(); }}>
          <div className="account-row-title">{REPLACES}</div>
          <div className="account-row-title">On this device</div>
          <ul className="code-list">{phase.here.map((line) => <li key={line}>{line}</li>)}</ul>
          <div className="account-row-title">In that copy now</div>
          <ul className="code-list">{phase.there.map((line) => <li key={line}>{line}</li>)}</ul>
          <input className="field" type="text" autoComplete="off" aria-label="Type replace to move" placeholder="replace"
            value={word} onChange={(e) => onWord(e.target.value)} />
          <button type="submit" className="primary-button" disabled={busy || word !== "replace"}>Replace that copy</button>
        </form>
      )}
      {open && phase.kind === "done" && (
        <div className="account-form" role="status">
          <div className="account-row-title">Moved</div>
          <ul className="code-list">{phase.moved.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      )}
      {phase.kind === "stopped" && <div className="error" role="alert">{phase.reason}</div>}
    </>
  );
}

function readMark(): boolean {
  try {
    return window.localStorage.getItem(MOVED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMark(): void {
  try {
    window.localStorage.setItem(MOVED_KEY, "1");
  } catch {
    // A browser that refuses its storage only loses the banner's memory.
  }
}

/**
 * Local mode's move card: the helper, and moving into a copy the person already has. The device
 * keeps its data; the banner to clear it shows only after a move here or the person's own word
 * that the new copy is open.
 */
export function MoveStart({ read = () => fetchExport(paths.export), send = askCopy }: {
  readonly read?: () => Promise<Record<string, unknown>>;
  readonly send?: typeof askCopy;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<MovePhase>({ kind: "idle" });
  const [moved, setMoved] = useState(readMark);
  const document = useRef<Record<string, unknown> | null>(null);

  const stop = (reason: string): void => setPhase({ kind: "stopped", reason });

  const check = (): void => {
    setBusy(true);
    void (async () => {
      try {
        const doc = await read();
        document.current = doc;
        const answer = await send({ address, code: code.trim(), document: doc, confirm: false });
        if (!answer.ok) return stop(answer.reason);
        setWord("");
        setPhase({ kind: "preview", here: lines(tableCounts(doc), doc), there: lines(answer.holds, doc) });
      } catch {
        stop("Couldn't read what is on this device. Try again.");
      } finally {
        setBusy(false);
      }
    })();
  };

  const replace = (): void => {
    const doc = document.current;
    if (doc === null) return;
    setBusy(true);
    void (async () => {
      try {
        const answer = await send({ address, code: code.trim(), document: doc, confirm: true });
        if (!answer.ok) return stop(answer.reason);
        writeMark();
        setMoved(true);
        setPhase({ kind: "done", moved: lines(answer.counts, doc) });
      } catch {
        stop("That copy would not take that. Try again.");
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <>
      <MoveStartView phase={phase} open={open} address={address} code={code} word={word} busy={busy}
        onOpen={() => setOpen((was) => !was)} onAddress={setAddress} onCode={setCode} onWord={setWord}
        onCheck={check} onReplace={replace}
        {...(moved ? {} : { onOpened: () => { writeMark(); setMoved(true); } })} />
      {moved && <ClearDevice />}
    </>
  );
}
