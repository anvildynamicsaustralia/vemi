/** The ten sections of the Account screen, in the brief's order, and which of them a person sees. Pure. */

export type SectionId =
  | "profile" | "names" | "reminders" | "look" | "extras"
  | "ai" | "privacy" | "people" | "data" | "about";

export interface Section {
  readonly id: SectionId;
  readonly title: string;
}

export const SECTIONS: readonly Section[] = [
  { id: "profile", title: "Profile and sign-in" },
  { id: "names", title: "Names" },
  { id: "reminders", title: "Reminders" },
  { id: "look", title: "Look and feel" },
  { id: "extras", title: "Extras" },
  { id: "ai", title: "AI" },
  { id: "privacy", title: "Privacy and security" },
  { id: "people", title: "People" },
  { id: "data", title: "Your data" },
  { id: "about", title: "About" },
];

/** Privacy and security shows for every account: the key rows live there from the crypto phase (ruling C13). */
export const PRIVACY_READY = true;

/** What a copy kept in the page has no use for: nobody to invite, no connector to set up. */
const NOT_LOCAL: readonly SectionId[] = ["ai", "people"];

/**
 * The sections shown to this person: People only to the owner, Privacy once it has content. In
 * local mode there is no sign-in to profile, and AI and People are not drawn at all.
 */
export function visibleSections(
  who: { readonly owner: boolean },
  privacyReady: boolean = PRIVACY_READY,
  local = false,
): readonly Section[] {
  const shows = (s: Section): boolean => {
    if (local && NOT_LOCAL.includes(s.id)) return false;
    if (s.id === "people") return who.owner;
    if (s.id === "privacy") return privacyReady;
    return true;
  };
  return SECTIONS.filter(shows).map((s) => (local && s.id === "profile" ? { ...s, title: "Profile" } : s));
}

/** The section open now. On a desk one is always open (the first if none was asked for); a phone may show the list. */
export function openSection(asked: SectionId | null, shown: readonly Section[], phone: boolean): SectionId | null {
  if (asked !== null && shown.some((s) => s.id === asked)) return asked;
  return phone ? null : (shown[0]?.id ?? null);
}
