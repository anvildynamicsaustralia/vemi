import type { SmartToken } from "@vemi/shared";
import { Chip } from "./Chip.js";
import "./smartChips.css";

/**
 * What the typed title was read as, one chip a phrase. Tapping one takes it back: its words
 * return to the text and are no longer read. Words are drawn as text, never as HTML.
 */
export function SmartChips({ chips, onRestore }: {
  readonly chips: readonly SmartToken[];
  readonly onRestore: (chip: SmartToken) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="chips smart-chips" role="group" aria-label="read from the title">
      {chips.map((c) => (
        <Chip key={`${c.kind}:${c.words}`} on aria-pressed onClick={() => onRestore(c)}>{c.words}</Chip>
      ))}
    </div>
  );
}
