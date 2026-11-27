import { navigate, surface } from "../router.js";
import { Chip } from "./Chip.js";

/** Today and Upcoming, the two halves of the day's view, one press apart. */
export function DaySwitch({ on }: { readonly on: "today" | "upcoming" }) {
  return (
    <div className="chips seg day-switch" role="radiogroup" aria-label="today or upcoming">
      <Chip role="radio" aria-checked={on === "today"} on={on === "today"} onClick={() => navigate(surface("today"))}>Today</Chip>
      <Chip role="radio" aria-checked={on === "upcoming"} on={on === "upcoming"} onClick={() => navigate(surface("upcoming"))}>Upcoming</Chip>
    </div>
  );
}

