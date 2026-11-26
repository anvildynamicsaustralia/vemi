/**
 * The last of a burst of events, handled once a frame.
 *
 * A pointer reports moves faster than a screen draws them. A drag that asks the page what is
 * under the pointer, or draws a surface again, does that work once for the frame that will
 * show it, with the newest event. Letting go flushes: the move still waiting for its frame
 * is the one that says where the drop lands.
 */
export interface FrameGate<T> {
  /** Hold this as the newest, and ask for a frame if none is coming. */
  push(value: T): void;
  /** Handle what is waiting now, rather than at the frame. */
  flush(): void;
  /** Forget what is waiting, and the frame with it. */
  drop(): void;
}

export function oncePerFrame<T>(
  run: (value: T) => void,
  schedule: (fire: () => void) => number = (fire) => window.requestAnimationFrame(fire),
  cancel: (frame: number) => void = (frame) => window.cancelAnimationFrame(frame),
): FrameGate<T> {
  let frame: number | null = null;
  let pending: { readonly value: T } | null = null;
  const fire = (): void => {
    frame = null;
    const waiting = pending;
    pending = null;
    if (waiting !== null) run(waiting.value);
  };
  return {
    push(value) {
      pending = { value };
      frame ??= schedule(fire);
    },
    flush() {
      if (frame === null) return;
      cancel(frame);
      fire();
    },
    drop() {
      if (frame !== null) cancel(frame);
      frame = null;
      pending = null;
    },
  };
}
