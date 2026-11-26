/**
 * What the signed-out front page offers, and when it shows. Pure, so the rules are
 * tested without a page. A link to a phase that has not shipped is not drawn at all:
 * a button that leads nowhere adds a step (ruling L1, L2 in the landing notes).
 */

export interface LandingFlags {
  /** The local-mode phase has shipped `/try`. */
  readonly tryShipped: boolean;
  /**
   * The front's own address, where the setup page lives (`https://<front>`), or null until it is
   * set. Never a path on this copy: a copy made by a button or run on its own has no setup files.
   */
  readonly getUrl: string | null;
  /** The public repository, once the release phase sets it. */
  readonly repoUrl: string | null;
}

/** Flipped by the phase that makes the page behind it. Off until then. */
export const LANDING_FLAGS: LandingFlags = { tryShipped: true, getUrl: "https://vemi.anvildynamics.com.au", repoUrl: "https://github.com/anvildynamicsaustralia/vemi" };

/** The words each link goes by, so a page can find its link without matching on an address. */
export const LANDING_LABELS = { try: "Try it now", get: "Get my own VEMI", repo: "On GitHub" } as const;

export interface LandingLink {
  readonly label: string;
  readonly href: string;
}

/** The links beside Sign in, in the order they are drawn: only those whose target exists. */
export function landingLinks(flags: LandingFlags = LANDING_FLAGS): readonly LandingLink[] {
  const links: LandingLink[] = [];
  if (flags.tryShipped) links.push({ label: LANDING_LABELS.try, href: "/try" });
  if (flags.getUrl !== null && /^https:\/\//.test(flags.getUrl)) links.push({ label: LANDING_LABELS.get, href: `${flags.getUrl.replace(/\/+$/, "")}/get/` });
  if (flags.repoUrl !== null && flags.repoUrl !== "") links.push({ label: LANDING_LABELS.repo, href: flags.repoUrl });
  return links;
}

/**
 * Whether a signed-out visitor sees the front page rather than the sign-in card: only at `/`,
 * only when no link was opened, only when the copy has the page on, and only until they
 * choose Sign in. An unanswered or failed question reads as off, the conservative way.
 */
export function showsLanding(input: {
  readonly pathname: string;
  readonly hasLink: boolean;
  readonly landing: boolean | null;
  readonly choseSignIn: boolean;
}): boolean {
  return input.pathname === "/" && !input.hasLink && input.landing === true && !input.choseSignIn;
}

export interface LandingShot {
  readonly id: "map" | "today" | "project" | "search" | "account";
  readonly device: "desk" | "phone";
  /** The tab's name. */
  readonly label: string;
  readonly src: string;
  readonly alt: string;
}

/**
 * The eight pictures, from `/landing/`, each with the words that stand in for it. They are 2x
 * screenshots of the app itself (desk 2560 by 1600, phone 780 by 1688, light theme), each well
 * under the repo's 300 KB picture cap. The desk ones are shown in a monitor, the phone ones in
 * a phone; the first of each is what the page opens on.
 */
export const LANDING_SHOTS: readonly LandingShot[] = [
  { id: "today", device: "desk", label: "Today", src: "/landing/desk-today.png", alt: "VEMI's Today screen on a desktop: the next task to do, the other tasks for today, and what is coming up." },
  { id: "map", device: "desk", label: "Map", src: "/landing/desk-map.png", alt: "VEMI's map screen on a desktop: every space and its projects laid out on one screen." },
  { id: "project", device: "desk", label: "Project", src: "/landing/desk-project.png", alt: "A project page on a desktop: its brief, its milestones, the next step and its links." },
  { id: "search", device: "desk", label: "Search", src: "/landing/desk-search.png", alt: "VEMI's search on a desktop: a search for paint finds one project and one task." },
  { id: "today", device: "phone", label: "Today", src: "/landing/phone-today.png", alt: "VEMI's Today screen on a phone." },
  { id: "map", device: "phone", label: "Map", src: "/landing/phone-map.png", alt: "VEMI's map screen on a phone." },
  { id: "project", device: "phone", label: "Project", src: "/landing/phone-project.png", alt: "A project page on a phone, with its brief." },
  { id: "account", device: "phone", label: "Account", src: "/landing/phone-account.png", alt: "The account screen on a phone: profile, reminders, look and feel, your data and more." },
];
