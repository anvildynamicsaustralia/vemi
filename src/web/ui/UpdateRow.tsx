import { useCallback, useEffect, useRef, useState } from "react";
import { UPDATE_DOCS } from "../../shared/releaseKey.js";
import { Status, type StatusKind } from "./Switch.js";
import { updateApi, type UpdateApi, type UpdateReport, type UpdateStep } from "../updateApi.js";
import { driveUpdate, keepStep, keptStep, rowsOf, type RunState } from "../updateRun.js";

const WORDS = { waiting: "Waiting", active: "Working", done: "Done", failed: "Stopped" } as const;

/** Each step's state as the kind of status it wears: a dot, and the word beside it. */
const KINDS: Record<keyof typeof WORDS, StatusKind> = { waiting: "waiting", active: "working", done: "done", failed: "stopped" };

/**
 * What the update rows show for a report and a run. `run` is null until an update is under way.
 * The notes are the release's own text and are drawn as text, never as markup.
 */
export function UpdateView({ report, run, onUpdate, onRetry }: {
  readonly report: UpdateReport | null;
  readonly run: RunState | null;
  readonly onUpdate: () => void;
  readonly onRetry: () => void;
}) {
  if (report === null || report.offer === null) return null;
  const { version, notes } = report.offer;

  if (run?.done === true) {
    return (
      <div className="account-row">
        <span className="account-row-title">Updated to {version}</span>
      </div>
    );
  }

  return (
    <>
      <div className="account-row">
        <span className="account-row-title">
          Update available: {version}
          {notes !== "" && <span className="account-row-note update-notes">{notes}</span>}
        </span>
        {run === null && report.canUpdate && <button type="button" className="row-action" onClick={onUpdate}>Update</button>}
        {run === null && !report.canUpdate && (
          <a className="row-action" href={UPDATE_DOCS} target="_blank" rel="noreferrer noopener">How to update</a>
        )}
      </div>
      {run !== null && rowsOf(run).map((row) => (
        <div className="account-row" key={row.step} data-state={row.state}>
          <span className="account-row-title">{row.label}</span>
          <span className="account-row-note"><Status kind={KINDS[row.state]}>{row.state === "failed" && run.error !== null ? run.error : WORDS[row.state]}</Status></span>
        </div>
      ))}
      {run?.error != null && (
        <div className="account-row">
          <span className="account-row-title">Try again</span>
          <button type="button" className="row-action" onClick={onRetry}>Try again</button>
        </div>
      )}
    </>
  );
}

/**
 * The Update rows under Version. Reads the offer from the Worker, drives the update when the owner
 * taps Update, and carries on from the stored step when the tab is reopened mid-update. When the run
 * ends the page reloads once, so the new version is the one running.
 */
export function UpdateRow({ api, reload = () => globalThis.location.reload() }: {
  readonly api?: UpdateApi;
  readonly reload?: () => void;
}) {
  const [client] = useState(() => api ?? updateApi());
  const [report, setReport] = useState<UpdateReport | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const driving = useRef(false);
  const reloaded = useRef(false);

  const drive = useCallback((version: string, from: UpdateStep): void => {
    if (driving.current) return;
    driving.current = true;
    void driveUpdate(client, from, {
      on: setRun,
      keep: (step) => keepStep(version, step),
    }).then((end) => {
      driving.current = false;
      if (end.done && !reloaded.current) {
        reloaded.current = true;
        reload();
      }
    });
  }, [client, reload]);

  useEffect(() => {
    let live = true;
    client.report().then((found) => {
      if (!live) return;
      setReport(found);
      if (found.offer === null || !found.canUpdate) return;
      const kept = keptStep(found.offer.version);
      if (kept !== null) drive(found.offer.version, kept);
    }, () => undefined);
    return () => { live = false; };
  }, [client, drive]);

  const version = report?.offer?.version ?? "";
  return (
    <UpdateView
      report={report}
      run={run}
      onUpdate={() => drive(version, "start")}
      onRetry={() => drive(version, run?.at ?? "start")}
    />
  );
}
