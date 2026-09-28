// Colour legends with units. Diverging legends put zero in the middle (matching the colouring).

import type { ReactElement } from "react";
import type { Ranges } from "../store/types";
import { cssGradient, type MapName } from "../viz/colormap";
import type { VizSettings } from "../viz/stage";

interface Tick {
  at: number;
  label: string;
  sub?: string;
}

function Legend({ title, unit, map, ticks }: { title: string; unit: string; map: MapName; ticks: Tick[] }) {
  return (
    <div className="legend">
      <div className="legend-title">
        {title} <span className="muted">{unit}</span>
      </div>
      <div className="legend-bar" style={{ background: cssGradient(map) }} />
      <div className="legend-ticks">
        {ticks.map((t) => (
          <span key={t.at} style={{ left: `${t.at * 100}%` }} className={t.at === 0 ? "first" : t.at === 1 ? "last" : ""}>
            {t.label}
            {t.sub && <small>{t.sub}</small>}
          </span>
        ))}
      </div>
    </div>
  );
}

const n = (v: number, d = 1) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString("en-US") : v.toFixed(d));

function sequential(lo: number, hi: number, digits = 1): Tick[] {
  return [0, 0.5, 1].map((t) => ({ at: t, label: n(lo + (hi - lo) * t, digits) }));
}

export function LegendStack({ viz, ranges, hasSurface, hasField }: { viz: VizSettings; ranges: Ranges | null; hasSurface: boolean; hasField: boolean }) {
  if (!ranges) return null;
  const out: ReactElement[] = [];
  const speedShown = hasField && (viz.smoke || viz.streamlines || (viz.wake && viz.wakeColor === "speed") || (viz.slice && viz.sliceField === "speed"));
  const cpShown = (viz.surface && hasSurface) || (hasField && viz.wake && viz.wakeColor === "cp");
  if (cpShown) {
    const [lo, hi] = ranges.cp;
    out.push(
      <Legend
        key="cp"
        title="Pressure coefficient"
        unit="Cp · Pa"
        map="diverging"
        ticks={[
          { at: 0, label: lo.toFixed(2), sub: `${n(lo * ranges.q, 0)} Pa` },
          { at: 0.5, label: "0", sub: "0 Pa" },
          { at: 1, label: hi.toFixed(2), sub: `${n(hi * ranges.q, 0)} Pa` },
        ]}
      />,
    );
  }
  if (speedShown)
    out.push(
      <Legend
        key="speed"
        title="Air speed"
        unit="m/s"
        map="speed"
        ticks={sequential(ranges.speed[0], ranges.speed[1]).map((t) => ({ ...t, sub: `${Math.round(Number(t.label.replace(/,/g, "")) * 3.6)} km/h` }))}
      />,
    );
  if (hasField && viz.slice && viz.sliceField === "pressure") {
    const [lo, hi] = ranges.pressure;
    out.push(<Legend key="p" title="Static pressure" unit="Pa" map="diverging" ticks={[{ at: 0, label: n(lo, 0) }, { at: 0.5, label: "0" }, { at: 1, label: n(hi, 0) }]} />);
  }
  if (hasField && viz.slice && viz.sliceField === "cp0")
    out.push(<Legend key="cp0" title="Total pressure" unit="Cp0 (1 = no loss)" map="loss" ticks={sequential(ranges.cp0[0], ranges.cp0[1], 2)} />);
  if (hasField && viz.slice && viz.sliceField === "k")
    out.push(<Legend key="k" title="Turbulent kinetic energy" unit="m²/s²" map="turbulence" ticks={sequential(ranges.k[0], ranges.k[1], 2)} />);
  if (!out.length) return null;
  return <div className="legend-stack">{out}</div>;
}
