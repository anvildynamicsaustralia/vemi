/** The time left until `expiresAtMs`, as `m:ss`. A part second counts as the whole one, and nothing goes below `0:00`. */
export function countdown(expiresAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
