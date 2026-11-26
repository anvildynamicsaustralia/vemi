import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewLoadError, loadView } from "../lazyView.js";
import { ViewBoundary } from "./ViewBoundary.js";

function boundary(children: unknown = null): ViewBoundary {
  const b = new ViewBoundary({ fallback: null, children: children as never });
  b.setState = vi.fn();
  return b;
}

function fakeSession(): Storage {
  const kept = new Map<string, string>();
  return {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  } as unknown as Storage;
}

afterEach(() => vi.unstubAllGlobals());

describe("ViewBoundary", () => {
  it("draws its children", () => {
    expect(renderToStaticMarkup(<ViewBoundary fallback={null}><p>screen</p></ViewBoundary>)).toBe("<p>screen</p>");
  });

  it("turns a thrown import into its fallback state", () => {
    expect(ViewBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });

  it("reloads once for a view whose import failed twice, and for no other error", async () => {
    const reload = vi.fn();
    vi.stubGlobal("sessionStorage", fakeSession());
    vi.stubGlobal("window", { location: { reload } });
    const rejecting = loadView(() => Promise.reject(new Error("gone")));
    const error = await rejecting.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViewLoadError);

    boundary().componentDidCatch(new Error("a render bug"));
    expect(reload).not.toHaveBeenCalled();
    boundary().componentDidCatch(error);
    boundary().componentDidCatch(error);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("tries the import a second time before it gives up", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("flaky")).mockResolvedValueOnce({ ok: 1 });
    await expect(loadView(load)).resolves.toEqual({ ok: 1 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("lets the next view try again once its children change after a failure", () => {
    const b = boundary("second");
    b.state = { failed: true };
    b.componentDidUpdate({ fallback: null, children: "first" as never });
    expect(b.setState).toHaveBeenCalledWith({ failed: false });

    const same = boundary("first");
    same.state = { failed: true };
    same.componentDidUpdate({ fallback: null, children: "first" as never });
    expect(same.setState).not.toHaveBeenCalled();
  });
});
