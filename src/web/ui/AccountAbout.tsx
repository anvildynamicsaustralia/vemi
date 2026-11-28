import { useEffect, useState } from "react";
import { VERSION } from "@vemi/shared";
import { askFrontLanding, saveFrontLanding } from "../api.js";
import { changeFirstRunStep } from "../firstRunState.js";
import { install, IOS_STEPS, useInstallOffer } from "../installPrompt.js";
import { isLocal } from "../local/mode.js";
import { LANDING_FLAGS } from "../landingLinks.js";
import { HOME, navigate } from "../router.js";
import { useApp } from "./appContext.js";
import { Switch } from "./Switch.js";
import { AccountUpdate } from "./AccountUpdate.js";
import { UpdateRow } from "./UpdateRow.js";

/**
 * The owner's switch for the signed-out front page. It applies at once and is saved behind;
 * if the save is refused the row goes back to what the copy says.
 */
function FrontPageRow() {
  const app = useApp();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void askFrontLanding().then((landing) => { if (live) setOn(landing); });
    return () => { live = false; };
  }, []);

  const choose = (next: boolean): void => {
    if (next === on) return;
    const before = on;
    setOn(next);
    saveFrontLanding(next).then(
      () => app.notify(next ? "Front page on." : "Front page off."),
      () => { setOn(before); app.notify("Could not change the front page."); },
    );
  };

  return (
    <div className="account-row">
      <span className="account-row-title">
        Front page
        <span className="account-row-note">What someone signed out sees at the address of this copy.</span>
      </span>
      <Switch on={on} label="Front page" onChange={choose} />
    </div>
  );
}

/**
 * This copy's address, to copy, and a way to keep it on the VEMI home page: opening the home
 * page with `?mine=` saves it there, on this device, so its "Open my VEMI" comes straight here.
 */
export function AddressRow({ origin: given, home = LANDING_FLAGS.getUrl }: { readonly origin?: string; readonly home?: string | null }) {
  const app = useApp();
  const origin = given ?? (typeof window === "undefined" ? "" : window.location.origin);
  if (origin === "") return null;
  const shown = origin.replace(/^https:\/\//, "");
  const copy = (): void => {
    void navigator.clipboard?.writeText(origin).then(() => app.notify("Address copied."), () => app.notify(`Your address is ${shown}.`));
  };
  const onHome = home !== null && !origin.startsWith(home);
  return (
    <div className="account-row account-row-wrap">
      <span className="account-row-title">
        Your address
        <span className="account-row-note">
          <b>{shown}</b>{onHome ? ". Save it on the VEMI home page and its Open button brings you here." : "."}
        </span>
      </span>
      <span className="account-row-acts">
        <button type="button" className="row-action" onClick={copy}>Copy</button>
        {onHome && (
          <a className="row-action" href={`${home.replace(/\/+$/, "")}/?mine=${encodeURIComponent(origin)}`} target="_blank" rel="noopener noreferrer">
            Save on home page
          </a>
        )}
      </span>
    </div>
  );
}

/**
 * The SIL Open Font License text for the two bundled fonts, collapsed. The text is a data
 * file (`licences/fonts-ofl.txt`) loaded as its own chunk the first time the block opens, so
 * it adds nothing to the first page and makes no outside request.
 */
export function FontLicence() {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = (): void => {
    if (text !== null) return;
    import("../../../licences/fonts-ofl.txt?raw").then((m) => setText(m.default), () => setFailed(true));
  };
  return (
    <details className="account-licence" onToggle={(event) => { if (event.currentTarget.open) load(); }}>
      <summary>Font licences</summary>
      {failed && <p className="account-row-note">Could not load the licence text.</p>}
      {text !== null && <pre className="account-licence-text" tabIndex={0} aria-label="Font licence text">{text}</pre>}
    </details>
  );
}

/**
 * Account > About: the version, the licence, who made it, and Install where the browser offers
 * it. The copy's owner also gets the Front page switch.
 */
export function AccountAbout({ owner = false, local = isLocal() }: { readonly owner?: boolean; readonly local?: boolean }) {
  const installable = useInstallOffer();
  // Step 1 again, on the map: it makes new things and changes nothing already there.
  const runAgain = (): void => {
    changeFirstRunStep(1);
    navigate(HOME);
  };
  return (
    <div className="account-rows">
      <div className="account-row">
        <span className="account-row-title">Version</span>
        <span className="account-row-note">{VERSION}</span>
      </div>
      {!local && <AddressRow />}
      {!local && <UpdateRow />}
      {owner && !local && <AccountUpdate />}
      <div className="account-row">
        <span className="account-row-title">
          Open source
          <span className="account-row-note">MIT licence.</span>
        </span>
      </div>
      <div className="account-row">
        <span className="account-row-title">Made by</span>
        <span className="account-row-note">Anvil Dynamics</span>
      </div>
      <FontLicence />
      {owner && !local && <FrontPageRow />}
      <div className="account-row">
        <span className="account-row-title">
          Run first steps again
          <span className="account-row-note">Changes nothing already there.</span>
        </span>
        <button type="button" className="row-action" onClick={runAgain}>Run</button>
      </div>
      {installable !== null && (
        <div className="account-row">
          <span className="account-row-title">
            Install VEMI
            <span className="account-row-note">{installable === "ios" ? IOS_STEPS : "Opens in its own window, with no browser bar, and works offline."}</span>
          </span>
          {installable === "button" && (
            <button type="button" className="row-action" onClick={() => void install()}>Install</button>
          )}
        </div>
      )}
    </div>
  );
}
