// Visualisation layers: toggle chips plus the options of the layer in focus.

import { useState } from "react";
import { Car, ChevronUp, Cloud, Layers, Pause, Play, Spline, Wind, X } from "lucide-react";
import type { VizField } from "../solver/extract";
import { useStore } from "../store/store";
import { app, setViz } from "../store/app";
import { fieldBox } from "../viz/field";
import type { VizSettings } from "../viz/stage";
import type { SliceField } from "../viz/slice";
import { Segmented, Slider, Toggle } from "./controls";
import { stages } from "./StageView";

type Layer = "surface" | "smoke" | "streamlines" | "slice" | "wake";

const sliceView = (axis: 0 | 1 | 2) => (axis === 1 ? "side" : axis === 2 ? "top" : "rear");

const LAYERS: { key: Layer; label: string; icon: typeof Car; needsField: boolean }[] = [
  { key: "surface", label: "Surface", icon: Car, needsField: false },
  { key: "smoke", label: "Smoke", icon: Wind, needsField: true },
  { key: "streamlines", label: "Streamlines", icon: Spline, needsField: true },
  { key: "slice", label: "Slice", icon: Layers, needsField: true },
  { key: "wake", label: "Wake", icon: Cloud, needsField: true },
];

function Options({ layer, viz, field, particles, stageIds }: { layer: Layer; viz: VizSettings; field: VizField | null; particles: boolean; stageIds?: string[] }) {
  if (layer === "surface")
    return (
      <>
        <p className="muted small">Pressure coefficient on the car. Blue is suction, red is stagnation. Grey marks surface points without fluid nearby.</p>
        <Toggle checked={viz.surfaceFlow} onChange={(v) => setViz({ surfaceFlow: v })} label="Surface flow lines" hint="Oil-flow streaks along the air direction next to the wall." />
      </>
    );
  if (layer === "smoke")
    return particles ? (
      <>
        <Segmented<"filaments" | "sheet">
          size="sm"
          label="Smoke style"
          value={viz.smokeStyle}
          options={[{ value: "filaments", label: "Filaments" }, { value: "sheet", label: "Sheet" }]}
          onChange={(v) => setViz({ smokeStyle: v })}
        />
        <Slider label="Density" min={0.1} max={1} step={0.05} value={viz.smokeDensity} display={`${Math.round(viz.smokeDensity * 65.5)}k particles`} onChange={(v) => setViz({ smokeDensity: v })} />
        <Slider label="Trail length" min={0.15} max={1.5} step={0.05} value={viz.trail} display={`${viz.trail.toFixed(2)} s`} onChange={(v) => setViz({ trail: v })} />
        <Slider label="Rake width" min={0.02} max={Math.max(3, viz.rake.width * 2)} step={0.01} value={viz.rake.width} display={`${viz.rake.width.toFixed(2)} m`} onChange={(v) => setViz({ rake: { ...viz.rake, width: v } })} />
        <Slider label="Rake height" min={0.02} max={Math.max(2, viz.rake.height * 2)} step={0.01} value={viz.rake.height} display={`${viz.rake.height.toFixed(2)} m`} onChange={(v) => setViz({ rake: { ...viz.rake, height: v } })} />
        <p className="tip">Drag the blue knob in the view to move the smoke rake.</p>
      </>
    ) : (
      <p className="inline-error">Animated smoke needs WebGL2 float render targets, which this browser does not provide.</p>
    );
  if (layer === "streamlines")
    return (
      <>
        <Slider label="Lines" min={4} max={64} step={1} value={viz.stream.count} onChange={(v) => setViz({ stream: { ...viz.stream, count: v } })} />
        <Slider label="Rake length" min={0.05} max={Math.max(3, viz.stream.length * 2)} step={0.01} value={viz.stream.length} display={`${viz.stream.length.toFixed(2)} m`} onChange={(v) => setViz({ stream: { ...viz.stream, length: v } })} />
        <Segmented<"vertical" | "horizontal">
          size="sm"
          label="Rake orientation"
          value={viz.stream.orientation}
          options={[{ value: "vertical", label: "Vertical rake" }, { value: "horizontal", label: "Horizontal rake" }]}
          onChange={(o) => setViz({ stream: { ...viz.stream, orientation: o } })}
        />
        <Toggle checked={viz.stream.animate} onChange={(v) => setViz({ stream: { ...viz.stream, animate: v } })} label="Animated flow pulses" hint="Pulses travel at the local air speed." />
        <p className="tip">Drag the yellow knob to move the seed rake.</p>
      </>
    );
  if (layer === "slice") {
    const box = field ? fieldBox(field) : null;
    const lo = box ? box.min.getComponent(viz.sliceAxis) : 0, hi = box ? box.max.getComponent(viz.sliceAxis) : 1;
    const setAxis = (a: 0 | 1 | 2) => {
      const mid = box ? (a === 0 ? box.min.x + 0.55 * (box.max.x - box.min.x) : a === 1 ? (box.min.y + box.max.y) / 2 : box.min.z + 0.25 * (box.max.z - box.min.z)) : 0;
      setViz({ sliceAxis: a, slicePos: mid });
      for (const id of stageIds ?? ["main"]) stages[id]?.setView(sliceView(a), true, false, true);
    };
    return (
      <>
        <Segmented<0 | 1 | 2>
          size="sm"
          label="Slice direction"
          value={viz.sliceAxis}
          options={[
            { value: 1, label: "Side (Y)", title: "Vertical plane along the car" },
            { value: 2, label: "Height (Z)", title: "Horizontal plane" },
            { value: 0, label: "Across (X)", title: "Cross-section, facing the flow" },
          ]}
          onChange={setAxis}
        />
        <Slider label="Position" min={lo} max={hi} step={(hi - lo) / 400 || 0.01} value={Math.min(hi, Math.max(lo, viz.slicePos))} display={`${"XYZ"[viz.sliceAxis]} = ${viz.slicePos.toFixed(2)} m`} onChange={(v) => setViz({ slicePos: v })} />
        <Segmented<SliceField>
          size="sm"
          label="Slice colour"
          value={viz.sliceField}
          options={[
            { value: "speed", label: "Speed" },
            { value: "pressure", label: "Pressure" },
            { value: "cp0", label: "Cp0", title: "Total-pressure coefficient: losses in the wake" },
            { value: "k", label: "k", title: "Turbulent kinetic energy" },
          ]}
          onChange={(f) => setViz({ sliceField: f })}
        />
        {particles && <Toggle checked={viz.sliceTracers} onChange={(v) => setViz({ sliceTracers: v })} label="Flow tracers" hint="In-plane motion of the air." />}
        <p className="tip">Drag the white knob to slide the plane.</p>
      </>
    );
  }
  return (
    <>
      <Slider label="Iso level Cp0" min={-0.4} max={0.8} step={0.02} value={viz.wakeLevel} display={viz.wakeLevel.toFixed(2)} onChange={(v) => setViz({ wakeLevel: v })} />
      <Segmented<"speed" | "cp">
        size="sm"
        label="Wake colour"
        value={viz.wakeColor}
        options={[{ value: "speed", label: "Colour by speed" }, { value: "cp", label: "Colour by Cp" }]}
        onChange={(c) => setViz({ wakeColor: c })}
      />
      <p className="muted small">The surface wraps air that lost total pressure (Cp0 below the level): boundary layers, separated flow and vortices. Cp0 = 1 is undisturbed air.</p>
    </>
  );
}

export function VizDock(props: { field: VizField | null; particles: boolean; surface: boolean; stageIds?: string[] }) {
  const { field, particles, surface } = props;
  const viz = useStore(app, (s) => s.viz);
  const [focus, setFocus] = useState<Layer | null>(null);
  const toggle = (l: Layer) => {
    const on = !viz[l];
    // A section plane reads best on its own: smoke off, camera facing the plane.
    setViz(l === "slice" && on ? { slice: true, smoke: false } : ({ [l]: on } as Partial<VizSettings>));
    if (l === "slice" && on) for (const id of props.stageIds ?? ["main"]) stages[id]?.setView(sliceView(viz.sliceAxis), true, false, true);
    setFocus(on ? l : focus === l ? null : focus);
  };
  const shownFocus = focus && (focus === "surface" || viz[focus]) ? focus : null;
  const animated = viz.smoke || (viz.slice && viz.sliceTracers) || (viz.streamlines && viz.stream.animate);
  return (
    <div className="viz-dock">
      {shownFocus && (
        <div className="viz-options glass" role="region" aria-label={`${shownFocus} options`}>
          <div className="viz-options-head">
            <b>{LAYERS.find((l) => l.key === shownFocus)!.label}</b>
            <button className="icon-btn xs" aria-label="Close options" onClick={() => setFocus(null)}><X size={14} /></button>
          </div>
          <Options layer={shownFocus} viz={viz} field={field} particles={particles} stageIds={props.stageIds} />
        </div>
      )}
      <div className="viz-bar glass" role="toolbar" aria-label="Visualisation layers">
        {LAYERS.map(({ key, label, icon: Icon, needsField }) => {
          const disabled = needsField ? !field : !surface;
          const on = viz[key] && !disabled;
          return (
            <div key={key} className={`layer-chip ${on ? "on" : ""} ${shownFocus === key ? "focus" : ""}`}>
              <button className="layer-toggle" aria-pressed={on} disabled={disabled} onClick={() => toggle(key)} data-testid={`layer-${key}`} title={disabled ? "Available after a run" : `Show ${label.toLowerCase()}`}>
                <Icon size={16} /> <span>{label}</span>
              </button>
              {on && (
                <button className="layer-more" aria-label={`${label} options`} onClick={() => setFocus(shownFocus === key ? null : key)}>
                  <ChevronUp size={14} />
                </button>
              )}
            </div>
          );
        })}
        <span className="bar-sep" />
        <button className="icon-btn" disabled={!animated || !field} onClick={() => setViz({ playing: !viz.playing })} aria-label={viz.playing ? "Pause animation" : "Play animation"} title={viz.playing ? "Pause" : "Play"}>
          {viz.playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <Slider label="Playback" min={0.25} max={2} step={0.05} value={viz.flowSpeed} display={`${viz.flowSpeed.toFixed(2)}×`} onChange={(v) => setViz({ flowSpeed: v })} />
      </div>
    </div>
  );
}
