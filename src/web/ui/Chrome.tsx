import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "@vemi/icons";
import { crumbsFor } from "../crumbs.js";
import { singleKeysOn } from "../extras.js";
import { age } from "../format.js";
import { keyNames, onMac } from "../keys.js";
import { badgeSpoken, badgeText } from "../needsCount.js";
import { routeMode } from "../local/mode.js";
import { roveTo } from "../rove.js";
import { routeHref, TABS, type Route, type Tab } from "../router.js";
import type { LiveStatus } from "../state/live.js";
import { useLevelWords } from "../levelNames.js";
import { EditableText, Spoken } from "./controls.js";
import type { Outcome } from "../outcome.js";
import "./chrome2.css";

/**
 * The six places the router goes. Board and Projects are not here: a venture is
 * (decision 3). Written as a value as well as a type so `Chrome.test.ts` can hold the rail
 * and the router to the same list. The rail shows four of them and the phone bar five;
 * Add is the bar's middle button, and Archive is reached from Account.
 */
export const PLACES = ["map", "today", "add", "search", "archive", "account", "review"] as const;
export type Place = (typeof PLACES)[number];

interface Stop {
  readonly place: Place;
  readonly label: string;
}

/**
 * In the order it reads: where things are, what is today, finding, you.
 */
export const RAIL: readonly Stop[] = [
  { place: "map", label: "Map" },
  { place: "today", label: "Today" },
  { place: "search", label: "Search" },
  { place: "account", label: "Account" },
];

/** The rail's four with Add in the middle, so the thumb's most used verb is the centre. */
export const PHONE_BAR: readonly Stop[] = [
  ...RAIL.slice(0, 2),
  { place: "add", label: "Add" },
  ...RAIL.slice(2),
];

/** One 24 by 24 line drawing a place, stroked in the text colour. */
const DRAWINGS: Record<Place, ReactNode> = {
  map: <><path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4z" /><path d="M9 4v14M15 6v14" /></>,
  today: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
  add: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  review: <><path d="M5 4.5h14v15H5z" /><path d="m8.5 12 2.2 2.2 4.8-4.8" /></>,
  archive: <><path d="M4 7h16v3H4z" /><path d="M5.5 10v9h13v-9M10 14h4" /></>,
  account: <><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20.5c1.2-4 4.2-6 7.5-6s6.3 2 7.5 6" /></>,
};

function PlaceIcon({ place }: { readonly place: Place }) {
  return <svg className="place-icon" viewBox="0 0 24 24" aria-hidden="true">{DRAWINGS[place]}</svg>;
}

/** Which dot is lit. Inside a venture it is the map's, because a venture is reached from it. */
export function placeOf(route: Route): Place | null {
  return route.surface === "venture" || route.surface === "project" || route.surface === "task" ? "map" : route.surface;
}

/**
 * Four places down the left edge under the V mark, each an icon and its word. The word is
 * always shown (an unnamed mark is "not knowing what can be pressed"). It is `aria-hidden`
 * because the button's `aria-label` already says the name, and a screen reader should hear
 * it once. The lit place takes the accent on its icon and a field behind it. The same name
 * shows as a label beside the item on hover and on keyboard focus, with the key that goes
 * there. One Tab lands on the rail (on the lit place); the arrow keys move between places.
 */
export function Rail({ at, onGo, needs = 0 }: { readonly at: Place; readonly onGo: (to: Place) => void; readonly needs?: number }) {
  const lit = Math.max(0, RAIL.findIndex((r) => r.place === at));
  const [stop, setStop] = useState(lit);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => setStop(lit), [lit]);
  const keys = singleKeysOn();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const here = items.current.findIndex((el) => el === document.activeElement);
    const next = roveTo(event, here, RAIL.length);
    if (next === null) return;
    event.preventDefault();
    setStop(next);
    items.current[next]?.focus();
  };
  return (
    <nav className="rail" aria-label="places" onKeyDown={onKeyDown}>
      <div className="rail-mark" aria-hidden="true">V</div>
      {RAIL.map((r, i) => {
        const hint = keys ? PLACE_KEYS[r.place] : undefined;
        const badge = r.place === "today" ? needs : 0;
        return (
          <button key={r.place} type="button" className={`rail-item${at === r.place ? " on" : ""}`}
            ref={(el) => { items.current[i] = el; }} tabIndex={i === stop ? 0 : -1} onFocus={() => setStop(i)}
            aria-label={r.label} aria-current={at === r.place ? "page" : undefined}
            aria-describedby={badge > 0 ? "rail-needs" : undefined} onClick={() => onGo(r.place)}>
            <span className="place-mark">
              <PlaceIcon place={r.place} />
              {badge > 0 && <Badge count={badge} id="rail-needs" />}
            </span>
            <span className="rail-label" aria-hidden="true">{r.label}</span>
            <span className="rail-tip" aria-hidden="true">{r.label}{hint !== undefined && <kbd className="key-hint">{hint}</kbd>}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** The keys a place already answers to, from the real key map. Shown only while single keys are on. */
export const PLACE_KEYS: Partial<Record<Place, string>> = { map: "G M", today: "G T", search: "G S" };

/** A small number on a place's icon: the real count of what needs the person. Nothing for none. */
function Badge({ count, id }: { readonly count: number; readonly id: string }) {
  const text = badgeText(count);
  if (text === null) return null;
  return (
    <>
      <span className="place-badge" aria-hidden="true">{text}</span>
      <span id={id} className="sr-only">{badgeSpoken(count)}</span>
    </>
  );
}

/**
 * Where am I, on every page: Map, then the space, then the page. Earlier steps are links
 * back. On a desk the search field sits at the right, a button shaped like a field that
 * opens the palette, with the key that does the same. On a phone it is the one line, and
 * Search stays in the bar below.
 */
export function TopBar({ route, ventureName, itemName, phone, onGo, onSearch }: {
  readonly route: Route;
  readonly ventureName: string | null;
  readonly itemName: string | null;
  readonly phone: boolean;
  readonly onGo: (to: Route) => void;
  readonly onSearch: () => void;
}) {
  const w = useLevelWords();
  const trail = crumbsFor(route, ventureName, itemName, { board: "Board", projects: w.projects });
  const mod = keyNames(onMac()).mod.trim();
  // On a phone a trail of one only repeats the page's own heading and the lit place in the bar
  // below, so it takes no room. A deeper trail is where the way back lives, so it stays.
  if (phone && trail.length <= 1) return null;
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="where you are">
        <ol>
          {trail.map((c, i) => {
            const target = c.to;
            return (
              <li key={`${i}:${c.label}`} className="crumb">
                {target === null ? (
                  <span className="crumb-name" dir="auto" aria-current={i === trail.length - 1 ? "page" : undefined}>{c.label}</span>
                ) : (
                  <a className="crumb-link" dir="auto" href={routeHref(target)} onClick={(e) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                    e.preventDefault();
                    onGo(target);
                  }}>{c.label}</a>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {!phone && (
        <button type="button" className="search-field" aria-keyshortcuts={onMac() ? "Meta+K" : "Control+K"} onClick={onSearch}>
          <PlaceIcon place="search" />
          <span className="search-field-text">Go anywhere</span>
          <kbd className="key-hint" aria-hidden="true">{mod} K</kbd>
        </button>
      )}
    </header>
  );
}

/** The first thing Tab reaches: a real link past the rail and the top bar, drawn only on focus. */
export function SkipLink({ target }: { readonly target: string }) {
  return (
    <a className="skip-link" href={`#${target}`} onClick={(e) => {
      // A path-routed page takes the link as written: the address gains #main and the page
      // takes focus there. A hash-routed one (the local copy) reads its route from the hash,
      // so the focus is moved by hand and the address is left alone.
      if (routeMode() === "path") return;
      e.preventDefault();
      const el = document.getElementById(target);
      el?.focus();
      el?.scrollIntoView({ block: "start" });
    }}>Skip to content</a>
  );
}

/**
 * A venture's two letters on ink, or its own icon when one has been chosen for it. The
 * icon is kept because it was chosen: the handoff draws letters, and letters are what a
 * venture without one gets.
 */
export function Monogram({ letters, icon, size = "chip" }: {
  readonly letters: string;
  readonly icon?: string | null;
  readonly size?: "chip" | "sign" | "account";
}) {
  return (
    <span className={`monogram monogram-${size}`} aria-hidden="true">
      {icon !== undefined && icon !== null ? <Icon name={icon} size={size === "account" ? 22 : 13} /> : letters}
    </span>
  );
}

/** The kicker over a surface that is not a venture's: MAP, HORIZON, ADD, SEARCH, ARCHIVE, ACCOUNT. */
export function SurfaceKicker({ children, menu }: { readonly children: ReactNode; readonly menu?: ReactNode }) {
  return <div className="surface-kicker"><span>{children}</span>{menu}</div>;
}

/** The way into a venture's three surfaces, and the only one (decision 3). */
export function VentureHeader({ name, letters, icon, tab, onTab, onBack, menu, views = TABS, onRename }: {
  readonly menu?: ReactNode;
  /** Given, the name is pressed to rename the space in place. */
  readonly onRename?: (next: string, was: string | null) => Promise<Outcome | boolean>;
  /** The views the space has on; a view turned off leaves the pill. */
  readonly views?: readonly Tab[];
  readonly name: string;
  readonly letters: string;
  readonly icon: string | null;
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  readonly onBack: () => void;
}) {
  const w = useLevelWords();
  const TAB_LABELS: Record<Tab, string> = { board: "Board", projects: w.projects };
  return (
    <header className="venture-head">
      <button type="button" className="back-link" onClick={onBack}>← Map</button>
      <div className="venture-id">
        <Monogram letters={letters} icon={icon} />
        <h1 className="venture-name">
          {onRename === undefined ? name : <EditableText value={name} placeholder="name" className="venture-name-edit" onSave={onRename} />}
        </h1>
      </div>
      <nav className="venture-tabs" aria-label={`${name}'s surfaces`}>
        {TABS.filter((t) => views.includes(t)).map((t) => (
          <button key={t} type="button" className={`venture-tab${tab === t ? " on" : ""}`} aria-current={tab === t ? "page" : undefined}
            onClick={() => onTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </nav>
      {menu}
    </header>
  );
}

/** Said as a person would say it. */
const LIVE_WORDS: Record<Exclude<LiveStatus, "live">, string> = { connecting: "Connecting…", offline: "No connection" };

/**
 * What the telemetry bar used to say, now said only when it is news. A connection that is
 * working and nothing waiting is the normal case, and the normal case is quiet; the
 * Account page carries the full picture. The day the line drops, it appears.
 */
export function StatusLine({ live, waiting, kept }: {
  readonly live: LiveStatus;
  readonly waiting: number;
  readonly kept: string | null;
}) {
  const keptWords = "Showing what this device kept";
  const said = [
    live === "live" ? null : LIVE_WORDS[live],
    waiting > 0 ? `${waiting} waiting to send` : null,
    kept === null ? null : `${keptWords}, ${age(kept)}`,
  ].filter((s): s is string => s !== null);
  // Said through a region that is always on the page, and drawn only while there is news.
  // The kept copy's age is left out of what is said: it ticks over as the page redraws,
  // and every tick would be read out again.
  const spoken = [
    live === "live" ? null : LIVE_WORDS[live],
    waiting > 0 ? `${waiting} waiting to send` : null,
    kept === null ? null : keptWords,
  ].filter((s): s is string => s !== null);
  return (
    <>
      <Spoken text={spoken.join(". ")} />
      {said.length > 0 && (
        <div className="status-line">
          {said.map((s) => <span key={s}>{s}</span>)}
        </div>
      )}
    </>
  );
}

/**
 * The phone's five places with their words, Add in the middle as the one filled button,
 * every one a 44px target.
 */
export function PhoneBar({ at, onGo, needs = 0 }: { readonly at: Place; readonly onGo: (to: Place) => void; readonly needs?: number }) {
  const w = useLevelWords();
  return (
    <nav className="phone-bar" aria-label="places">
      {PHONE_BAR.map((s) => s.place === "add" ? (
        <button key={s.place} type="button" className="phone-add" aria-label={`Add a ${w.task.toLowerCase()}, ${w.project.toLowerCase()} or ${w.space.toLowerCase()}`} onClick={() => onGo("add")}>
          <PlaceIcon place="add" />
          <span className="phone-label" aria-hidden="true">{s.label}</span>
        </button>
      ) : (
        <button key={s.place} type="button" className={`phone-dot${at === s.place ? " on" : ""}`} aria-label={s.label}
          aria-current={at === s.place ? "page" : undefined}
          aria-describedby={s.place === "today" && needs > 0 ? "phone-needs" : undefined} onClick={() => onGo(s.place)}>
          <span className="place-mark">
            <PlaceIcon place={s.place} />
            {s.place === "today" && <Badge count={needs} id="phone-needs" />}
          </span>
          <span className="phone-label" aria-hidden="true">{s.label}</span>
        </button>
      ))}
    </nav>
  );
}
