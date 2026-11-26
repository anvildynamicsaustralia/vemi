import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LockedBlock } from "./LockedBlock.js";

const DASH = String.fromCharCode(0x2014);

describe("LockedBlock", () => {
  it("shows a lock, Locked and Open", () => {
    const out = renderToStaticMarkup(<LockedBlock onOpen={() => undefined} />);
    expect(out).toContain("<svg");
    expect(out).toContain("Locked");
    expect(out).toContain(">Open</button>");
    expect(out).not.toContain(DASH);
  });

  it("puts the way in where Open was", () => {
    const out = renderToStaticMarkup(<LockedBlock onOpen={() => undefined}><span>the way in</span></LockedBlock>);
    expect(out).toContain("the way in");
    expect(out).not.toContain(">Open</button>");
  });

  it("offers no Open on a field that cannot be read", () => {
    const out = renderToStaticMarkup(<LockedBlock damaged onOpen={() => undefined} />);
    expect(out).toContain("Can&#x27;t be read");
    expect(out).not.toContain(">Open</button>");
  });
});
