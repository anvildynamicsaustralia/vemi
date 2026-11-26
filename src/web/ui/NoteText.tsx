import { noteMarkup } from "../noteMarkup.js";

/**
 * A note's words (VEMI-013, project page): bold and code drawn as elements, everything else as
 * React text. Nothing here sets HTML, so a tag typed into a note shows as the characters typed.
 */
export function NoteText({ text }: { readonly text: string }) {
  return (
    <>
      {noteMarkup(text).map((span, i) => {
        if (span.kind === "bold") return <strong key={i}>{span.text}</strong>;
        if (span.kind === "code") return <code key={i}>{span.text}</code>;
        return <span key={i}>{span.text}</span>;
      })}
    </>
  );
}
