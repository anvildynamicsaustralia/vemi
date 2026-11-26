/**
 * The one progress figure: a ring is how much is left. It replaces every table of counts
 * and every row of progress squares, so it is drawn at three sizes and nowhere computes its
 * own geometry. The arc is ink on a hairline track, as the mock draws it: a colour only ever
 * means a state, and how much is left is not one.
 *
 * The Progress rings switch in Extras hides every ring at once: a ring draws nothing when off.
 */
import { useExtras } from "../extras.js";

/** The handoff's rings: box, radius, stroke, and the circumference its dash is measured in. */
const RINGS = {
  plate: { box: 52, r: 20, stroke: 6, circ: 126, text: 30 },
  owned: { box: 40, r: 15, stroke: 5, circ: 94, text: 24 },
  card: { box: 30, r: 11.5, stroke: 4, circ: 72, text: 18.5 },
} as const;

export type RingSize = keyof typeof RINGS;

/** `share` is the part of the ring drawn, 0 to 1; `value` is the number in the middle. */
export function Ring({ size, value, share, label }: {
  readonly size: RingSize;
  readonly value: number;
  readonly share: number;
  readonly label: string;
}) {
  const shown = useExtras().rings;
  if (!shown) return null;
  const g = RINGS[size];
  const c = g.box / 2;
  const drawn = Math.max(0, Math.min(1, share)) * g.circ;
  return (
    <svg className={`ring ring-${size}`} width={g.box} height={g.box} viewBox={`0 0 ${g.box} ${g.box}`} role="img" aria-label={label}>
      <circle className="ring-track" cx={c} cy={c} r={g.r} strokeWidth={g.stroke} />
      <circle className="ring-arc" cx={c} cy={c} r={g.r} strokeWidth={g.stroke}
        strokeDasharray={`${drawn} ${g.circ}`} transform={`rotate(-90 ${c} ${c})`} />
      <text className="ring-value" x={c} y={g.text} textAnchor="middle">{value}</text>
    </svg>
  );
}
