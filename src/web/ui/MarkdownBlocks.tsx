import { Fragment } from "react";
import type { Block, Inline } from "../renderMarkdown.js";

/**
 * The blocks of a rendered body, drawn. The one place a heading, a list and a link become
 * elements, so a task body and a docs page cannot drift apart.
 *
 * A link beginning with `/` is an in-app link, which `renderMarkdown` only produces when it
 * was asked to. It is a real `<a href>`, so a middle-click or a modified click still opens
 * a tab; a plain click is kept from reloading the page and handed to `onLocal`. With no
 * `onLocal` it is left a plain link. Every other link opens in a new tab.
 */
function Spans({ spans, onLocal }: {
  readonly spans: readonly Inline[];
  readonly onLocal: ((href: string) => void) | undefined;
}) {
  return (
    <>
      {spans.map((span, i) => {
        if (span.kind !== "link") return <Fragment key={i}>{span.text}</Fragment>;
        if (onLocal !== undefined && span.href.startsWith("/")) {
          return (
            <a key={i} className="md-link" href={span.href}
              onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                onLocal(span.href);
              }}>{span.text}</a>
          );
        }
        return <a key={i} className="md-link" href={span.href} target="_blank" rel="noreferrer noopener">{span.text}</a>;
      })}
    </>
  );
}

export function MarkdownBlocks({ blocks, onLocal }: {
  readonly blocks: readonly Block[];
  readonly onLocal?: (href: string) => void;
}) {
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === "heading") return <h3 key={i} dir="auto" className="md-heading"><Spans spans={block.spans} onLocal={onLocal} /></h3>;
        if (block.kind === "list") {
          return (
            <ul key={i} className="md-list">
              {block.items.map((item, j) => <li key={j} dir="auto"><Spans spans={item} onLocal={onLocal} /></li>)}
            </ul>
          );
        }
        return <p key={i} dir="auto" className="md-para"><Spans spans={block.spans} onLocal={onLocal} /></p>;
      })}
    </>
  );
}
