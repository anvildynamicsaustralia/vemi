/** The words the map opens with, from the hour on this device's clock. */
export function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * A date as a person says it: "Monday 16 November 2026". The date is already the day in the
 * owner's zone (the Worker says it), so it is read as a calendar date and no zone moves it.
 */
export function longDate(on: string): string {
  const [y, m, d] = on.split("-").map(Number);
  const day = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return `${DAYS[day.getUTCDay()]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}
