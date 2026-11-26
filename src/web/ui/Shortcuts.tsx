import { keyNames, onMac } from "../keys.js";
import { singleKeysOn } from "../extras.js";
import { useLevelWords } from "../levelNames.js";
import { shortcutRows } from "../shortcutRows.js";
import { Sheet } from "./Sheet.js";
import "./shortcuts.css";

/**
 * The shortcuts sheet, opened by `?`: every key the interface answers to, as a list of
 * the key beside what it does. The words for the levels come from `levelWords`, never typed
 * here. The same keys are always reachable by the rail, the palette or a button.
 */
export function Shortcuts({ onClose }: { readonly onClose: () => void }) {
  const words = useLevelWords();
  const mod = keyNames(onMac()).mod.trim();
  const rows = shortcutRows(mod, words, singleKeysOn());
  return (
    <Sheet onClose={onClose} placement="centre" label="Shortcuts" className="shortcuts">
      <div className="sheet-head">
        <span className="kicker">Shortcuts</span>
        <span className="fill" />
        <button type="button" className="close-button" aria-label="close" onClick={onClose}>×</button>
      </div>
      <div className="sheet-body">
        <dl className="shortcuts-list">
          {rows.map(([keys, what]) => (
            <div key={`${keys}:${what}`} className="shortcuts-row">
              <dt><kbd className="shortcuts-keys">{keys}</kbd></dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Sheet>
  );
}
