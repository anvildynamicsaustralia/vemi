import { useEffect, useRef, type ReactNode } from "react";
import wordmarkSource from "../../../brand/vemi-wordmark.svg?raw";
import { landingLinks, LANDING_LABELS, LANDING_SHOTS, type LandingFlags } from "../landingLinks.js";
import { HeroField } from "./HeroField.js";
import { InfoTip } from "./InfoTip.js";
import { Showcase, shotsFor, Stage } from "./Showcase.js";
import { useReveal } from "./useReveal.js";
import "./landing.css";

/** The one line, as the only `h1`. */
export const LANDING_LINE = "Everything you're building, in one place.";

/** The sub line under the headline. */
export const LANDING_PITCH =
  "Every space, project and task sits on one map. Pick what you will do today, get reminders on your phone, and ask your own Claude or ChatGPT what is next.";

/** The wordmark from `brand/`, drawn in the page's ink so it reads in both themes with one file. */
const WORDMARK = wordmarkSource.replace(/ fill="#[0-9a-f]{6}"/gi, ' fill="currentColor"');

/** The words after the last comma carry the accent; the line stays whole for a reader. */
const [LINE_START, LINE_END] = ((): readonly [string, string] => {
  const at = LANDING_LINE.lastIndexOf(", ");
  return at < 0 ? [LANDING_LINE, ""] : [LANDING_LINE.slice(0, at + 2), LANDING_LINE.slice(at + 2)];
})();

const FACTS: readonly { readonly head: string; readonly body: string }[] = [
  { head: "Free", body: "It runs on Cloudflare's free plan. You do not need a card." },
  { head: "MIT", body: "Open source under the MIT licence. Read it, change it, keep it." },
  { head: "Yours", body: "It runs in your own account, so your data stays with you." },
];

const CARDS: readonly { readonly head: string; readonly body: string }[] = [
  { head: "The map", body: "Your spaces and projects on one screen, so nothing gets buried in a list." },
  { head: "Today", body: "Pick the few things you will do today. VEMI can send a reminder to your phone when one is due." },
  { head: "Your own AI", body: "Connect your own Claude or ChatGPT. It can read and change your work. It cannot delete anything." },
];

/**
 * What a signed-out visitor sees at `/` when the copy has its front page on: the headline, the
 * sub line, real screens of the app in a monitor and a phone, and Sign in. A link to Try it or
 * to a new copy is drawn only when `landingLinks` says it has somewhere to go.
 */
export function Landing({ onSignIn, flags, mine, signInLabel = "Sign in", haveLabel = "I have an account" }: {
  readonly onSignIn: () => void;
  readonly flags?: LandingFlags;
  /** Drawn first in the hero, above the headline: the home page's "Your VEMI" panel. */
  readonly mine?: ReactNode;
  /** The nav's own way in: "Sign in" on a copy, "Open my VEMI" on the home page. */
  readonly signInLabel?: string;
  /** The same way in at the foot of the page. */
  readonly haveLabel?: string;
}) {
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.title = "VEMI";
  }, []);
  useReveal(page);
  const links = landingLinks(flags);
  const tryLink = links.find((link) => link.label === LANDING_LABELS.try);
  const getLink = links.find((link) => link.label === LANDING_LABELS.get);
  const repoLink = links.find((link) => link.label === LANDING_LABELS.repo);
  const deskToday = shotsFor("desk").filter((s) => s.id === "today");
  const phoneToday = shotsFor("phone").filter((s) => s.id === "today");
  const map = LANDING_SHOTS.find((s) => s.device === "desk" && s.id === "map");
  return (
    <div className="landing" ref={page}>
      <header className="landing-nav">
        <span className="landing-mark" dangerouslySetInnerHTML={{ __html: WORDMARK }} />
        <nav aria-label="Front page">
          <a className="landing-nav-link" href="#what">What it is</a>
          <a className="landing-nav-link" href="#see">See it</a>
          <a className="landing-nav-link" href="#own">Your own copy</a>
          {tryLink !== undefined && <a className="landing-nav-link" href="#try">Try it</a>}
          <button type="button" className="landing-btn landing-btn-small" onClick={onSignIn}>{signInLabel}</button>
        </nav>
      </header>

      <main>
        <div className="landing-hero-wrap">
          <HeroField />
          <section className="landing-wrap landing-hero">
            {mine}
            <span className="landing-kicker landing-kicker-pill">Free and open source</span>
            <h1 className="landing-title">{LINE_START}<em>{LINE_END}</em></h1>
            <p className="landing-sub">{LANDING_PITCH}</p>
            <div className="landing-acts">
              {getLink !== undefined && <a className="landing-btn landing-btn-live" href={getLink.href}>Get your own copy</a>}
              {tryLink !== undefined && (
                <a className={`landing-btn ${getLink === undefined ? "landing-btn-live" : "landing-btn-ghost"}`} href={tryLink.href}>Try it on this device</a>
              )}
            </div>
            {tryLink !== undefined && (
              <p className="landing-hint">
                Try it keeps your work on this device
                <InfoTip label="About Try it">
                  It lives in this browser. If you clear the site's data it is gone, so move it to your own copy before you do.
                </InfoTip>
              </p>
            )}
            <Stage desk={deskToday} phone={phoneToday} deskId="today" phoneId="today" eager />
          </section>
        </div>

        <section className="landing-wrap landing-reveal" id="what">
          <ul className="landing-facts">
            {FACTS.map((fact) => (
              <li key={fact.head}><b>{fact.head}</b><span>{fact.body}</span></li>
            ))}
          </ul>
        </section>

        <section className="landing-wrap landing-section landing-reveal">
          <span className="landing-kicker">One map</span>
          <h2>Everything on one map. Today is what you pick.</h2>
          <ul className="landing-cards">
            {CARDS.map((card, i) => (
              <li key={card.head} className="landing-card">
                <span className="landing-card-n" aria-hidden="true">{i + 1}</span>
                <h3>{card.head}</h3>
                <p>{card.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing-wrap landing-section landing-reveal" id="see">
          <span className="landing-kicker">The real app</span>
          <h2>These are screenshots of VEMI itself.</h2>
          <Showcase />
        </section>

        <section className="landing-wrap landing-reveal" id="own">
          <div className="landing-dark">
            <div>
              <span className="landing-kicker">Your own copy</span>
              <h2>Run your own copy.</h2>
              <p className="landing-dark-body">A setup helper builds VEMI in your Cloudflare account in about five steps. It does not keep your key.</p>
              <p className="landing-hint landing-hint-left">
                Why Cloudflare
                <InfoTip label="Why Cloudflare" tone="on-dark">
                  Its free plan runs the app and its database. The account is yours, so the data stays with you.
                </InfoTip>
              </p>
              {getLink !== undefined && <a className="landing-btn landing-btn-live landing-dark-act" href={getLink.href}>Start setup</a>}
            </div>
            {map !== undefined && <img className="landing-dark-shot" src={map.src} alt={map.alt} width={2560} height={1600} loading="lazy" decoding="async" />}
          </div>
        </section>

        <section className="landing-wrap landing-cta landing-reveal" id="try">
          <span className="landing-kicker">{tryLink !== undefined ? "No account needed" : "Already here"}</span>
          <h2>{tryLink !== undefined ? "Try it now." : "Welcome back."}</h2>
          {tryLink !== undefined && <p className="landing-cta-body">No sign-up. It opens in this browser and keeps your work on this device.</p>}
          <div className="landing-acts landing-cta-acts">
            {tryLink !== undefined && <a className="landing-btn landing-btn-live" href={tryLink.href}>Try it now</a>}
            <button type="button" className={`landing-btn ${tryLink === undefined ? "landing-btn-live" : "landing-btn-ghost"}`} onClick={onSignIn}>
              {haveLabel}
            </button>
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        <div className="landing-wrap landing-foot-row">
          <span>Made by Anvil Dynamics</span>
          <span>
            MIT licence
            {repoLink !== undefined && <> &middot; <a href={repoLink.href}>{repoLink.label}</a></>}
          </span>
        </div>
      </footer>
    </div>
  );
}
