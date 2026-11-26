import { LINK_ROLES, type Link, type LinkRole } from "@vemi/shared";
import { createOnce, paths } from "../api.js";
import { useResource } from "../state/resources.js";
import { useApp } from "./appContext.js";
import { AddLine, EditableText } from "./controls.js";
import { Pick } from "./Picker.js";

type Owner = { readonly ventureId: string } | { readonly projectId: string };

const ROLE_WORDS: Readonly<Record<LinkRole, string>> = { repo: "Repo", docs: "Docs", site: "Site", other: "Other" };

/**
 * What a venture or a project points at: its repo, its docs, its site. Recorded, never
 * worked. A venture's page shows the links on the venture itself, so a project's or a
 * task's stay where they belong.
 */
export function Register(owner: Owner) {
  const app = useApp();
  const filter: Record<string, string> = "ventureId" in owner ? { venture: owner.ventureId } : { project: owner.projectId };
  const list = useResource<Link[]>(paths.list("links", filter));
  const items = (list.data ?? []).filter((l) => !("ventureId" in owner) || l.ventureId !== null);

  return (
    <section id="register" className="about-block">
      <div className="kicker more-kicker">Points at</div>
      {items.length === 0 && <div className="more-empty">Nothing registered.</div>}
      {items.map((l) => (
        <div key={l.id}>
          <div className="more-line">
            <Pick label="role" value={l.role} className="pick-inline" width={220}
              options={LINK_ROLES.map((r) => ({ id: r, name: ROLE_WORDS[r] }))}
              onPick={(role) => void app.edit("links", l.id, { role }, l, `changed the role of ${l.label ?? l.url}`)} />
            <a className="fill" href={l.url} target="_blank" rel="noreferrer noopener">{l.label ?? l.url}</a>
            <button type="button" className="close-button" aria-label="archive link"
              onClick={() => void app.archive("links", l.id, "link")}>×</button>
          </div>
          <div className="more-line">
            <EditableText allowEmpty value={l.label} placeholder="a name for it"
              onSave={(label, was) => app.edit("links", l.id, { label }, { label: was }, `renamed ${l.label ?? l.url}`)} />
            <EditableText value={l.url} placeholder="https://"
              onSave={(url, was) => app.edit("links", l.id, { url }, { url: was }, `changed the address of ${l.label ?? l.url}`)} />
          </div>
        </div>
      ))}
      <AddLine placeholder="a link" label="Add link"
        onAdd={(url) => app.act(createOnce("links", { ...owner, url, role: "other" }))} />
    </section>
  );
}
