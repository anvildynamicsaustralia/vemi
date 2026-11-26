/**
 * The four Brief steps of a project (VEMI-013, project page, decision 1). "What is it" is the
 * project's `description`; the other three are their own fields. A blank step is an empty one.
 */
export interface BriefFields {
  readonly description: string | null;
  readonly whoFor: string | null;
  readonly doneLooks: string | null;
  readonly openQuestions: string | null;
}

export interface BriefStep {
  readonly key: keyof BriefFields;
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
}

export interface BriefState {
  readonly steps: readonly BriefStep[];
  readonly filled: number;
  /** Index of the first empty step, or -1 when every step is filled. */
  readonly firstEmpty: number;
}

const STEPS: readonly { key: keyof BriefFields; label: string; placeholder: string }[] = [
  { key: "description", label: "What is it", placeholder: "One line anyone would get" },
  { key: "whoFor", label: "Who it's for", placeholder: "Who uses it and why" },
  { key: "doneLooks", label: "What done looks like", placeholder: "How you'll know it's finished" },
  { key: "openQuestions", label: "Open questions", placeholder: "What's still undecided" },
];

export function projectBrief(fields: BriefFields): BriefState {
  const steps = STEPS.map((s) => ({ ...s, value: fields[s.key] ?? "" }));
  const empty = (s: BriefStep): boolean => s.value.trim() === "";
  return {
    steps,
    filled: steps.filter((s) => !empty(s)).length,
    firstEmpty: steps.findIndex(empty),
  };
}
