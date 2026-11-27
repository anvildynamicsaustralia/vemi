import { useRef, useState } from "react";
import { Chip } from "./Chip.js";

/**
 * "+ New …" at the end of a row of choices: pressed, it becomes a field in the row, named and
 * made in place, and what is made is chosen, as a phone's pickers offer "New list" inside the
 * list of lists. Enter makes it; Escape or leaving it empty puts the chip back.
 */
export function NewChip({ label, placeholder, onMake }: {
  /** "New space". */
  readonly label: string;
  readonly placeholder: string;
  /** Makes it and says whether it was made; the caller chooses it. */
  readonly onMake: (name: string) => Promise<boolean>;
}) {
  const [naming, setNaming] = useState(false);
  const [text, setText] = useState("");
  const busy = useRef(false);
  const make = async (): Promise<void> => {
    const name = text.trim();
    if (name === "" || busy.current) return;
    busy.current = true;
    try {
      if (await onMake(name)) { setText(""); setNaming(false); }
    } finally {
      busy.current = false;
    }
  };
  if (!naming) {
    return (
      <Chip className="new-chip" onClick={() => setNaming(true)}>
        <span aria-hidden="true">+</span> {label}
      </Chip>
    );
  }
  return (
    <span className="new-chip-field">
      <input className="field" autoFocus dir="auto" value={text} placeholder={placeholder} aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text.trim() === "") setNaming(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void make(); }
          else if (e.key === "Escape") { e.stopPropagation(); setText(""); setNaming(false); }
        }} />
      <Chip className="new-chip-make" disabled={text.trim() === ""}
        onMouseDown={(e) => e.preventDefault()} onClick={() => void make()}>Make</Chip>
    </span>
  );
}
