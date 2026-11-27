import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { lazyNamed } from "./lazyView.js";
import { ViewBoundary } from "./ui/ViewBoundary.js";
import type { Today, Tree } from "@vemi/shared";
import { api, askFrontLanding, paths } from "./api.js";
import { showsLanding } from "./landingLinks.js";
import { VaultProvider } from "./ui/Vault.js";
import { finishSignOut, me, signOut, type Me } from "./auth.js";
import { install, useInstallOffer } from "./installPrompt.js";
import { forgetKeptData } from "./keptData.js";
import { forgetSealed, refreshEncryption } from "./sealedApi.js";
import { checkDeviceKey, forgetKeyHere } from "./keyWays.js";
import { authLinkFrom, signedInNotice } from "./authLinks.js";
import { openOnPlace, refreshAppearance, startOnNow } from "./appearance.js";
import { singleKeysOn } from "./extras.js";
import { heldByOverlay, keyAction, ledAfter } from "./keys.js";
import { askForAbout, askForLedger } from "./ledgerReach.js";
import { prefillFrom } from "./newTask.js";
import { withPatience } from "./patience.js";
import { worthSendingAgain } from "./sendAgain.js";
import { monograms } from "./monogram.js";
import { KEPT, outcomeOf, wasKept, type Outcome } from "./outcome.js";
import { canonical, HOME, navigate, parseRoute, projectPage, routeAddress, surface, useRoute, venture, type Route, type Tab } from "./router.js";
import { listenForPush } from "./pushMessage.js";
import { showReminder } from "./reminderEvent.js";
import { riskItem } from "./ui/RiskTag.js";
import { titleFor } from "./pageTitle.js";
import { tellConnectorChanged } from "./connectorLinks.js";
import { connectLive, type LiveHandle, type LiveStatus } from "./state/live.js";
import { clearOutbox, drain, onWaiting, ownOutbox, queued } from "./state/outbox.js";
import { clearResources, endedSession, load, notifySignedOut, onSignedOut, refetchShown, useResource } from "./state/resources.js";
import { accountFrom, heedsSignOut, mustForget, oncePer, startFrom, type Gate } from "./session.js";
import { indexTree, type TreeIndex } from "./treeIndex.js";
import { did, forget, nextRedo, nextUndo, NOTHING, redoing, saidFor, undoing, type Step, type Undo } from "./undo.js";
import {
  AppContext, lastVenture, rememberVenture, UndoContext, useApp, type AppActions, type ComposeSeed, type HomeTarget, type IconTarget, type UndoState,
} from "./ui/appContext.js";
import { MoreMenu } from "./ui/Menu.js";
import { RenameSheet } from "./ui/RenameSheet.js";
import { SpaceSettings } from "./ui/SpaceSettings.js";
import { PhoneBar, placeOf, Rail, SkipLink, StatusLine, TopBar, VentureHeader, type Place } from "./ui/Chrome.js";
import { useNeedsCount } from "./needsCount.js";
import { Spoken } from "./ui/controls.js";
import { Notice, type NoticeAction } from "./ui/Notice.js";
import { DeletionBar } from "./ui/DeletionBar.js";
import { ReminderBanner } from "./ui/ReminderBanner.js";
import { Sheet } from "./ui/Sheet.js";
import type { MenuItem } from "./ui/Menu.js";
import { age } from "./format.js";
import { MapSurface } from "./ui/MapSurface.js";
import { NeedsYou } from "./ui/NeedsYou.js";
import { onShortcutsEvent } from "./searchState.js";
import { FirstRunBar } from "./ui/FirstRunBar.js";
import { MoveFinishHost } from "./ui/MoveFinishHost.js";
import { firstRunProgress } from "./firstVenture.js";
import { changeFirstRunStep, firstRunNow, forgetFirstRun, refreshFirstRun, useFirstRun } from "./firstRunState.js";
import { homeScreenStep, stepPlace, stepTitle } from "./firstRunSteps.js";
import { useLevelWords } from "./levelNames.js";
import { TodayView } from "./ui/Today.js";
import { PHONE, useMedia } from "./ui/useMedia.js";
import { watchSheetEntries } from "./sheetHistory.js";
import { currentWords } from "./levelNames.js";
import { levelRefusal, refusalMessage, spaceMenuWords } from "./levelWords.js";
import { channelSocket } from "./local/channelSocket.js";
import { isLocal } from "./local/mode.js";
import { openChannel } from "./local/parts.js";
import { askForDue, startTicker } from "./local/ticker.js";

// Fetched when first drawn, so the first screen downloads only what it uses.
const Landing = lazyNamed(() => import("./ui/Landing.js"), "Landing");
const ProjectPage = lazyNamed(() => import("./ui/ProjectPage.js"), "ProjectPage");
const TaskPage = lazyNamed(() => import("./ui/TaskPage.js"), "TaskPage");
const Account = lazyNamed(() => import("./ui/Account.js"), "Account");
const ArchiveView = lazyNamed(() => import("./ui/Archive.js"), "ArchiveView");
const BoardView = lazyNamed(() => import("./ui/Board.js"), "BoardView");
const Compose = lazyNamed(() => import("./ui/Compose.js"), "Compose");
const ReviewView = lazyNamed(() => import("./ui/Review.js"), "ReviewView");
const IconPicker = lazyNamed(() => import("./ui/IconPicker.js"), "IconPicker");
const NestPicker = lazyNamed(() => import("./ui/NestPicker.js"), "NestPicker");
const Palette = lazyNamed(() => import("./ui/Palette.js"), "Palette");
const SearchSheet = lazyNamed(() => import("./ui/Search.js"), "SearchSheet");
const Shortcuts = lazyNamed(() => import("./ui/Shortcuts.js"), "Shortcuts");
const FirstRunUse = lazyNamed(() => import("./ui/FirstRunUse.js"), "FirstRunUse");
const FirstVenture = lazyNamed(() => import("./ui/FirstVenture.js"), "FirstVenture");
const Connect = lazyNamed(() => import("./ui/Connect.js"), "Connect");
const SignIn = lazyNamed(() => import("./ui/SignIn.js"), "SignIn");
const TaskDetail = lazyNamed(() => import("./ui/TaskDetail.js"), "TaskDetail");
const VenturePage = lazyNamed(() => import("./ui/VenturePage.js"), "VenturePage");

/** Who is signed in on this device: the email `/auth/me` answered with. */
const SIGNED_IN = "vemi:signed-in:v1";

function remember(account: string | null): void {
  try {
    if (account !== null) localStorage.setItem(SIGNED_IN, account);
    else localStorage.removeItem(SIGNED_IN);
  } catch {
    // Without storage, an offline start shows the sign-in screen. Nothing is lost.
  }
}

/** The account an offline start opens as. */
function rememberedAccount(): string | null {
  try {
    return accountFrom(localStorage.getItem(SIGNED_IN));
  } catch {
    return null;
  }
}

/** What this device kept of one person's plans, gone: the reads in memory and the service worker's copy. */
async function forgetKept(account: string | null): Promise<void> {
  clearResources();
  forgetSealed();
  forgetFirstRun();
  // The key goes with it: the next person on a shared browser finds nothing (C15).
  // /try keeps its data in the page; the shared-origin read cache belongs to the signed-in app.
  await Promise.all([isLocal() ? Promise.resolve() : forgetKeptData(), forgetKeyHere(account)]);
}

/** Said on the sign-in card when the Worker, not the person, ended the session. */
const SESSION_ENDED = "This device was signed out: the sign-in ran out, or was ended from another device. Sign in again.";
/** Said on the sign-in card when the person signed out with no connection. */
const SIGNED_OUT_OFFLINE = "Signed out on this device. The server will forget this sign-in when you're back online.";

const discarded = (n: number): string =>
  `${n} ${n === 1 ? "change" : "changes"} made offline by another account on this device ${n === 1 ? "was" : "were"} discarded unsent.`;

export function App() {
  return <Gated />;
}

function Gated() {
  const [gate, setGate] = useState<Gate>("checking");
  const [googleReady, setGoogleReady] = useState(false);
  const [claimable, setClaimable] = useState(false);
  // A link opens `/reset#…` or `/invite#…`, and Google hands a refusal back
  // as `/#google=…`. The hash never reaches the Worker; it is read once and taken out of the
  // address and the history.
  const [link, setLink] = useState(() => authLinkFrom(window.location.pathname, window.location.hash));
  useEffect(() => {
    if (authLinkFrom(window.location.pathname, window.location.hash) !== null) window.history.replaceState(null, "", "/");
  }, []);

  // Said on the sign-in card, and said once in the shell.
  const [cardSaid, setCardSaid] = useState<string | null>(null);
  const [shellSaid, setShellSaid] = useState<string | null>(null);
  const gateRef = useRef<Gate>("checking");
  gateRef.current = gate;

  /**
   * In as `account`. When that is not who this device last held, nothing the last one kept is
   * shown, and nothing they left in the outbox is sent as this one. The copy is gone before
   * the shell is drawn, so no read of this account can be answered from the last one's.
   */
  const enter = useCallback(async (account: string | null, switched: boolean) => {
    const before = rememberedAccount();
    if (mustForget(account, before, switched)) await forgetKept(before);
    // After sign-in and on open: a device that was removed, or whose key was replaced, lets go of it.
    void checkDeviceKey(account);
    // Whether this account has full encryption on decides how every write after this is sent.
    void refreshEncryption().then(() => refetchShown());
    // The look the account kept: asked only now that someone is signed in, so a signed-out visit asks nothing.
    void refreshAppearance();
    const dropped = ownOutbox(account);
    if (dropped > 0) setShellSaid(discarded(dropped));
    remember(account);
    setCardSaid(null);
    setGate("in");
  }, []);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      // A sign-out made with no connection is finished before the cookie is trusted again.
      // Still unheard, the device stays out: it was signed out here, whatever the cookie says.
      // `/auth/me` is asked all the same, for whether the card can offer Google and the owner account, but not waited on.
      const heard = await withPatience(finishSignOut()).catch(() => false);
      const asked = me();
      asked.then((m) => {
        if (!mounted) return;
        setGoogleReady(m.googleReady);
        setClaimable(m.claimable === true);
      }, () => undefined);
      // No answer is no connection, or too slow to wait for.
      const answer = heard ? await asked.catch(() => null) : null;
      if (!mounted) return;
      const start = startFrom(heard, answer, rememberedAccount());
      if (start.kind === "enter") {
        await enter(start.account, false);
      } else if (start.kind === "kept") {
        // Someone who was signed in on this device gets what it kept.
        ownOutbox(start.account);
        setGate("in");
      } else {
        remember(null);
        setCardSaid(start.unheard ? SIGNED_OUT_OFFLINE : null);
        setGate("out");
      }
    })();
    return () => {
      mounted = false;
    };
  }, [enter]);

  // Signed out at `/`, the copy's front page may show first. Asked once the gate says out; until
  // answered the screen stays blank, and a failed ask reads as off.
  const [landing, setLanding] = useState<boolean | null>(null);
  const [choseSignIn, setChoseSignIn] = useState(false);
  useEffect(() => {
    if (gate !== "out") return;
    let mounted = true;
    void askFrontLanding().then((on) => { if (mounted) setLanding(on); });
    return () => { mounted = false; };
  }, [gate]);

  // A sign-out still unheard is sent the moment there is a connection to send it on. Then the
  // card asks again whether it can offer Google and the owner account: a start with no connection could not tell.
  useEffect(() => {
    if (gate !== "out") return;
    const online = (): void => {
      void (async () => {
        if (!await finishSignOut()) return;
        const answer = await me().catch(() => null);
        if (answer === null) return;
        setGoogleReady(answer.googleReady);
        setClaimable(answer.claimable === true);
      })();
    };
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [gate]);

  /** Every way out ends here: the Worker's 401, Account's Sign out, the first-venture card's. */
  const signedOut = useCallback((said: string | null) => {
    const was = rememberedAccount();
    remember(null);
    ownOutbox(null);
    void forgetKept(was);
    setCardSaid(said);
    setGate("out");
  }, []);

  useEffect(() => onSignedOut(() => {
    if (heedsSignOut(gateRef.current)) signedOut(SESSION_ENDED);
  }), [signedOut]);

  /**
   * The person chose to sign out, and was told first what it costs. What is still waiting
   * goes before the request does, so no drain can send it meanwhile.
   */
  const signOutHere = useCallback(async (): Promise<void> => {
    ownOutbox(null);
    clearOutbox();
    const heard = await signOut();
    signedOut(heard ? null : SIGNED_OUT_OFFLINE);
  }, [signedOut]);

  // A token page shows even when signed in: the link was sent for it, and finishing it signs in.
  const tokenPage = link !== null && link.kind !== "google";
  if (gate === "checking") return <div className="boot" />;
  if (gate === "out" && !tokenPage && link === null && !choseSignIn && window.location.pathname === "/") {
    if (landing === null) return <div className="boot" />;
    if (showsLanding({ pathname: window.location.pathname, hasLink: false, landing, choseSignIn })) {
      return <ViewBoundary fallback={<div className="boot" />}><Landing onSignIn={() => setChoseSignIn(true)} /></ViewBoundary>;
    }
  }
  if (gate !== "in" || tokenPage) {
    return (
      <ViewBoundary fallback={<div className="boot" />}>
      <SignIn googleReady={googleReady} claimable={claimable} signedIn={gate === "in"} link={link} notice={cardSaid}
        // Out, the card is what is left; signed in, the shell is.
        onLeave={() => setLink(null)}
        onSignedIn={async () => {
          // The sign-in is already made: no patience here, or a slow answer would read as a refusal
          // and a second press would open a second session.
          const m = await me({ patient: false });
          if (!m.signedIn) throw new Error("The sign-in did not hold. Try again.");
          // A token page may have signed another account in over the one this tab was showing.
          await enter(m.email ?? null, tokenPage);
          setLink(null);
        }} />
      </ViewBoundary>
    );
  }
  // An app asking to be let in: a page of its own, not a surface of the shell, so the shell's
  // rewriting of an address it does not know never sees the request in it.
  if (window.location.pathname === "/connect") return <ViewBoundary fallback={<div className="boot" />}><Connect /></ViewBoundary>;
  const said = signedInNotice(link) ?? shellSaid;
  return (
    <VaultProvider account={rememberedAccount()}>
      <Shell said={said} onSaid={() => { setLink(null); setShellSaid(null); }} onSignOut={signOutHere} />
    </VaultProvider>
  );
}

interface Said {
  readonly message: string;
  readonly action?: NoticeAction;
  /** The step this notice's Undo or Redo is for. A notice that names one goes once another lands. */
  readonly step?: Step;
}

/** How often a live channel that keeps failing asks whether the session is still there. */
const SESSION_CHECK_MS = 60_000;

/** The date on this device, to notice midnight passing on a page left open. */
const localDay = (): string => new Date().toDateString();

/** How long after a lone `G` its second key still counts (`keys.ts`). */
const LEAD_MS = 1500;

/** A desk's ⋯ carries nothing extra: one empty list, so it never reads as a change. */
const NO_MENU: readonly MenuItem[] = [];

/** Whether this page has pushed a history entry of its own, so Back stays inside VEMI. */
let steppedHere = false;
let openedOn = false;

function Shell({ said, onSaid, onSignOut }: {
  readonly said: string | null;
  readonly onSaid: () => void;
  readonly onSignOut: () => Promise<void>;
}) {
  const route = useRoute();
  const phone = useMedia(PHONE);
  const [live, setLive] = useState<LiveStatus>("connecting");
  const liveRef = useRef<LiveStatus>("connecting");
  const liveHandle = useRef<LiveHandle | null>(null);
  const [waiting, setWaiting] = useState(() => queued().length);
  // A Google refusal from linking in the account panel arrives as the first notice, said once.
  const [notice, setNotice] = useState<Said | null>(() => (said === null ? null : { message: said }));
  useEffect(() => {
    if (said !== null) onSaid();
  }, [said, onSaid]);
  // After the sheets this first draw opens have taken their entries (`sheetHistory.ts`).
  useEffect(() => watchSheetEntries(), []);
  const [composeSeed, setComposeSeed] = useState<ComposeSeed | null>(null);
  const [iconTarget, setIconTarget] = useState<IconTarget | null>(null);
  const [homeTarget, setHomeTarget] = useState<HomeTarget | null>(null);
  const [needsOpen, setNeedsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** A task opened from this page, so closing it can step back rather than leave a dead Back. */
  const openedHere = useRef(false);

  const today = useResource<Today>(paths.today);
  const tree = useResource<Tree>(paths.tree);
  // First run: the account's step, a number while it is on. The shell draws as usual with the
  // step bar over the page; the steps do their work in the real screens.
  const firstRun = useFirstRun();
  const words = useLevelWords();
  const homeOffer = useInstallOffer();
  const homeScreen = homeScreenStep({ phone, standalone: false, offer: homeOffer, local: isLocal() });
  // Steps 2 to 5 each make one thing in its own screen. What the account already holds decides
  // the step (made before it was saved, or on another device), and a step that is reached opens
  // its screen once: the space's projects, the project's page, Today.
  const progress = firstRun.step === null ? null : firstRunProgress(firstRun.step, tree.data, today.data);
  const reached = useRef<number | null>(null);
  useEffect(() => {
    if (progress === null || firstRun.step === null) {
      reached.current = null;
      return;
    }
    if (progress.step !== firstRun.step) changeFirstRunStep(progress.step);
    const at = progress.step;
    if (reached.current === at) return;
    const target = at === 3 && progress.ventureId !== null ? venture(progress.ventureId, "projects")
      : (at === 4 || at === 5) && progress.ventureId !== null && progress.projectId !== null ? projectPage(progress.ventureId, progress.projectId)
        : at === 6 ? surface("today")
          : null;
    if (target === null && at !== 2) return;
    reached.current = at;
    if (target !== null) navigate(target, { replace: true });
  }, [progress?.step, progress?.ventureId, progress?.projectId, firstRun.step]);
  const index = useMemo(() => (tree.data === null ? null : indexTree(tree.data)), [tree.data]);

  // Who is signed in, asked here and kept fresh by the Account panel, which opens drawn from it
  // rather than waiting on the Worker. A start with no connection gets no answer, so it is
  // asked again when the live channel comes up, until one arrives.
  const [known, setKnown] = useState<Me | null>(null);
  const knownRef = useRef<Me | null>(null);
  knownRef.current = known;
  const askingMe = useRef(false);
  const askMe = useCallback(() => {
    if (knownRef.current !== null || askingMe.current) return;
    askingMe.current = true;
    me().then(setKnown, () => undefined).finally(() => { askingMe.current = false; });
  }, []);
  useEffect(() => askMe(), [askMe]);

  // A notice's Undo is for the write it names: the step that write put on the stack, held
  // as the notice is said. Pressed later, it runs that step or nothing, never whatever else
  // landed on top meanwhile. The two refs read the stack as it is when pressed.
  const undoNow = useRef<(only: Step) => void>(() => undefined);
  const redoNow = useRef<(only: Step) => void>(() => undefined);
  /** The step the last write that answered put on the stack, or null when it put none. */
  const lastStep = useRef<Step | null>(null);
  /** Edits begun of each record's field, `kind/id/field`: so a Try again knows when it is overtaken. */
  const editsBegun = useRef(new Map<string, number>());
  const say = useCallback((message: string, options?: { readonly undo?: boolean }) => {
    const step = options?.undo === true ? lastStep.current : null;
    setNotice(step === null ? { message } : { message, step, action: { label: "Undo", run: () => undoNow.current(step) } });
  }, []);

  const flush = useCallback(() => {
    void drain(fetch, (_entry, why) => say(`A change made offline was refused: ${levelRefusal(why, currentWords())}`)).then((result) => {
      // What is left waits for the same account to sign back in.
      if (result.signedOut) notifySignedOut();
      else if (result.sent > 0 || result.refused > 0) refetchShown();
    });
  }, [say]);

  useEffect(() => {
    // A socket refused for want of a session closes like one with no connection: the browser
    // gives no reason. So while it is down, a small read now and then asks, and a 401 there
    // signs the device out through the resources. With no connection it fails quietly.
    const ask = oncePer(SESSION_CHECK_MS);
    const handle = connectLive({
      // The copy at /try has no server to hold a socket to: its changes come over a channel between this device's tabs.
      ...(isLocal() ? { socket: () => channelSocket(openChannel()) } : {}),
      onChange: refetchShown,
      onConnector: tellConnectorChanged,
      onStatus: (next) => {
        liveRef.current = next;
        setLive(next);
        if (next === "live") {
          void refreshEncryption().then(flush);
          askMe();
        }
        if (next === "offline" && ask(Date.now())) void load(paths.overview);
      },
    });
    liveHandle.current = handle;
    return () => {
      handle.close();
      liveHandle.current = null;
    };
  }, [flush, askMe]);

  useEffect(() => onWaiting(setWaiting), []);

  // The worker hands a visible tab the reminder to draw, and a tab it focused the page to open.
  useEffect(() => {
    // A copy in the page has no push service: its reminders come from the minute's check.
    if (isLocal()) return startTicker({ run: askForDue(), show: showReminder, page: document });
    if (!("serviceWorker" in navigator)) return undefined;
    return listenForPush(navigator.serviceWorker, {
      show: showReminder,
      open: (url) => {
        const to = new URL(url, window.location.origin);
        navigate(parseRoute(to.pathname, to.search));
      },
    });
  }, []);

  useEffect(() => {
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [flush]);

  // A phone picked up again, or a desk tab come back to: the socket may have died quietly and
  // anything could have changed. And a page left open overnight must not pick for yesterday.
  useEffect(() => {
    let day = localDay();
    const wake = (): void => {
      if (document.visibilityState !== "visible") return;
      day = localDay();
      liveHandle.current?.nudge();
      void refreshEncryption().then(() => {
        refetchShown();
        flush();
      });
    };
    const midnight = window.setInterval(() => {
      if (localDay() === day) return;
      day = localDay();
      refetchShown();
    }, 60_000);
    document.addEventListener("visibilitychange", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.clearInterval(midnight);
    };
  }, [flush]);

  // An old link, or a venture page with no tab, is rewritten to the path it resolved to
  // (decision 4). Replaced rather than pushed, so Back does not return to a dead path.
  useEffect(() => {
    const at = routeAddress();
    const href = canonical(route, at.pathname, at.search);
    if (href !== null) window.history.replaceState(null, "", href);
  }, [route]);

  // Open on: the bare address opens where the account says, once, when the app first draws.
  // Only a load of `/` is followed; going to Map from inside the app stays the map.
  // It waits for the account's first run answer, and does not fire while first run is on.
  useEffect(() => {
    if (openedOn) return;
    openedOn = true;
    void refreshFirstRun().then(() => {
      if (firstRunNow().step !== null) return;
      // Read through the router, so a copy kept in the page (its route in the hash) is followed too.
      const at = routeAddress();
      if (openOnPlace(at.pathname, at.search, startOnNow()) === "today") {
        navigate(surface("today"), { replace: true });
      }
    });
  }, []);

  // A venture that is not there — archived, deleted, or a mistyped link — is the map.
  const ventureKnown = route.ventureId === null || index === null || index.ventures.has(route.ventureId);
  useEffect(() => {
    if (!ventureKnown) navigate(HOME, { replace: true });
  }, [ventureKnown]);

  useEffect(() => {
    if (route.ventureId !== null && index?.ventures.has(route.ventureId) === true) rememberVenture(route.ventureId);
  }, [route.ventureId, index]);

  // A project or task page for something archived, deleted or moved to another venture is
  // that venture's tab, not a blank page.
  const itemName = index === null || route.itemId === null ? null
    : route.surface === "project" ? index.ventures.get(route.ventureId ?? "")?.projects.find((p) => p.id === route.itemId)?.name ?? null
    : route.surface === "task" && index.tasks.get(route.itemId)?.venture.id === route.ventureId ? index.tasks.get(route.itemId)?.task.title ?? null
    : null;
  const itemGone = index !== null && route.itemId !== null && ventureKnown && itemName === null;
  useEffect(() => {
    if (itemGone && route.ventureId !== null) navigate(venture(route.ventureId, route.tab ?? "board"), { replace: true });
  }, [itemGone, route.ventureId, route.tab]);

  const to = useCallback((next: Route, options: { readonly replace?: boolean } = {}) => {
    if (options.replace !== true) steppedHere = true;
    navigate(next, options);
  }, []);

  /** Leave add, search or account: back where you came from if that was here, else the map. */
  const leave = useCallback(() => {
    if (steppedHere) window.history.back();
    else navigate(HOME, { replace: true });
  }, []);

  const compose = useCallback((seed: ComposeSeed = {}) => {
    setComposeSeed(seed);
    to(surface("add"));
  }, [to]);

  const go = useCallback((place: Place) => {
    if (place === "add") {
      compose(prefillFrom(route));
      return;
    }
    to(place === "map" ? HOME : surface(place));
  }, [route, compose, to]);

  useEffect(() => {
    if (route.taskId === null) openedHere.current = false;
  }, [route.taskId]);

  // The sheets this shell holds belong to the page they were opened on. Another page, by a
  // row inside one or by Back, is not drawn under the last page's sheet.
  useEffect(() => {
    setIconTarget(null);
    setHomeTarget(null);
    setNeedsOpen(false);
    setPaletteOpen(false);
    setShortcutsOpen(false);
  }, [route.surface, route.ventureId, route.itemId, route.taskId]);

  // The Shortcuts quick action on Search raises a window event; the sheet opens over a
  // closed palette, as the help key does.
  useEffect(() => onShortcutsEvent(window, () => {
    setPaletteOpen(false);
    setShortcutsOpen(true);
  }), []);

  // Read as the task opens rather than closed over, so opening one is the same function from
  // page to page and nothing that holds it redraws for a navigation.
  const routeNow = useRef(route);
  routeNow.current = route;
  const openTask = useCallback((id: string | null) => {
    const route = routeNow.current;
    if (id === null) {
      if (openedHere.current) {
        openedHere.current = false;
        window.history.back();
        return;
      }
      navigate({ ...route, taskId: null }, { replace: true });
      return;
    }
    // One task open at a time: going from one to another replaces, so Back closes the panel.
    const switching = route.taskId !== null;
    if (!switching) openedHere.current = true;
    to({ ...route, taskId: id }, { replace: switching });
  }, [to]);

  const clearNotice = useCallback(() => setNotice(null), []);

  // Decision 20. The stack is state because the undo and redo buttons are drawn from it. It is
  // held in a ref too, which undo, redo and every write read, so they stay the same functions
  // as it moves and nothing holding them redraws for it.
  const [undo, setUndo] = useState<Undo>(NOTHING);
  const undoRef = useRef<Undo>(NOTHING);
  const restack = useCallback((change: (u: Undo) => Undo) => {
    undoRef.current = change(undoRef.current);
    setUndo(undoRef.current);
  }, []);
  const undoState = useMemo<UndoState>(
    () => ({ undoable: nextUndo(undo)?.what ?? null, redoable: nextRedo(undo)?.what ?? null }), [undo]);

  // What a phone hides, for every page's ⋯ there: the needs-you list, and the status line read in full, where the
  // line over the phone bar says only what is news.
  const installable = useInstallOffer();
  // When what is drawn is this device's copy rather than the Worker's answer just now.
  const kept = [today, tree].find((r) => r.fromCopy && r.receivedAt !== null)?.receivedAt ?? null;
  // The status line as one string, so the menu is made again when what it says changes and
  // not for every redraw.
  const statusSaid = !phone ? "" : [
    live === "live" ? "Connected" : live === "connecting" ? "Connecting…" : "No connection",
    waiting > 0 ? `${waiting} waiting to send` : null,
    kept === null ? null : `showing what this device kept, ${age(kept)}`,
  ].filter((x): x is string => x !== null).join(" · ");
  const phoneMenu = useMemo<readonly MenuItem[]>(() => {
    if (!phone) return NO_MENU;
    return [
      { label: "Needs you", run: () => setNeedsOpen(true) },
      ...(installable !== "button" ? [] : [{ label: "Install VEMI", run: () => void install() }]),
      { label: statusSaid },
    ];
  }, [phone, live, statusSaid, installable, to]);

  const actions = useMemo<AppActions>(() => {
    const refresh = (): void => {
      if (liveRef.current !== "live") refetchShown();
    };
    // A 401 is no refusal to show: the session is over, and the sign-in card says so.
    const failed = (err: unknown): void => {
      if (!endedSession(err)) say(refusalMessage(err, currentWords()));
    };
    /**
     * A write the Worker agreed to, or this device kept, goes on the stack. A notice that
     * offers to undo or redo some earlier step goes: its button would now reach past this one.
     */
    const record = (step: Step | undefined): void => {
      lastStep.current = step ?? null;
      if (step === undefined) return;
      restack((u) => did(u, step));
      setNotice((n) => (n?.step === undefined ? n : null));
    };
    /**
     * Every write goes through here, so this is where a failure is answered.
     *
     * What is on screen is held, not rolled back: the fields that travel whole keep what was
     * typed in the component that typed it, and nothing here refetches over the top of it. So
     * a failure the Worker never answered gets the offer to send the same write again, and on
     * the way through a second time it lands on the undo stack exactly as the first would
     * have. A refusal has been read and answered, so it says so and stops there.
     *
     * A write this device kept says so, and answers `"kept"`: the caller then leaves that
     * notice standing rather than saying over it that the thing is done. A batch is kept
     * when any write in it was.
     *
     * `superseded` says when that Try again has been overtaken: the same fields of the same
     * record have been written since, by the field the failure reopened or by a new edit.
     * Pressed then, it sends nothing, so a retry neither lands twice on the stack nor puts
     * back over a newer text the one that failed.
     */
    const act = async (work: () => Promise<unknown>, step?: Step, superseded?: () => boolean): Promise<Outcome> => {
      try {
        const outcome = outcomeOf(await work());
        // Only now: a step on the stack is a write the Worker agreed to, or one this device
        // holds in order, so its way back is sent after it.
        record(step);
        if (outcome === "kept") say(KEPT);
        else refresh();
        return outcome;
      } catch (err) {
        if (!worthSendingAgain(err)) {
          failed(err);
          return false;
        }
        const said = refusalMessage(err, currentWords());
        setNotice({
          message: `${said} What you changed is still here.`,
          action: { label: "Try again", run: () => { if (superseded?.() !== true) void act(work, step, superseded); } },
        });
        return false;
      }
    };
    /** A step run one way or the other, and said: "Undid: moved to Done.", with the way back again. */
    const run = (step: Step, way: "undo" | "redo"): void => {
      void step[way]().then((answer) => {
        const held = wasKept(answer);
        if (!held) refresh();
        setNotice({
          message: saidFor(way, step, held ? KEPT : null),
          step,
          action: way === "undo"
            ? { label: "Redo", run: () => redoNow.current(step) }
            : { label: "Undo", run: () => undoNow.current(step) },
        });
      }, (err: unknown) => { restack((u) => forget(u, step)); failed(err); });
    };
    const undoStep = (only?: Step): void => {
      const { next, step } = undoing(undoRef.current, only);
      if (step === null) return;
      restack(() => next);
      run(step, "undo");
    };
    const redoStep = (only?: Step): void => {
      const { next, step } = redoing(undoRef.current, only);
      if (step === null) return;
      restack(() => next);
      run(step, "redo");
    };
    undoNow.current = undoStep;
    redoNow.current = redoStep;
    return {
      today: today.data?.on ?? null,
      phone,
      openTask,
      compose,
      search: () => to(surface("search")),
      pickIcon: setIconTarget,
      pickHome: setHomeTarget,
      notify: say,
      phoneMenu,
      act,
      edit: (kind, id, fields, current, what) => {
        // The way back is read off the record as it stands before the write is sent.
        const now = current as Readonly<Record<string, unknown>>;
        const was: Record<string, unknown> = {};
        for (const key of Object.keys(fields)) was[key] = now[key] ?? null;
        // Each field this writes, and how many edits of it had begun with this one's latest go.
        const keys = Object.keys(fields).map((key) => `${kind}/${id}/${key}`);
        let mine: number[] = [];
        const begin = (): void => {
          mine = keys.map((key) => {
            const n = (editsBegun.current.get(key) ?? 0) + 1;
            editsBegun.current.set(key, n);
            return n;
          });
        };
        return act(() => {
          begin();
          return api.update(kind, id, fields);
        }, {
          what,
          undo: () => api.update(kind, id, was),
          redo: () => api.update(kind, id, fields),
        }, () => keys.some((key, i) => editsBegun.current.get(key) !== mine[i]));
      },
      undo: () => undoStep(),
      redo: () => redoStep(),
      archive: async (kind, id, what) => {
        try {
          const result = await api.archive(kind, id);
          if (wasKept(result)) {
            lastStep.current = null;
            say(`Kept on this device. The ${what} is archived when the connection is back.`);
            return true;
          }
          refresh();
          // On the stack like any other write, and its notice's Undo is that step's: the
          // stack, the Undo button's label and redo all move with the press.
          record({
            what: `archived the ${what}`,
            undo: () => api.unarchive(kind, id),
            redo: () => api.archive(kind, id),
          });
          say(`Archived the ${what}. The archive keeps it.`, { undo: true });
          return true;
        } catch (err) {
          failed(err);
          return false;
        }
      },
    };
  }, [today.data?.on, phone, openTask, compose, to, say, restack, phoneMenu]);

  const leaving = route.surface === "add" || route.surface === "search" || route.surface === "account";
  /** When a lone `G` was last pressed, for the key after it. */
  const ledAt = useRef(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const now = Date.now();
      const action = keyAction(event, now - ledAt.current < LEAD_MS, singleKeysOn());
      ledAt.current = ledAfter(event, action, ledAt.current, now);
      if (action === null) return;
      if ((paletteOpen || shortcutsOpen) && heldByOverlay(action)) return;
      switch (action.type) {
        case "lead":
          return;
        case "go": {
          event.preventDefault();
          to(action.place === "map" ? HOME : surface(action.place));
          return;
        }
        case "close":
          // The handoff's Escape: the sheet closes and the notice goes. Selection is cleared
          // by the surface that holds it. A picker over everything goes first.
          setNotice(null);
          if (paletteOpen) setPaletteOpen(false);
          else if (shortcutsOpen) setShortcutsOpen(false);
          else if (iconTarget !== null) setIconTarget(null);
          else if (homeTarget !== null) setHomeTarget(null);
          else if (needsOpen) setNeedsOpen(false);
          else if (route.taskId !== null) openTask(null);
          else if (leaving) leave();
          return;
        case "undo":
          event.preventDefault();
          actions.undo();
          return;
        case "redo":
          event.preventDefault();
          actions.redo();
          return;
        case "palette":
          // Cmd or Ctrl K again closes it; the browser's own use of the key is not wanted.
          event.preventDefault();
          setShortcutsOpen(false);
          setPaletteOpen((open) => !open);
          return;
        case "help":
          event.preventDefault();
          setPaletteOpen(false);
          setShortcutsOpen(true);
          return;
        case "project": {
          // A new project starts on the last opened space's Projects tab.
          event.preventDefault();
          const last = lastVenture();
          to(last === null ? HOME : venture(last, "projects"));
          return;
        }
        case "search":
          event.preventDefault();
          if (route.surface !== "search") to(surface("search"));
          return;
        case "compose":
          event.preventDefault();
          compose(prefillFrom(route));
          return;
        case "tab":
          // A project's or a task's page shows the pill too, and the keys do what it does.
          if (route.ventureId !== null && (route.surface === "venture" || route.surface === "project" || route.surface === "task")) {
            to(venture(route.ventureId, action.tab));
          }
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, shortcutsOpen, iconTarget, homeTarget, needsOpen, route, leaving, openTask, leave, compose, to, actions, index]);

  const ventureName = route.ventureId === null ? null : index?.ventures.get(route.ventureId)?.name ?? null;
  // The tab says where it is, so three tabs of this are not three tabs called VEMI.
  useEffect(() => {
    document.title = titleFor(route, ventureName, itemName);
  }, [route, ventureName, itemName]);

  const at = placeOf(route) ?? "map";
  const needs = useNeedsCount();

  const view = (() => {
    switch (route.surface) {
      case "map": return firstRun.step === 1 ? <FirstRunUse /> : firstRun.step === 2 ? <FirstVenture /> : <MapSurface />;
      case "venture":
      case "project":
      case "task":
        return route.ventureId === null || index === null || !ventureKnown ? null : (
          <VentureSurface index={index} route={route} ventureId={route.ventureId} tab={route.tab ?? "board"}
            onTab={(t) => to(venture(route.ventureId ?? "", t))} onBack={() => to(HOME)} />
        );
      case "today":
        return (
          <div className="today-row">
            <TodayView />
            {!phone && <NeedsYou />}
          </div>
        );
      case "add": return <Compose seed={composeSeed ?? {}} onClose={leave} />;
      case "search": return <SearchSheet onClose={leave} />;
      case "archive": return <ArchiveView />;
      case "review": return <ReviewView />;
      case "account": return <Account onClose={leave} onSignOut={onSignOut} live={live} waiting={waiting}
        known={known} onKnown={setKnown} />;
    }
  })();

  // Where the bar's title goes back to, when the person has wandered off the step's screen.
  const stepScreen = firstRun.step === null ? null : stepPlace(firstRun.step);
  const spaceHere = progress?.ventureId ?? null;
  const projectHere = progress?.projectId ?? null;
  const stepRoute: Route = stepScreen === "today" ? surface("today")
    : stepScreen === "space" && spaceHere !== null ? venture(spaceHere, "projects")
      : stepScreen === "project" && spaceHere !== null && projectHere !== null ? projectPage(spaceHere, projectHere)
        : HOME;
  const wandered = stepScreen === "map" ? route.surface !== "map"
    : stepScreen === "today" ? route.surface !== "today"
      : stepScreen === "space" ? route.surface !== "venture" || route.ventureId !== spaceHere || route.tab !== "projects"
        : stepScreen === "project" ? route.surface !== "project" || route.itemId !== projectHere
          : false;
  // Step 5's one button: the task made in step 4 goes on the server's today, and Today opens.
  const putOnToday = (): void => {
    const id = progress?.taskId ?? null;
    const on = today.data?.on ?? null;
    if (id === null || on === null) return;
    void actions.act(() => api.update("tasks", id, { pickedOn: on }), {
      what: "added it to today",
      undo: () => api.update("tasks", id, { pickedOn: null }),
      redo: () => api.update("tasks", id, { pickedOn: on }),
    }).then((ok) => {
      if (ok === false) return;
      if (ok === "sent") actions.notify("Added to today.", { undo: true });
      to(surface("today"));
      changeFirstRunStep(6);
    });
  };
  const stepBar = firstRun.step === null ? null : (
    <FirstRunBar step={firstRun.step} homeScreen={homeScreen} phone={phone} title={stepTitle(firstRun.step, words)}
      onSkip={() => changeFirstRunStep(null)}
      onOpen={wandered ? () => to(stepRoute) : undefined}
      action={firstRun.step === 5 && progress?.taskId != null && today.data !== null ? { label: "Put it on today", onClick: putOnToday } : undefined} />
  );

  return (
    <AppContext.Provider value={actions}>
      <UndoContext.Provider value={undoState}>
        <div className={`page${phone ? " phone" : ""}`}>
          <SkipLink target="main" />
          {!phone && <Rail at={at} onGo={go} needs={needs} />}
          <TopBar route={route} ventureName={ventureName} itemName={itemName} phone={phone} onGo={to} onSearch={() => { setShortcutsOpen(false); setPaletteOpen(true); }} />
          <main id="main" tabIndex={-1} className="page-body">{stepBar}<MoveFinishHost /><ViewBoundary fallback={null}>{view}</ViewBoundary></main>
          {/* On a phone too, along the top of the phone bar: with no signal, a screen that does
              not say it is a kept copy looks live. */}
          <StatusLine live={live} waiting={waiting} kept={kept} />
          {phone && <PhoneBar at={at} onGo={go} needs={needs} />}
        </div>
        <ReminderBanner />
        <DeletionBar deleteOn={known?.deleteOn} onCancelled={() => setKnown((was) => (was === null ? was : { ...was, deleteOn: null }))} />
        <Spoken text={notice?.message ?? ""} />
        {notice !== null && <Notice message={notice.message} action={notice.action} onClose={clearNotice} />}
        <ViewBoundary fallback={null}>
        {route.taskId !== null && <TaskDetail taskId={route.taskId} onClose={() => openTask(null)} />}
        {iconTarget !== null && <IconPicker target={iconTarget} onClose={() => setIconTarget(null)} />}
        {homeTarget !== null && <NestPicker target={homeTarget} onClose={() => setHomeTarget(null)} />}
        {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
        {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}
        </ViewBoundary>
        {needsOpen && (
          <Sheet onClose={() => setNeedsOpen(false)} placement="centre" label="needs you">
            <div className="sheet-head">
              <span className="kicker">Needs you</span>
              <span className="fill" />
              <button type="button" className="close-button" aria-label="close" onClick={() => setNeedsOpen(false)}>×</button>
            </div>
            <div className="sheet-body" onClick={(e) => { if ((e.target as HTMLElement).closest(".needs-row") !== null) setNeedsOpen(false); }}>
              <NeedsYou />
            </div>
          </Sheet>
        )}
      </UndoContext.Provider>
    </AppContext.Provider>
  );
}

/**
 * Inside a venture: its header, the pill of its two surfaces, and the one that is open.
 * Keyed by the venture so entering one rises in, and moving between its tabs does not.
 */
function VentureSurface({ index, route, ventureId, tab, onTab, onBack }: {
  readonly index: TreeIndex;
  readonly route: Route;
  readonly ventureId: string;
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  readonly onBack: () => void;
}) {
  const app = useApp();
  const menuWords = spaceMenuWords(useLevelWords());
  const letters = useMemo(() => monograms(index.ordered), [index]);
  const [sheet, setSheet] = useState<"rename" | "settings" | null>(null);
  const v = index.ventures.get(ventureId);
  if (v === undefined) return null;
  const renameSpace = async (next: string, was: string): Promise<Outcome | boolean> => {
    const name = next.trim();
    if (name === "") return false;
    return app.edit("ventures", ventureId, { name }, { name: was }, `renamed ${was}`);
  };
  // On a venture's own tabs the header's ⋯ is the venture's; a project's or a task's page
  // carries its own, so a page never has two.
  const ventureMenu = route.surface !== "venture" ? null : (
    <MoreMenu label={`${menuWords.noun} ${v.name}`} items={[
      { label: menuWords.add, run: () => app.compose({ ventureId }) },
      { label: "Rename", run: () => setSheet("rename") },
      { label: "Settings", run: () => setSheet("settings") },
      // About sits closed at the foot of Projects: each of these opens it and shows the part asked for.
      { label: menuWords.about, run: () => { askForAbout(ventureId); navigate(venture(ventureId, "projects")); } },
      { label: "Decisions and risks", run: () => { askForLedger(ventureId); navigate(venture(ventureId, "projects")); } },
      riskItem(app, "ventures", v),
      { label: "Choose an icon", run: () => app.pickIcon({ kind: "ventures", id: v.id, label: v.name, current: v.icon }) },
      { label: menuWords.archive, tone: "remove", run: () => { void app.archive("ventures", ventureId, menuWords.noun).then((ok) => { if (ok) navigate(HOME); }); } },
      ...app.phoneMenu,
    ]} />
  );
  const body = (() => {
    if (route.surface === "project" && route.itemId !== null) return <ProjectPage ventureId={ventureId} projectId={route.itemId} />;
    if (route.surface === "task" && route.itemId !== null) return <TaskPage ventureId={ventureId} taskId={route.itemId} />;
    // A route on a view that is off shows the first view that is on.
    switch (v.views.includes(tab) ? tab : v.views[0]) {
      case "board": return <BoardView ventureId={ventureId} />;
      case "projects": return <VenturePage ventureId={ventureId} />;
    }
  })();
  return (
    <div className="venture-surface" key={ventureId}>
      {route.surface === "venture" && <VentureHeader name={v.name} letters={letters.get(v.id) ?? ""} icon={v.icon} tab={tab} onTab={onTab} onBack={onBack} menu={ventureMenu} views={v.views}
        onRename={(next, was) => renameSpace(next, was ?? v.name)} />}
      {sheet === "rename" && <RenameSheet what={menuWords.noun} name={v.name} onClose={() => setSheet(null)} onRename={(next) => renameSpace(next, v.name)} />}
      {sheet === "settings" && <SpaceSettings ventureId={ventureId} onClose={() => setSheet(null)} />}
      <div className={`venture-body venture-${route.surface === "venture" ? tab : route.surface}`}><ViewBoundary fallback={null}>{body}</ViewBoundary></div>
    </div>
  );
}
