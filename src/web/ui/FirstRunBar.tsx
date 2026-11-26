import { stepLabel, type FirstRunStep } from "../firstRunSteps.js";
import "./firstRun.css";

/**
 * The slim bar along the top of the page while first run is on: "Step N of M", the step's title
 * and Skip. The title is a button only when the person has wandered off the step's screen, and
 * pressing it takes them back.
 */
export function FirstRunBar({ step, homeScreen, phone, title, onSkip, onOpen, action }: {
  readonly step: FirstRunStep;
  readonly homeScreen: boolean;
  readonly phone: boolean;
  readonly title: string;
  readonly onSkip: () => void;
  readonly onOpen?: (() => void) | undefined;
  /** The step's one button, where it has one: "Put it on today". */
  readonly action?: { readonly label: string; readonly onClick: () => void } | undefined;
}) {
  return (
    <div className={`first-run-bar${phone ? " phone" : ""}`} role="region" aria-label="First steps">
      <span className="first-run-count">{stepLabel(step, homeScreen)}</span>
      {onOpen === undefined
        ? <span className="first-run-name">{title}</span>
        : <button type="button" className="first-run-title" onClick={onOpen}>{title}</button>}
      <span className="fill" />
      {action !== undefined && <button type="button" className="first-run-action" onClick={action.onClick}>{action.label}</button>}
      <button type="button" className="first-run-skip" onClick={onSkip}>Skip</button>
    </div>
  );
}
