import { useEffect, useState } from "react";
import { PASSWORD_MIN } from "@vemi/shared";
import { acceptInvite, asksForCode, AuthError, claim, googleStart, linkHolder, recover, reset, signIn, type LinkHolder } from "../auth.js";
import { googleRefusal, type AuthLink } from "../authLinks.js";
import { inviteGreeting } from "../peopleRows.js";
import { SIGN_IN_TITLE } from "../pageTitle.js";
import { signInRefused } from "../signInWords.js";
import { Field, Gate } from "./Gate.js";

type Token = Extract<AuthLink, { token: string }>;

const FIELDS: Readonly<Record<Token["kind"], { readonly submit: string; readonly title: string }>> = {
  reset: { submit: "Set password", title: "Choose a new password" },
  invite: { submit: "Create account", title: "Create your account" },
};

const NOT_SAME = "The two passwords are not the same.";

/**
 * What the Worker said of a link before anything was typed: the address it was sent
 * to, or that it is dead. Null while it is being asked, or when there is no connection to ask
 * on: then the form shows, and spending the link is the check.
 */
type Holder = LinkHolder | { readonly dead: string } | null;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The rule a new password is held to, said once under the field it applies to. */
const passwordRule = `At least ${PASSWORD_MIN} characters.`;

/**
 * A new password and the same again. The first says the rule the Worker holds it to; the
 * second says "Matches" only when the two really are the same, and when they are not it says
 * so, in the words the refusal uses.
 */
function PasswordPair({ first, second, password, again, autoFocus, onPassword, onAgain }: {
  readonly first: string;
  readonly second: string;
  readonly password: string;
  readonly again: string;
  readonly autoFocus?: boolean;
  readonly onPassword: (value: string) => void;
  readonly onAgain: (value: string) => void;
}) {
  const mismatch = again !== "" && again !== password;
  const same = again !== "" && again === password;
  return (
    <>
      <Field label={first} type="password" autoComplete="new-password" autoFocus={autoFocus} help={passwordRule}
        value={password} onChange={(e) => onPassword(e.target.value)} />
      <Field label={second} type="password" autoComplete="new-password" tone={mismatch ? "bad" : same ? "good" : undefined}
        help={mismatch ? NOT_SAME : same ? "Matches" : null}
        value={again} onChange={(e) => onAgain(e.target.value)} />
    </>
  );
}

/** A refusal, said next to the button that met it. */
function Refusal({ error }: { readonly error: string | null }) {
  return error === null ? null : <div className="error" role="alert">{error}</div>;
}

/**
 * The only screen someone without a session sees, and the page a link opens. Email and
 * password, or Google. On a fresh copy it also offers "Create the owner account". A link
 * (`/reset`, `/invite`) opens its own form for a new password, signed in or not, after
 * asking the Worker whose it is and whether it still works.
 */
export function SignIn({ googleReady, claimable, signedIn, link, notice, onLeave, onSignedIn }: {
  readonly googleReady: boolean;
  /** No owner account exists yet, so this copy can be claimed. */
  readonly claimable: boolean;
  /** This device is signed in already, and a link opened over it. */
  readonly signedIn: boolean;
  /** What the address opened with: a token, Google's refusal, or nothing. */
  readonly link: AuthLink | null;
  /** Why this device is signed out, when the person did not just do it themselves with a connection. */
  readonly notice: string | null;
  /** Leaves a link's page: for the sign-in card, or signed in, for VEMI. */
  readonly onLeave: () => void;
  /** Settles who is now signed in. A failure shows here, as a refusal would. */
  readonly onSignedIn: () => Promise<void>;
}) {
  const token = link !== null && link.kind !== "google" ? link : null;
  const [stage, setStage] = useState<"sign-in" | "claim" | "recover">("sign-in");
  const backToSignIn = (): void => { setStage("sign-in"); setPassword(""); setAgain(""); setError(null); };
  // The password was right and the Worker wants the next step: a code from the app, or a backup code.
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  // The recovery code a sign-up or a recovery made, shown once before going on.
  const [shown, setShown] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => googleRefusal(link));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  // The tab says where it is here too, not whatever the shell or a docs page last said.
  useEffect(() => {
    document.title = SIGN_IN_TITLE;
  }, []);
  const [holder, setHolder] = useState<Holder>(null);

  const tokenKind = token?.kind;
  const tokenValue = token?.token;
  useEffect(() => {
    if (tokenKind === undefined || tokenValue === undefined) return;
    let mounted = true;
    setHolder(null);
    linkHolder(tokenKind, tokenValue).then(
      (found) => { if (mounted) setHolder(found); },
      (err: unknown) => {
        // Only the Worker's word that it is dead takes the form away; anything else leaves it to try.
        if (mounted && err instanceof AuthError && err.code === "link") setHolder({ dead: err.message });
      },
    );
    return () => {
      mounted = false;
    };
  }, [tokenKind, tokenValue]);

  const attempt = async (work: () => Promise<void>, refused: (err: unknown) => string | null = messageOf): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(refused(err));
    } finally {
      setBusy(false);
    }
  };

  const leave = (): void => {
    setError(null);
    setPassword("");
    setAgain("");
    onLeave();
  };

  /** Keeps the new recovery code on screen, or goes on at once when the Worker sent none. */
  const afterSignUp = async (fresh: string): Promise<void> => {
    if (fresh === "") await onSignedIn();
    else setShown(fresh);
  };

  if (shown !== null) {
    return (
      <Gate side="shown" title="Recovery code" lede="Shown once. It gets you back in if you lose your password.">
        <code className="mono gate-code">{shown}</code>
        <Refusal error={error} />
        <button type="button" className="primary-button" disabled={busy} onClick={() => void attempt(onSignedIn)}>Continue</button>
      </Gate>
    );
  }

  if (token !== null) {
    const words = FIELDS[token.kind];
    const back = (
      <button type="button" className="quiet-button" disabled={busy} onClick={leave}>
        {signedIn ? "Back to VEMI" : "Back to sign in"}
      </button>
    );

    if (holder !== null && "dead" in holder) {
      return (
        <Gate side="signIn" title={token.kind === "reset" ? "Reset password" : "Invitation"}>
          <Refusal error={holder.dead} />
          {back}
        </Gate>
      );
    }

    // An invitation by first name has no address yet: the invitee types theirs.
    const named = holder !== null && "firstName" in holder;
    const submit = (): void => {
      if (password !== again) {
        setError(NOT_SAME);
        return;
      }
      void attempt(async () => {
        if (token.kind === "reset") {
          await reset(token.token, password);
          await onSignedIn();
        } else {
          await afterSignUp(await acceptInvite(token.token, password, named ? email.trim() : undefined));
        }
      }, (err) => {
        // Spent or expired since the page asked: the same page a dead link opens with.
        if (err instanceof AuthError && err.code === "link") {
          setHolder({ dead: err.message });
          return null;
        }
        return messageOf(err);
      });
    };
    return (
      <Gate side={token.kind} title={words.title}
        lede={holder !== null && "firstName" in holder ? inviteGreeting(holder.firstName, googleReady) : undefined}>
        <form onSubmit={(e) => { e.preventDefault(); if (!busy) submit(); }}>
          {holder !== null && "firstName" in holder && (
            <Field label="Email" type="email" name="username" autoComplete="username" autoFocus
              value={email} onChange={(e) => setEmail(e.target.value)} />
          )}
          {holder !== null && "email" in holder && (
            // Whose account this is, and the username a password manager files the new password under.
            <Field label="Email" type="email" name="username" autoComplete="username" readOnly value={holder.email} />
          )}
          <PasswordPair first="New password" second="New password again" password={password} again={again}
            autoFocus={!named} onPassword={setPassword} onAgain={setAgain} />
          <button type="submit" className="primary-button"
            disabled={busy || password === "" || again === "" || (named && email.trim() === "")}>{words.submit}</button>
        </form>
        <Refusal error={error} />
        {token.kind === "invite" && googleReady && (
          <>
            <div className="gate-or"><span>or</span></div>
            <button type="button" className="quiet-button gate-outline" disabled={busy}
              onClick={() => void attempt(() => googleStart("invite", token.token))}>
              Continue with Google
            </button>
          </>
        )}
        {back}
      </Gate>
    );
  }

  if (stage === "claim") {
    if (!claimable) return <Gate side="inviteOnly" title="Sign up"><InviteOnly onSignIn={backToSignIn} /></Gate>;
    return (
      <Gate side="claim" title="Create your account" lede="A recovery code comes next.">
        <ClaimForm email={email} password={password} again={again} busy={busy} error={error}
          onEmail={setEmail} onPassword={setPassword} onAgain={setAgain} onBack={backToSignIn}
          onSubmit={() => {
            if (busy) return;
            if (password !== again) {
              setError(NOT_SAME);
              return;
            }
            void attempt(async () => { await afterSignUp(await claim(email.trim(), password)); });
          }} />
      </Gate>
    );
  }

  if (stage === "recover") {
    return (
      <Gate side="recover" title="Use a recovery code" lede="Set a new password with the code you were shown.">
        <form onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          if (password !== again) {
            setError(NOT_SAME);
            return;
          }
          void attempt(async () => { await afterSignUp(await recover(email.trim(), recoveryCode.trim(), password)); });
        }}>
          <Field label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field label="Recovery code" autoComplete="off" autoFocus value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)}
            tip={{ label: "Where is my recovery code", note: "It was shown once, when the account was made." }} />
          <PasswordPair first="New password" second="New password again" password={password} again={again}
            onPassword={setPassword} onAgain={setAgain} />
          <button type="submit" className="primary-button"
            disabled={busy || email.trim() === "" || recoveryCode.trim() === "" || password === "" || again === ""}>Set password</button>
        </form>
        <Refusal error={error} />
        <button type="button" className="quiet-button" disabled={busy}
          onClick={() => { setStage("sign-in"); setPassword(""); setAgain(""); setRecoveryCode(""); setError(null); }}>
          Back to sign in
        </button>
      </Gate>
    );
  }

  if (needCode) {
    return (
      <Gate side="code" title="Enter your code" lede="From your authenticator app, or a backup code.">
        <form onSubmit={(e) => {
          e.preventDefault();
          if (busy || code.trim() === "") return;
          void attempt(async () => { await signIn(email.trim(), password, code.trim()); await onSignedIn(); },
            (err) => signInRefused(err, { googleReady }));
        }}>
          <Field label="6-digit code or backup code" aria="Code" className="gate-code-input" inputMode="numeric" autoComplete="one-time-code"
            autoFocus value={code} onChange={(e) => setCode(e.target.value)} />
          <button type="submit" className="primary-button" disabled={busy || code.trim() === ""}>Sign in</button>
        </form>
        <Refusal error={error} />
        <button type="button" className="quiet-button" disabled={busy}
          onClick={() => { setNeedCode(false); setCode(""); setPassword(""); setError(null); setStage("recover"); }}>
          Use a recovery code
        </button>
        <button type="button" className="quiet-button" disabled={busy}
          onClick={() => { setNeedCode(false); setCode(""); setPassword(""); setError(null); }}>
          Back to sign in
        </button>
      </Gate>
    );
  }

  return (
    <Gate side="signIn" title="Welcome back" lede="Sign in to your VEMI.">
      {notice !== null && <p className="gate-notice">{notice}</p>}
      <form onSubmit={(e) => {
        e.preventDefault();
        if (!busy) {
          void attempt(async () => { await signIn(email.trim(), password); await onSignedIn(); },
            (err) => {
              // The password was right and the code is the next step: the field asking is the answer.
              if (asksForCode(err)) {
                setNeedCode(true);
                return null;
              }
              return signInRefused(err, { googleReady });
            });
        }
      }}>
        <Field label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
          tip={{ label: "If you are locked out", note: "Lost your password? Use a recovery code instead." }} />
        <button type="submit" className="primary-button" disabled={busy || email.trim() === "" || password === ""}>Sign in</button>
      </form>
      {/* Next to the button that met it, not under Google and the help link. */}
      <Refusal error={error} />
      {googleReady && (
        <>
          <div className="gate-or"><span>or</span></div>
          <button type="button" className="quiet-button gate-outline" disabled={busy} onClick={() => void attempt(() => googleStart("sign-in"))}>
            Continue with Google
          </button>
        </>
      )}
      <div className="gate-alt">
        <button type="button" className="quiet-button" disabled={busy} onClick={() => { setStage("recover"); setPassword(""); setError(null); }}>
          Use a recovery code
        </button>
        {/* While no owner account exists it makes one; after that it says the copy is invite only. */}
        <button type="button" className={claimable ? "quiet-button gate-outline" : "quiet-button"} disabled={busy}
          onClick={() => { setStage("claim"); setError(null); }}>
          {claimable ? "Create the owner account" : "Sign up"}
        </button>
      </div>
    </Gate>
  );
}

/** What sign-up says once the copy has an owner: a label and the way back, nothing else. */
export function InviteOnly({ onSignIn }: { readonly onSignIn: () => void }) {
  return (
    <>
      <p className="gate-notice">This copy is invite only</p>
      <button type="button" className="quiet-button" onClick={onSignIn}>Sign in</button>
    </>
  );
}

/** The first sign-up on a copy with no accounts: an email and a password, twice. */
export function ClaimForm({ email, password, again, busy, error, onEmail, onPassword, onAgain, onBack, onSubmit }: {
  readonly email: string;
  readonly password: string;
  readonly again: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onEmail: (value: string) => void;
  readonly onPassword: (value: string) => void;
  readonly onAgain: (value: string) => void;
  readonly onBack: () => void;
  readonly onSubmit: () => void;
}) {
  return (
    <>
      <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
        <Field label="Email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => onEmail(e.target.value)} />
        <PasswordPair first="Password" second="Password again" password={password} again={again}
          onPassword={onPassword} onAgain={onAgain} />
        <button type="submit" className="primary-button" disabled={busy || email.trim() === "" || password === "" || again === ""}>
          Create the owner account
        </button>
      </form>
      <Refusal error={error} />
      <button type="button" className="quiet-button" disabled={busy} onClick={onBack}>Back to sign in</button>
    </>
  );
}
