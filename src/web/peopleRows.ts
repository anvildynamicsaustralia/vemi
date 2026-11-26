/** Account > People: the rows the owner sees, and the invite page's greeting. Pure, so it is tested without a page. */

export interface PersonRow {
  readonly id: string;
  readonly firstName: string | null;
  readonly email: string;
  readonly deleteOn: string | null;
}

export interface InviteRow {
  readonly id: string;
  readonly firstName: string;
  readonly expiresAt: string;
}

export interface PeopleList {
  readonly people: readonly PersonRow[];
  readonly invites: readonly InviteRow[];
}

export type PeopleAction = "reset" | "remove" | "withdraw";

export interface Row {
  readonly key: string;
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly actions: readonly PeopleAction[];
}

/** How long until an ISO time, in the fewest words that stay true. */
export function until(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((new Date(iso).getTime() - now.getTime()) / 60000));
  if (minutes < 60) return `in ${Math.max(minutes, 1)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `in ${hours} h`;
  const days = Math.round(hours / 24);
  return days <= 1 ? "in a day" : `in ${days} days`;
}

/** People who joined first, then the links still waiting. A person already going has no Remove. */
export function peopleRows(list: PeopleList, now: Date = new Date()): Row[] {
  const joined: Row[] = list.people.map((p) => ({
    key: `person:${p.id}`,
    id: p.id,
    title: p.firstName ?? p.email,
    note: p.deleteOn !== null ? `${p.email} goes ${until(p.deleteOn, now)}` : p.email,
    actions: p.deleteOn !== null ? ["reset"] : ["reset", "remove"],
  }));
  const waiting: Row[] = list.invites.map((i) => ({
    key: `invite:${i.id}`,
    id: i.id,
    title: i.firstName,
    note: `link expires ${until(i.expiresAt, now)}`,
    actions: ["withdraw"],
  }));
  return [...joined, ...waiting];
}

/** What the invite page says over the form: the invitee's first name and nothing about anyone else. */
export function inviteGreeting(firstName: string | null, googleReady = false): string {
  const base = firstName === null || firstName === "" ? "Set a password" : `Hi ${firstName}, set a password`;
  return googleReady ? `${base} or use Google` : base;
}
