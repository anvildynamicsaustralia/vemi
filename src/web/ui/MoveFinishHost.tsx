import { useEffect, useState, type ReactElement } from "react";
import { api, paths, removeSavedFilter, saveFilter } from "../api.js";
import { fetchExport } from "../exportLocked.js";
import { clearFinishing, exportFrom, finishingMarked, lockedHeld, markFinishing, needsKey, pendingFinishing } from "../moveLocked.js";
import type { ResealSteps } from "../restoreReseal.js";
import { MoveFinish } from "./MoveFinish.js";

export const FINISH_FILE = "Your export file";

const steps: ResealSteps = {
  save: async ({ kind, id, fields }) => { await api.update(kind, id, fields); },
  replaceFilter: async (old, fresh, filter) => {
    await saveFilter(filter.name, filter.query, fresh);
    await removeSavedFilter(old);
  },
};

/**
 * Runs the finishing pass on the new copy after a move that carried locked content. A move lands
 * here by `/?finishing=1`; the mark is kept here until the pass is done, so a closed tab resumes.
 * The file is chosen again here: this origin never held it.
 */
export function MoveFinishHost(): ReactElement | null {
  const [pending, setPending] = useState<Record<string, string> | null>(() => pendingFinishing());
  const [document, setDocument] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (!finishingMarked(window.location.search)) return;
    if (pendingFinishing() === null) markFinishing({});
    setPending(pendingFinishing());
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    } catch {
      // The mark stays in the address; the pass is the same.
    }
  }, []);

  if (pending === null) return null;
  const choose = async (file: File): Promise<void> => {
    const read = exportFrom(await file.text());
    if (read === null) return;
    if (!needsKey(lockedHeld(read))) {
      clearFinishing();
      setPending(null);
      return;
    }
    setDocument(read);
  };
  if (document === null) {
    return (
      <section className="account-form move-finish">
        <label className="account-row-title" htmlFor="move-finish-file">{FINISH_FILE}</label>
        <input id="move-finish-file" className="field" type="file" accept="application/json,.json"
          onChange={(e) => { const file = e.target.files?.[0]; if (file !== undefined) void choose(file); }} />
      </section>
    );
  }
  return (
    <MoveFinish
      account="file"
      document={document}
      ids={Object.keys(pending).length > 0 ? pending : undefined}
      loadCopy={() => fetchExport(paths.export)}
      steps={steps}
    />
  );
}
