import type { ButtonHTMLAttributes } from "react";

/**
 * The one chip: a pill that is chosen or not. Chosen is the accent on its tint, and the
 * colour says only that (a colour only ever means a state). Every screen that offers a
 * choice, a filter or a shortcut draws this and nothing else, so the pill is the same
 * pill in Add, Archive, the board and Account.
 *
 * `on` is the look. Whether a screen reader hears it as pressed or checked is the screen's
 * to say, through `aria-pressed` or `role="radio"` and `aria-checked`, as the choice is.
 */
export function Chip({ on = false, className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly on?: boolean;
}) {
  return <button {...rest} type={type} className={["chip", on ? "on" : "", className ?? ""].filter((c) => c !== "").join(" ")} />;
}
