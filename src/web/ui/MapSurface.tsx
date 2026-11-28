import { useMemo, useState } from "react";
import { MAP_STYLES, type MapStyle, type Overview, type Today, type Tree } from "@vemi/shared";
import { useAppearance } from "../appearance.js";
import { createOnce, paths } from "../api.js";
import { useExtras } from "../extras.js";
import { useLevelWords } from "../levelNames.js";
import type { Outcome } from "../outcome.js";
import { plates } from "../plates.js";
import { useResource } from "../state/resources.js";
import { nextPosition } from "../treeIndex.js";
import { useApp } from "./appContext.js";
import { Pending } from "./controls.js";
import { Chip } from "./Chip.js";
import { MapHeader } from "./MapHeader.js";
import { MoreMenu } from "./Menu.js";
import { NewSpaceSheet, Plates } from "./Plates.js";
import { Recent } from "./Recent.js";
import { Canvas } from "./Canvas.js";
import { Tip } from "./Tip.js";

const STYLE_WORDS: Record<MapStyle, string> = { grid: "Grid", canvas: "Canvas" };

/**
 * Home. The greeting and what today holds, then every space as a plate: three across on a
 * desk, one on a phone. The section header carries the Grid or Canvas choice, which is the
 * account's own (`mapStyle`) and so is the same on every device.
 *
 * On a desk, what was touched last sits under the plates. A phone leaves it out: its bar
 * already gives search.
 */
export function MapSurface() {
  const app = useApp();
  const { appearance, change } = useAppearance();
  const words = useLevelWords();
  const extras = useExtras();
  const overview = useResource<Overview>(paths.overview);
  const tree = useResource<Tree>(paths.tree);
  const today = useResource<Today>(paths.today);
  const [adding, setAdding] = useState(false);

  const o = overview.data;
  const t = tree.data;
  const cards = useMemo(() => (o === null || t === null ? [] : plates(o, t, today.data)), [o, t, today.data]);

  if (o === null) return <Pending error={overview.error} onRetry={overview.refetch} />;
  const canvas = appearance.mapStyle === "canvas";

  const addSpace = async (name: string): Promise<Outcome> => {
    const ok = await app.act(createOnce("ventures", {
      name, position: nextPosition(o.ventures.map((v) => ({ position: v.position }))),
    }));
    if (ok) setAdding(false);
    return ok;
  };

  const empty = o.ventures.length === 0;

  return (
    <div className="map-surface">
      {today.data !== null && <MapHeader today={today.data} />}
      <Tip name="map" />
      <section className="map-section" aria-label={words.spaces}>
        <div className="map-section-head">
          <h2 className="map-section-title">{words.spaces}</h2>
          <div className="chips seg" role="radiogroup" aria-label="map style">
            {MAP_STYLES.map((s) => (
              <Chip key={s} role="radio" aria-checked={appearance.mapStyle === s} on={appearance.mapStyle === s}
                onClick={() => change({ mapStyle: s })}>{STYLE_WORDS[s]}</Chip>
            ))}
          </div>
          <MoreMenu label="the map" className="map-more" items={[
            { label: `New ${words.space.toLowerCase()}`, run: () => setAdding(true) },
            ...app.phoneMenu,
          ]} />
        </div>
        {t === null
          ? <Pending error={tree.error} onRetry={tree.refetch} />
          : canvas && !empty
            ? <Canvas plates={cards} words={words} />
            : <Plates plates={cards} words={words} onNew={() => setAdding(true)} />}
      </section>
      {/* Below the plates, never beside them. */}
      {!empty && !app.phone && t !== null && extras.recent && <Recent tree={t} />}
      {adding && <NewSpaceSheet words={words} onAdd={addSpace} onClose={() => setAdding(false)} />}
    </div>
  );
}
