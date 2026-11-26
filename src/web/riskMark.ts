/**
 * Which mark a venture or project wears: Blocked first, then At risk, else none. Both are
 * only drawn; nothing is computed from them and neither enters a count.
 */
export type RiskMark = "blocked" | "at-risk";

export const riskMark = (blocked: boolean, atRisk: boolean): RiskMark | null =>
  blocked ? "blocked" : atRisk ? "at-risk" : null;
