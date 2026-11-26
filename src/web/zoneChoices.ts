/** The time zone picker's choices, pure: the account's saved zone, or else this browser's, and the names to pick from. */

/** This browser's own zone, or null when it names none. */
export function browserZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone !== "" ? zone : null;
  } catch {
    return null;
  }
}

/** Every zone name this browser knows, or none when it cannot list them. */
export function knownZones(): readonly string[] {
  try {
    const list = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    return list === undefined ? [] : list("timeZone");
  } catch {
    return [];
  }
}

/** The zone the picker shows: the saved one, else this browser's, else nothing. */
export function zoneShown(saved: string | null, browser: string | null): string {
  return saved ?? browser ?? "";
}

/** The names to pick from, each once and sorted; the shown one is always among them. */
export function zoneChoices(known: readonly string[], shown: string): readonly string[] {
  const all = new Set(known);
  if (shown !== "") all.add(shown);
  return [...all].sort();
}
