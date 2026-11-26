import type { ExtraSwitch } from "@vemi/shared";
import { changeExtra, useExtras } from "../extras.js";
import { useLevelWords } from "../levelNames.js";
import { Switch } from "./Switch.js";

/** One row: the title, a short note, and a switch. A change applies at once and is saved behind. */
function ExtraRow({ name, title, note }: { readonly name: ExtraSwitch; readonly title: string; readonly note: string }) {
  const on = useExtras()[name];
  return (
    <div className="account-row">
      <span className="account-row-title">
        {title}
        <span className="account-row-note">{note}</span>
      </span>
      <Switch on={on} label={title} onChange={(next) => changeExtra(name, next)} />
    </div>
  );
}

/** Account > Extras: six switches, each hiding exactly its own feature. The account keeps them. */
export function AccountExtras() {
  const words = useLevelWords();
  const spaces = words.spaces.toLowerCase();
  const projects = words.projects.toLowerCase();
  const milestones = words.milestones.toLowerCase();
  return (
    <div className="account-rows">
      <ExtraRow name="recent" title="Recent list on the map" note={`What you touched last, under your ${spaces}`} />
      <ExtraRow name="rings" title="Progress rings" note={`Rings on ${spaces}, ${projects} and ${milestones}`} />
      <ExtraRow name="comingUp" title="Coming up on Today" note="Tomorrow and this week under today's list" />
      <ExtraRow name="burst" title="Celebrations" note="A little burst when you clear the day" />
      <ExtraRow name="singleKeys" title="Single-key shortcuts" note="N, P, / and G then a letter. The palette always works." />
      <ExtraRow name="smartDates" title="Smart dates in Add" note={'Typing "tomorrow" or "every friday" sets it for you.'} />
    </div>
  );
}
