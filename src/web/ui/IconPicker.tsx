import { useEffect, useMemo, useState } from "react";
import { Icon, loadCatalogue, type Catalogue } from "@vemi/icons";
import { useApp, type IconTarget } from "./appContext.js";
import { Sheet } from "./Sheet.js";

const SHOWN = 60;

/** What the picker offers before anything is typed. Names neither set has are dropped. */
const LUCIDE_FIRST = [
  "rocket", "globe", "cpu", "sprout", "briefcase", "building-2", "layers", "flag", "target", "terminal",
  "users", "wrench", "shield", "map", "calendar", "house", "settings", "file-text", "tractor", "gamepad-2",
  "server", "code", "heart", "dog", "hammer", "camera", "music", "book-open", "dollar-sign", "truck",
];
const BRANDS_FIRST = [
  "github", "unrealengine", "discord", "youtube", "twitch", "steam", "apple", "google", "cloudflare",
  "notion", "clickup", "figma", "blender", "unity", "godotengine", "fivem", "instagram", "facebook",
];

/** Two sets, two sections, one search. Never one mixed grid. */
export function IconPicker({ target, onClose }: { readonly target: IconTarget; readonly onClose: () => void }) {
  const app = useApp();
  const [query, setQuery] = useState("");
  const [names, setNames] = useState<Catalogue | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let mounted = true;
    loadCatalogue().then(
      (list) => { if (mounted) setNames(list); },
      () => { if (mounted) setFailed(true); },
    );
    return () => {
      mounted = false;
    };
  }, []);

  const needle = query.trim().toLowerCase();
  const lucide = useMemo(() => {
    if (names === null) return null;
    const list = needle === "" ? LUCIDE_FIRST.filter((n) => names.lucide.includes(n)) : names.lucide.filter((n) => n.includes(needle));
    return list.slice(0, SHOWN);
  }, [names, needle]);
  const marks = useMemo(() => {
    if (names === null) return null;
    const list = needle === ""
      ? names.brands.filter((b) => BRANDS_FIRST.includes(b.slug))
      : names.brands.filter((b) => b.slug.includes(needle) || b.title.toLowerCase().includes(needle));
    return list.slice(0, SHOWN);
  }, [names, needle]);

  const choose = async (name: string | null): Promise<void> => {
    if (await app.edit(target.kind, target.id, { icon: name }, { icon: target.current }, `changed the icon of ${target.label}`)) onClose();
  };

  const waiting = <div className="empty icon-empty">{failed ? "No connection, so no icons to choose from yet." : "Loading"}</div>;
  const none = <div className="empty icon-empty">None match.</div>;

  return (
    <Sheet onClose={onClose} className="icon-sheet" placement="centre" label="choose an icon">
      <div className="sheet-head">
        <span className="label icon-for-label">Icon for</span>
        <span className="icon-for">{target.label}</span>
        <input autoFocus value={query} placeholder="search both sets" aria-label="search icons" onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="close-button" aria-label="close" onClick={onClose}>×</button>
      </div>
      <div className="sheet-body">
        <div className="picker-section label">Icons</div>
        {lucide === null ? waiting : lucide.length === 0 ? none : (
          <div className="picker-grid">
            {lucide.map((name) => (
              <button key={name} type="button" title={name} aria-label={name} className={`picker-cell${target.current === `lucide:${name}` ? " on" : ""}`}
                onClick={() => void choose(`lucide:${name}`)}>
                <Icon name={`lucide:${name}`} size={20} />
              </button>
            ))}
          </div>
        )}
        <div className="picker-section label">Brand marks</div>
        {marks === null ? waiting : marks.length === 0 ? none : (
          <div className="picker-grid">
            {marks.map((b) => (
              <button key={b.slug} type="button" title={b.title} aria-label={b.title} className={`picker-cell${target.current === `brand:${b.slug}` ? " on" : ""}`}
                onClick={() => void choose(`brand:${b.slug}`)}>
                <Icon name={`brand:${b.slug}`} size={20} />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="sheet-foot">
        <button type="button" className="quiet-button" disabled={target.current === null} onClick={() => void choose(null)}>no icon</button>
        <span className="fill" />
        <span className="icon-foot">Lucide and Simple Icons. Brand marks name a brand, never this tool.</span>
      </div>
    </Sheet>
  );
}
