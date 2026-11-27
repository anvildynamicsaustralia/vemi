/**
 * A time as a phone's wheels show it: hour 1-12, minute in fives, am or pm. Pure. Stored
 * times are "HH:MM" on a 24-hour clock; a minute between fives rounds to the nearest five.
 */
export interface WheelTime {
  readonly hour: number;
  readonly minute: number;
  readonly pm: boolean;
}

export const HOURS: readonly number[] = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
export const MINUTES: readonly number[] = Array.from({ length: 12 }, (_, i) => i * 5);

export function toWheel(value: string): WheelTime {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (m === null) return { hour: 9, minute: 0, pm: false };
  const h24 = Math.min(23, Number(m[1]));
  let minute = Math.round(Math.min(59, Number(m[2])) / 5) * 5;
  let hours = h24;
  if (minute === 60) { minute = 0; hours = (hours + 1) % 24; }
  return { hour: hours % 12 === 0 ? 12 : hours % 12, minute, pm: hours >= 12 };
}

export function fromWheel(t: WheelTime): string {
  const h = (t.hour % 12) + (t.pm ? 12 : 0);
  return `${String(h).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

/** As said: "9:05 am". */
export const said = (t: WheelTime): string => `${t.hour}:${String(t.minute).padStart(2, "0")} ${t.pm ? "pm" : "am"}`;
