import { describe, expect, it } from "vitest";
import { oncePerFrame } from "./oncePerFrame.js";

/** A screen that draws only when told to. */
function screen() {
  const frames = new Map<number, () => void>();
  let next = 1;
  return {
    schedule: (fire: () => void) => {
      frames.set(next, fire);
      return next++;
    },
    cancel: (frame: number) => {
      frames.delete(frame);
    },
    draw: () => {
      const due = [...frames.values()];
      frames.clear();
      for (const fire of due) fire();
    },
    waiting: () => frames.size,
  };
}

describe("oncePerFrame", () => {
  it("handles the newest of a burst once, at the frame", () => {
    const s = screen();
    const seen: number[] = [];
    const gate = oncePerFrame((n: number) => seen.push(n), s.schedule, s.cancel);
    gate.push(1);
    gate.push(2);
    gate.push(3);
    expect(s.waiting()).toBe(1);
    expect(seen).toEqual([]);
    s.draw();
    expect(seen).toEqual([3]);
    gate.push(4);
    s.draw();
    expect(seen).toEqual([3, 4]);
  });

  it("hands over what is waiting when flushed, and nothing when nothing is", () => {
    const s = screen();
    const seen: number[] = [];
    const gate = oncePerFrame((n: number) => seen.push(n), s.schedule, s.cancel);
    gate.flush();
    expect(seen).toEqual([]);
    gate.push(7);
    gate.flush();
    expect(seen).toEqual([7]);
    expect(s.waiting()).toBe(0);
    s.draw();
    expect(seen).toEqual([7]);
  });

  it("forgets what is waiting when dropped", () => {
    const s = screen();
    const seen: number[] = [];
    const gate = oncePerFrame((n: number) => seen.push(n), s.schedule, s.cancel);
    gate.push(1);
    gate.drop();
    expect(s.waiting()).toBe(0);
    s.draw();
    gate.flush();
    expect(seen).toEqual([]);
  });
});
