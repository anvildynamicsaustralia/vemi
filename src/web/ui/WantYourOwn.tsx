import type { ReactElement } from "react";

/**
 * The card an invited account sees in Your data. Export makes the file; Get my own VEMI is a plain
 * link to the helper, which asks for that file. Nothing is sent from here: the link carries only
 * the one word that says where the person came from, and the file stays on their device.
 */
export const WANT_OWN = {
  title: "Want your own VEMI?",
  note: "Have your own private copy, free, in about 5 minutes. Everything comes with you.",
  export: "Export",
  get: "Get my own VEMI",
  href: "/get/?from=old",
} as const;

export function WantYourOwn({ busy, onExport }: { readonly busy: boolean; readonly onExport: () => void }): ReactElement {
  return (
    <div className="account-row">
      <span className="account-row-title">
        {WANT_OWN.title}
        <span className="account-row-note">{WANT_OWN.note}</span>
      </span>
      <span className="account-row-actions">
        <button type="button" className="row-action" disabled={busy} onClick={onExport}>{WANT_OWN.export}</button>
        <a className="row-action" href={WANT_OWN.href}>{WANT_OWN.get}</a>
      </span>
    </div>
  );
}
