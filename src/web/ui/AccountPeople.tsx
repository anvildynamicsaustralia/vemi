import { useCallback, useEffect, useMemo, useState } from "react";
import { qrMatrix, qrSvg } from "@vemi/shared";
import { invitePerson, people, removePerson, resetPersonLink, withdrawPerson } from "../auth.js";
import { peopleRows, type PeopleAction, type PeopleList, type Row } from "../peopleRows.js";
import { useApp } from "./appContext.js";

type Where = "invite" | "list";

const NOBODY: PeopleList = { people: [], invites: [] };

/** The QR code for a link, or null when it is too long to draw. */
function qrFor(link: string): string | null {
  try {
    return qrSvg(qrMatrix(link));
  } catch {
    return null;
  }
}

const LABEL: Readonly<Record<PeopleAction, string>> = { reset: "Reset link", remove: "Remove", withdraw: "Withdraw" };

/** Account > People: a first name makes a link to pass on, and the list of who joined or is waiting. Owner only. */
export function AccountPeople() {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<PeopleList>(NOBODY);
  const [name, setName] = useState("");
  // The link the Worker made last, for the owner to pass on: copied or scanned.
  const [made, setMade] = useState<{ readonly title: string; readonly link: string } | null>(null);
  const [problem, setProblem] = useState<{ readonly where: Where; readonly text: string } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setList(await people());
    } catch {
      // No connection: the list stays as it was.
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const attempt = async (where: Where, work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem({ where, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  const problemAt = (where: Where) => problem?.where === where && <div className="error" role="alert">{problem.text}</div>;

  const makeLink = (): Promise<void> => attempt("invite", async () => {
    const first = name.trim();
    setMade({ title: first, link: await invitePerson(first) });
    setName("");
    await refresh();
  });

  const act = (action: PeopleAction, row: Row): Promise<void> => attempt("list", async () => {
    if (action === "reset") {
      setMade({ title: row.title, link: await resetPersonLink(row.id) });
    } else if (action === "remove") {
      await removePerson(row.id);
      app.notify(`${row.title} will go in 7 days. Their link and sign-in still work until then.`);
    } else {
      await withdrawPerson(row.id);
      app.notify(`Invite for ${row.title} withdrawn. Its link no longer works.`);
    }
    await refresh();
  });

  const copyLink = async (): Promise<void> => {
    if (made === null) return;
    try {
      await navigator.clipboard.writeText(made.link);
      app.notify("Link copied.");
    } catch {
      app.notify("Could not copy. Select the link and copy it.");
    }
  };

  const rows = useMemo(() => peopleRows(list), [list]);
  const qr = useMemo(() => (made === null ? null : qrFor(made.link)), [made]);

  return (
    <div className="account-rows">
      <div className="account-row">
        <span className="account-row-title">Invite someone</span>
      </div>
      <form className="account-form" onSubmit={(e) => { e.preventDefault(); if (!busy && name.trim() !== "") void makeLink(); }}>
        <input className="field" type="text" autoComplete="off" maxLength={60} placeholder="First name" aria-label="First name"
          value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="primary-button" disabled={busy || name.trim() === ""}>Make invite link</button>
        {problemAt("invite")}
      </form>
      {made !== null && (
        <div className="account-row">
          <span className="account-row-title">Link for {made.title}</span>
          <input className="field" readOnly aria-label="Link" value={made.link} onFocus={(e) => e.currentTarget.select()} />
          <span className="account-row-actions">
            <button type="button" className="row-action" onClick={() => void copyLink()}>Copy</button>
          </span>
          {qr !== null && (
            <div className="account-form">
              <div className="qr" role="img" aria-label={`QR code for ${made.title}'s link`} dangerouslySetInnerHTML={{ __html: qr }} />
            </div>
          )}
        </div>
      )}
      {rows.map((row) => (
        <div className="account-row" key={row.key}>
          <span className="account-row-title">{row.title}</span>
          <span className="account-row-note">{row.note}</span>
          <span className="account-row-actions">
            {row.actions.map((action) => (
              <button key={action} type="button" className={action === "reset" ? "row-action" : "row-action quiet"} disabled={busy}
                onClick={() => void act(action, row)}>{LABEL[action]}</button>
            ))}
          </span>
        </div>
      ))}
      {problemAt("list")}
    </div>
  );
}
