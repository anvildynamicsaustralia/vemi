import type { Project } from "@vemi/shared";
import { projectBrief } from "../projectBrief.js";
import { useApp } from "./appContext.js";
import { EditableText } from "./controls.js";
import { LockableText } from "./LockableText.js";
import "./projectBrief.css";

/**
 * The Brief (VEMI-013, project phase): four steps, each edited in place and saved as its own
 * field of the project. The first empty one is lit, and the count says how many are written.
 */
export function ProjectBrief({ project }: { readonly project: Project }) {
  const app = useApp();
  const brief = projectBrief(project);
  return (
    <section className="brief-block" aria-label="Brief">
      <h3 className="brief-head">Brief <em>{brief.filled} of 4</em></h3>
      <div className="brief-card">
        {brief.steps.map((step, i) => (
          <div key={step.key} className={`bstep${step.value.trim() !== "" ? " filled" : ""}${i === brief.firstEmpty ? " cue" : ""}`}>
            <span className="bstep-n" aria-hidden="true">
              {step.value.trim() !== "" ? (
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m5.5 12.5 4 4 9-9" /></svg>
              ) : i + 1}
            </span>
            <div className="bstep-body">
              <div className="bstep-k">{step.label}</div>
              <LockableText kind="projects" id={project.id} field={step.key} value={step.value === "" ? null : step.value}
                save={(stored, was) => app.edit("projects", project.id, { [step.key]: stored }, { [step.key]: was }, `edited ${step.label} of ${project.name}`)}>
                {(editor) => (
                  <EditableText value={editor.value} placeholder={step.placeholder} multiline allowEmpty className="bstep-v" onSave={editor.onSave} />
                )}
              </LockableText>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
