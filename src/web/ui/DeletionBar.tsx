import { useState } from "react";
import { cancelDeletion } from "../api.js";
import { deletionDay } from "../restoreFile.js";
import { useApp } from "./appContext.js";
import "./deletionBar.css";

/**
 * Shown on every screen from the day an account's deletion is scheduled until it is cancelled
 * or the day comes. Nothing is shown when no deletion is scheduled.
 */
export function DeletionBar({ deleteOn, onCancelled }: {
  readonly deleteOn: string | null | undefined;
  readonly onCancelled: () => void;
}) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  if (deleteOn === null || deleteOn === undefined) return null;
  const cancel = async (): Promise<void> => {
    setBusy(true);
    try {
      await cancelDeletion();
      onCancelled();
      app.notify("Deletion cancelled.");
    } catch (err) {
      app.notify(err instanceof Error ? err.message : "Could not cancel. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="deletion-bar" role="status">
      <span>This account goes on {deletionDay(deleteOn)}.</span>
      <button type="button" disabled={busy} onClick={() => void cancel()}>Cancel deletion</button>
    </div>
  );
}
