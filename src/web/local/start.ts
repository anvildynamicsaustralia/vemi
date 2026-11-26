/**
 * The entry of the page at `/try`. It puts the page's own data in place before the app draws,
 * then loads the app: the storage wrapper first, so every key the app writes is under
 * `vemi:local:`, then the bridge, so every `/api/` and `/auth/` request is answered by the
 * database in this browser and everything else fails the way a fetch fails offline.
 *
 * Only this entry reaches the database code. The signed-in app's page loads `main.tsx`
 * directly and never imports this file, so none of it is in that page's entry bundle.
 */
import { installBridge } from "../../local/bridge.js";
import { openBrowserLeader } from "../../local/leader.js";
import { createChannel } from "../../local/channel.js";
import { isLocal } from "./mode.js";
import { provideChannel, provideVolatile, provideWipe } from "./parts.js";
import { browserWipeDeps, wipeDevice } from "./wipe.js";
import { pageStore, startKeeping } from "./persist.js";
import { installLocalStorage } from "./storage.js";

if (isLocal()) {
  installLocalStorage(window);
  provideChannel(() => createChannel());
  // First open: ask the browser to keep the data, and keep what it says.
  startKeeping(navigator, pageStore());
  const leader = openBrowserLeader();
  provideVolatile({ now: () => leader.status().volatile, onChange: (listener) => leader.onStatus(listener) });
  provideWipe(() => wipeDevice(browserWipeDeps(() => leader.close())));
  installBridge({ origin: window.location.origin, send: (wire) => leader.send(wire) });
}

// After the installs: the app's modules run their first lines as they load.
void import("../main.js");
