import { useCallback, useEffect, useState, type ReactNode } from "react";
import { refreshAppearance } from "../appearance.js";
import { me } from "../auth.js";
import { landedPair } from "../pairLink.js";
import type { Me } from "../auth.js";
import { isLocal, LOCAL_KEY_NAME } from "../local/mode.js";
import { openSection, PRIVACY_READY, visibleSections, type Section, type SectionId } from "../accountSections.js";
import type { LiveStatus } from "../state/live.js";
import { refreshNewTaskVenture, useApp } from "./appContext.js";
import { Monogram, SurfaceKicker } from "./Chrome.js";
import { MoreMenu } from "./Menu.js";
import { useMedia, PHONE } from "./useMedia.js";
import "./account.css";
import "./detail.css";
import { AccountAbout } from "./AccountAbout.js";
import { AccountAi } from "./AccountAi.js";
import { AccountData } from "./AccountData.js";
import { AccountExtras } from "./AccountExtras.js";
import { AccountLook } from "./AccountLook.js";
import { AccountNames } from "./AccountNames.js";
import { AccountPeople } from "./AccountPeople.js";
import { AccountPrivacy } from "./AccountPrivacy.js";
import { AccountProfile } from "./AccountProfile.js";
import { AccountProfileLocal } from "./AccountProfileLocal.js";
import { AccountReminders } from "./AccountReminders.js";

/**
 * The sections and the open one. A desk draws a side list and the open section's panel; a
 * phone draws the list, then one section under a back link. Pure: the panel arrives drawn.
 */
export function AccountLayout({ shown, open, phone, onOpen, panel }: {
  readonly shown: readonly Section[];
  readonly open: SectionId | null;
  readonly phone: boolean;
  readonly onOpen: (id: SectionId | null) => void;
  readonly panel: ReactNode;
}) {
  const title = shown.find((s) => s.id === open)?.title ?? null;
  const nav = (
    <nav className="account-nav" aria-label="Account sections">
      {shown.map((s) => (
        <button key={s.id} type="button" aria-current={open === s.id} onClick={() => onOpen(s.id)}>{s.title}</button>
      ))}
    </nav>
  );
  return (
    <div className={phone ? "account-layout account-phone" : "account-layout"}>
      {(!phone || open === null) && nav}
      {open !== null && (
        <div className="account-panel">
          {phone && <button type="button" className="back-link" onClick={() => onOpen(null)}>{"‹ Account"}</button>}
          <h2 className="account-panel-title" id="account-panel-title">{title}</h2>
          <section className="group" aria-labelledby="account-panel-title">{panel}</section>
        </div>
      )}
    </div>
  );
}

export function Account({ onClose, onSignOut, live, waiting, known, onKnown }: {
  readonly onClose: () => void;
  /** Signs this device out, and forgets what it kept and what was waiting to send. */
  readonly onSignOut: () => Promise<void>;
  readonly live: LiveStatus;
  readonly waiting: number;
  /** Who the shell last heard is signed in, so the panel opens drawn; null if it never heard. */
  readonly known: Me | null;
  /** Hands the shell the panel's fresher answer, so the next opening starts from it. */
  readonly onKnown: (m: Me) => void;
}) {
  const app = useApp();
  const phone = useMedia(PHONE);
  // The panel may open on a device another account used last; the account's own answer wins.
  useEffect(() => { void refreshAppearance(); void refreshNewTaskVenture(); }, []);
  // Who is signed in: what the shell already knew, then the Worker's fresh answer. Unknown
  // (no connection, and never known) shows only the rows that need no Worker.
  const [who, setWho] = useState<Me | null>(known);
  useEffect(() => { if (known !== null) setWho((was) => was ?? known); }, [known]);
  // Whether the Worker has been asked yet. Until it answers, a panel the shell could not draw
  // from holds the rows that wait on it in place, actions disabled, so it does not jump.
  const [asked, setAsked] = useState(false);
  // A pairing link opens Privacy and security, where the device that holds the key is asked.
  const [chosen, setChosen] = useState<SectionId | null>(() => (landedPair() === null ? null : "privacy"));

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const m = await me();
      setWho(m);
      onKnown(m);
    } catch {
      // No connection: the rows that need the Worker stay as they were.
    } finally {
      setAsked(true);
    }
  }, [onKnown]);
  useEffect(() => { void refresh(); }, [refresh]);

  const local = isLocal();
  const shown = visibleSections({ owner: who?.operator === true }, PRIVACY_READY, local);
  const open = openSection(chosen, shown, phone);
  const liveSaid = live === "live" ? "connected" : live === "connecting" ? "connecting" : "no connection";

  const panelFor = (id: SectionId): ReactNode => {
    switch (id) {
      case "profile": return local ? <AccountProfileLocal /> : <AccountProfile who={who} asked={asked} waiting={waiting} onClose={onClose} onSignOut={onSignOut} refresh={refresh} />;
      case "names": return <AccountNames />;
      case "reminders": return <AccountReminders />;
      case "look": return <AccountLook />;
      case "extras": return <AccountExtras />;
      case "ai": return <AccountAi />;
      case "people": return <AccountPeople />;
      case "data": return <AccountData who={who} refresh={refresh} />;
      case "about": return <AccountAbout owner={who?.operator === true} />;
      case "privacy": return <AccountPrivacy email={who?.email ?? (local ? LOCAL_KEY_NAME : null)} owner={who === null ? null : who.operator === true} />;
    }
  };

  return (
    <div className="account account-sections">
      <SurfaceKicker menu={<MoreMenu label="account" items={app.phoneMenu} />}>Account</SurfaceKicker>
      <div className="account-id">
        <Monogram letters="V" size="account" />
        <div>
          <h1 className="account-name">VEMI</h1>
          <div className="account-sub">{local ? "kept on this device" : `${who?.email ?? "signed in on this device"} · ${liveSaid}`}</div>
        </div>
      </div>
      <AccountLayout shown={shown} open={open} phone={phone} onOpen={setChosen}
        panel={open === null ? null : panelFor(open)} />
      {/* On a phone Account is a place in the bar, so there is nothing to close. */}
      {!phone && (
        <div className="search-foot">
          <button type="button" className="back-link" onClick={onClose}>Close</button>
        </div>
      )}
    </div>
  );
}
