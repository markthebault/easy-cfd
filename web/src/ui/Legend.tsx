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
  if(hasSurface && viz.friction) { const cf=viz.frictionUnit === "Cf", hi=viz.frictionMax ?? (cf?ranges.cf?.[1]:ranges.friction?.[1]) ?? 1; out.push(<Legend key="friction" title="Surface friction · final snapshot" unit={cf?"Cf":"Pa"} map="speed" ticks={sequential(0,hi,cf?4:2)} />); }
  if (hasField && viz.pressureCloud) out.push(<div className="legend cloud-legend" key="clouds"><div className="legend-title">Pressure clouds <span className="muted">Cp · Pa</span></div>{viz.cloudSign !== "positive" && <div><i className="cloud-dot negative" /><span>Suction</span><b>−{viz.cloudLevel.toFixed(2)}<small>−{n(viz.cloudLevel * ranges.q, 0)} Pa</small></b></div>}{viz.cloudSign !== "negative" && <div><i className="cloud-dot positive" /><span>Positive</span><b>+{viz.cloudLevel.toFixed(2)}<small>+{n(viz.cloudLevel * ranges.q, 0)} Pa</small></b></div>}</div>);
  const speedMaps = new Set<MapName>();
  if (hasField) {
    if (viz.streamlines) speedMaps.add(viz.stream.color ?? "speed");
    if (viz.smoke || (viz.wake && viz.wakeColor === "speed")) speedMaps.add("speed");
    if (viz.slice && viz.sliceField === "speed") speedMaps.add(viz.animation ? "flow" : "speed");
  }
  const cpShown = (viz.surface && hasSurface) || (hasField && viz.wake && viz.wakeColor === "cp");
  if (cpShown) {
    const [lo, hi] = ranges.cp;
    out.push(
      <Legend
        key="cp"
        title={viz.surface ? "Surface pressure · final snapshot" : "Pressure coefficient"}
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
  for (const map of speedMaps)
    out.push(
      <Legend
        key={`speed-${map}`}
        title={speedMaps.size > 1 ? `Air speed · ${map === (viz.stream.color ?? "speed") && viz.streamlines ? "streamlines" : viz.animation && map === "flow" ? "transient flow" : "flow field"}` : viz.animation ? "Air speed · transient flow" : viz.streamlines ? "Air speed · steady flow" : "Air speed"}
        unit="m/s"
        map={map}
        ticks={sequential(0, ranges.speed[1]).map((t) => ({ ...t, sub: `${Math.round(Number(t.label.replace(/,/g, "")) * 3.6)} km/h` }))}
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
  const overview = viz.surface && viz.streamlines && viz.stream.layout === "overview" && out.length === 2;
  return <div className={`legend-stack${overview ? " overview-legends" : ""}`}>{out}</div>;
}
