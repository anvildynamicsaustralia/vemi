import { useEffect, useState } from "react";
import { NAME_MAX, type Overview, type Tree } from "@vemi/shared";
import { api, isQueued, paths } from "../api.js";
import { changeFirstRunStep } from "../firstRunState.js";
import { stepSuggestion } from "../firstRunSteps.js";
import { cardOutcome } from "../firstVenture.js";
import { navigate, venture } from "../router.js";
import { useResource } from "../state/resources.js";
import { currentNames, useLevelWords } from "../levelNames.js";
import { useApp } from "./appContext.js";

/**
 * Step 2, in the map's place: a name for the first space. The Worker makes the space with its
 * default stages; this waits until the tree holds it, because the shell sends an unknown space
 * back home, then opens its page on the projects tab and goes on to step 3.
 */
export function FirstVenture() {
  const app = useApp();
  const w = useLevelWords();
  const tree = useResource<Tree>(paths.tree);
  const overview = useResource<Overview>(paths.overview);
  // One id for this step's space, kept across tries, so a second press or a "Try again" sends
  // the same create and the Worker answers it as already made rather than making another.
  const [id] = useState(() => crypto.randomUUID());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [kept, setKept] = useState(false);
  const [making, setMaking] = useState(false);

  // Watched whether or not this step's own press succeeded: a "Try again" from the notice runs
  // outside it, a kept write is sent later, and another device may make a space meanwhile.
  // Another space is not opened: the step has been done, and the shell moves on from it.
  const outcome = cardOutcome(tree.data, overview.data, id);
  useEffect(() => {
    if (outcome === "wait") return;
    if (outcome === "open") navigate(venture(id, "projects"), { replace: true });
    changeFirstRunStep(3);
  }, [outcome, id]);

  const submit = async (): Promise<void> => {
    if (busy || name.trim() === "") return;
    setBusy(true);
    let queued = false;
    // A refusal or a failure is said once, by the shell's notice, which also offers Try again.
    const ok = await app.act(async () => {
      const result = await api.create("ventures", { id, name });
      queued = isQueued(result);
      return result;
    });
    if (!ok) {
      setBusy(false);
      return;
    }
    setKept(queued);
    setMaking(true);
  };

  return (
    <div className="first-run-space">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input className="field first-run-cue" autoFocus aria-label={`${w.space} name`}
          placeholder={stepSuggestion(2, currentNames()) ?? ""} value={name} disabled={making} maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="primary-button" disabled={busy || name.trim() === ""}>
          {kept ? "Kept on this device" : busy ? "Making…" : "Make it"}
        </button>
      </form>
    </div>
  );
}
