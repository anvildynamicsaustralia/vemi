import { useMemo, useState } from "react";
import type { SmartToken } from "@vemi/shared";
import { readSmartDates } from "../extras.js";

/** What the words in a title mean for the task they make. */
export interface SmartPicked {
  readonly dueOn: string | null;
  readonly repeat: string | null;
  readonly remindAt: string | null;
}

export interface Smart {
  /** The title with the date, repeat and time words taken out. */
  readonly title: string;
  readonly picked: SmartPicked;
  readonly chips: readonly SmartToken[];
}

type Reader = Pick<Storage, "getItem">;

/** The device's own zone, as every other date on the page is read. */
function deviceZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === "string" && zone !== "" ? zone : "UTC";
}

/**
 * Read a typed title. `held` is the front of the text whose words were put back by tapping a
 * chip: they stay words, and only what is typed after them is read.
 */
export function smartOf(text: string, held: string, now: Date, zone: string, store?: Reader | null): Smart {
  const kept = held !== "" && text.startsWith(held) ? held : "";
  const tail = text.slice(kept.length);
  // A stand-in title so a date typed after kept words is not mistaken for the whole text.
  const got = kept === "" ? readSmartDates(text, now, zone, store) : readSmartDates(`x ${tail.trim()}`, now, zone, store);
  const rest = kept === "" ? got.title : got.title.replace(/^x\s*/, "");
  const title = kept === "" ? rest : [kept, rest].filter((p) => p !== "").join(" ");
  const unread = got.tokens.length === 0;
  return {
    title: unread ? text : title,
    picked: { dueOn: got.when, repeat: got.repeat, remindAt: got.remindAt },
    chips: got.tokens,
  };
}

/** The front of the text once a chip's words are put back after the title. */
export function restoreWords(title: string, chip: SmartToken): string {
  return [title, chip.words].filter((p) => p !== "").join(" ");
}

/**
 * The Add text and what it means. Holds the raw text, reads it on every change and gives
 * back the title, what to save with it, a chip per recognised phrase, and `restore`, which
 * puts a chip's words back into the text as plain words.
 */
export function useSmartTitle(initial = "", onText?: (text: string) => void) {
  const [text, setTextNow] = useState(initial);
  const [held, setHeld] = useState("");
  const smart = useMemo(() => smartOf(text, held, new Date(), deviceZone()), [text, held]);

  const setText = (next: string): void => {
    setTextNow(next);
    onText?.(next);
  };
  const restore = (chip: SmartToken): void => {
    const front = restoreWords(smart.title, chip);
    const others = smart.chips.filter((c) => c !== chip).map((c) => c.words);
    const next = [front, ...others].join(" ");
    setHeld(front);
    setText(next);
  };

  return { text, setText, title: smart.title, picked: smart.picked, chips: smart.chips, restore };
}
