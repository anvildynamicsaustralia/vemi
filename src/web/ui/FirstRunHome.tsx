import { install, IOS_STEPS, type InstallOffer } from "../installPrompt.js";
import "./firstRun.css";

/**
 * Step 7, on Today above the list, on a phone browser that is not the installed app: the
 * platform's real way to add VEMI to the home screen. A browser with its own install gets the
 * Install button; an iPhone gets Safari's two taps. Install or Not now ends first run.
 */
export function FirstRunHome({ offer, onDone }: { readonly offer: Exclude<InstallOffer, null>; readonly onDone: () => void }) {
  return (
    <section className="first-run-card" aria-label="Home screen">
      <h4>Add VEMI to your home screen</h4>
      {offer === "ios" && <p className="first-run-note">{IOS_STEPS}</p>}
      <div className="first-run-buttons">
        {offer === "button" && (
          <button type="button" className="first-run-action" onClick={() => { void install().finally(onDone); }}>Install</button>
        )}
        <button type="button" className="first-run-skip-now" onClick={onDone}>Not now</button>
      </div>
    </section>
  );
}
