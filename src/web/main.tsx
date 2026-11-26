import "@fontsource-variable/archivo";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { isTyping } from "./keys.js";
import { writesInFlight } from "./state/outbox.js";
import { startAppearance } from "./appearance.js";
import { installHold } from "./ui/holdMenu.js";
import { listenForInstall } from "./installPrompt.js";
import { trackKeyboard } from "./keyboardInset.js";
import { isLocal } from "./local/mode.js";
import { appStarted } from "./earlyAnswers.js";
import "./ui/controls.css";

appStarted();
startAppearance();
installHold();
trackKeyboard();
// Before the app draws: the browser hands over its install offer once, early.
listenForInstall();

const root = document.getElementById("root");
if (root === null) throw new Error("no #root element in index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable and usable offline. Registered only in a build: in development the service
// worker would hand back yesterday's modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    // The page at /try has its own worker, scope /try/, that never answers an API request
    // (`src/web/local/start.ts` has already put the bridge and the storage wrapper in place).
    if (isLocal()) void navigator.serviceWorker.register("/try/sw.js", { scope: "/try/" });
    else void navigator.serviceWorker.register("/sw.js");
  });

  // A deploy installs a new worker, which takes over this page. The page reloads into the new
  // build the next time it is looked at, and only when nobody is in the middle of something:
  // not while hidden (leaving a field to switch tabs starts a save a reload would cut off),
  // not while a write is on its way, and not while a field has the focus.
  let controlled = navigator.serviceWorker.controller !== null;
  let updated = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!controlled) {
      controlled = true;
      return;
    }
    updated = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (!updated || document.visibilityState !== "visible" || writesInFlight() > 0) return;
    if (isTyping(document.activeElement)) return;
    window.location.reload();
  });
}
