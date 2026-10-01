// Visualisation layers: toggle chips plus the options of the layer in focus.

import { useCallback, useRef, useState } from "react";
import { Car, ChevronUp, CircleGauge, Cloud, Grid2X2, Layers, Maximize2, PanelLeftOpen, Pause, Play, Spline, Wind, X } from "lucide-react";
import type { VizField } from "../solver/extract";
import { useStore } from "../store/store";
import { app, setViz } from "../store/app";
import { fieldBox } from "../viz/field";
import type { ForceValues, VizSettings } from "../viz/stage";
import { activeAnalysis, analysisPreset, ANALYSES, type AnalysisLayer, type AnalysisMode } from "../viz/analysis";
import type { SliceField } from "../viz/slice";
import { Segmented, Slider, Toggle } from "./controls";
import { stages } from "./StageView";
import { AnalysisPicker } from "./AnalysisPicker";
import type { DrivingConditions } from "../viz/driving";

type Layer = AnalysisLayer | "motion" | "windDirection";

const sliceView = (axis: 0 | 1 | 2) => (axis === 1 ? "side" : axis === 2 ? "top" : "rear");

const LAYERS: { key: Layer; label: string; icon: typeof Car; needsField: boolean }[] = [
  { key: "surface", label: "Surface", icon: Car, needsField: false },
  { key: "smoke", label: "Smoke", icon: Wind, needsField: true },
  { key: "streamlines", label: "Streamlines", icon: Spline, needsField: true },
  { key: "slice", label: "Slice", icon: Layers, needsField: true },
  { key: "wake", label: "Wake", icon: Cloud, needsField: true },
  { key: "motion", label: "Road & tyres", icon: CircleGauge, needsField: false },
];

function Options({ layer, viz, field, particles, stageIds, forces, driving }: { layer: Layer; viz: VizSettings; field: VizField | null; particles: boolean; stageIds?: string[]; forces?: ForceValues | null; driving?: DrivingConditions | null }) {
  if (layer === "motion") return <><p className="muted small">The road and imported wheels follow this run’s saved boundary settings at {Math.round(driving?.speed_kmh ?? 0)} km/h. Playback is slowed so you can see the motion.</p><p className="tip">Road {driving?.moving_ground ? "moving" : "fixed"} · Wheels {driving?.wheels ? "rotating" : "fixed"}. Wheel rotation pauses in surface and slice analyses to keep the saved data aligned.</p></>;
  if (layer === "pressureCloud") return <>
    <p className="muted small">Blue encloses suction; coral encloses positive pressure. These surfaces mark equal static pressure in the computed air field.</p>
    <Segmented<VizSettings["cloudSign"]> size="sm" label="Pressure regions" value={viz.cloudSign} options={[{ value: "both", label: "Both" }, { value: "negative", label: "Suction" }, { value: "positive", label: "Positive" }]} onChange={cloudSign => setViz({ cloudSign })} />
    <Slider label="Pressure threshold" min={0.02} max={1} step={0.01} value={viz.cloudLevel} display={`±${viz.cloudLevel.toFixed(2)} Cp`} onChange={cloudLevel => setViz({ cloudLevel })} />
    <Slider label="Cloud opacity" min={0.1} max={0.7} step={0.02} value={viz.cloudOpacity} display={`${Math.round(viz.cloudOpacity * 100)}%`} onChange={cloudOpacity => setViz({ cloudOpacity })} />
    <p className="tip">Lower the threshold to reveal weaker pressure regions. If a region never reaches the threshold, its cloud is empty.</p>
    <Toggle checked={viz.pressureCloud} onChange={pressureCloud => setViz({ pressureCloud })} label="Show pressure clouds" />
  </>;
  if (layer === "forces") return <>
    <p className="muted small">Time-averaged forces on the whole car. Arrow lengths share one scale; their position is illustrative, not the centre of pressure.</p>
    {stageIds && stageIds.length > 1 && <p className="tip">Values below are for run A. Each view shows its own forces on a shared scale.</p>}
    {forces && <div className="force-readouts"><div><i className="force-dot drag" />Drag<b>{forces.drag.toFixed(1)} <small>N</small></b></div><div><i className="force-dot vertical" />{forces.lift < 0 ? "Downforce" : "Lift"}<b>{Math.abs(forces.lift).toFixed(1)} <small>N</small></b></div><div><i className="force-dot side" />Side force<b>{(Math.abs(forces.side) < 0.05 ? 0 : forces.side).toFixed(1)} <small>N</small></b></div></div>}
    <p className="tip">Drag points along the car’s X axis. The vertical arrow shows whether air lifts the car or pushes it onto the road.</p>
    <Toggle checked={viz.forces} onChange={forces => setViz({ forces })} label="Show force arrows" />
  </>;
  if (layer === "surface" && viz.friction) return <>
    <p className="muted small">Wall-stress magnitude on the car. Grey means no valid wall sample. This is the final solver snapshot, separate from averaged forces.</p>
    <Segmented<"Pa" | "Cf"> label="Friction units" value={viz.frictionUnit ?? "Pa"} options={[{value:"Pa",label:"Pa"},{value:"Cf",label:"Cf"}]} onChange={frictionUnit=>setViz({frictionUnit,frictionMax:undefined})} />
    <Slider label="Colour scale maximum" min={viz.frictionUnit === "Cf" ? .0001 : .1} max={viz.frictionUnit === "Cf" ? .1 : 50} step={viz.frictionUnit === "Cf" ? .0001 : .1} value={viz.frictionMax ?? (stages[(stageIds ?? ["main"])[0]]?.frictionScale(viz.frictionUnit) ?? (viz.frictionUnit === "Cf" ? .01 : 5))} display={`${(viz.frictionMax ?? (stages[(stageIds ?? ["main"])[0]]?.frictionScale(viz.frictionUnit) ?? (viz.frictionUnit === "Cf" ? .01 : 5))).toFixed(viz.frictionUnit === "Cf" ? 4 : 1)} ${viz.frictionUnit ?? "Pa"}`} onChange={frictionMax=>setViz({frictionMax})} />
    <p className="tip">Cf = wall stress / dynamic pressure. Both comparison views use this unit and scale; physical zero stays at zero.</p>
  </>;
  if (layer === "surface")
    return (
      <>
        <p className="muted small">{viz.surface ? "Pressure coefficient on the car. Blue is suction, red is positive pressure. Grey marks surface points without fluid nearby." : "Oil-flow streaks follow the tangential air direction sampled near the wall. Look for changes in direction around the body."}</p>
        <Toggle checked={viz.surface} onChange={surface => setViz({ surface })} label="Pressure colours" />
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
        {viz.sliceField === "k" && <p className="muted small">Modelled turbulent kinetic energy. Brighter regions contain more turbulent energy; this is not a noise level.</p>}
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

export function VizDock(props: { field: VizField | null; particles: boolean; surface: boolean; friction?: boolean; forces?: ForceValues | null; stageIds?: string[]; driving?: DrivingConditions | null; focused?: boolean; onFocus?: () => void }) {
  const { field, particles, surface } = props;
  const viz = useStore(app, (s) => s.viz);
  const [focus, setFocus] = useState<Layer | null>(null);
  const [picker, setPicker] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  const closePicker = useCallback(() => { setPicker(false); launcher.current?.focus(); }, []);
  const pick = (mode: AnalysisMode) => {
    if (!field) return;
    const ids = props.stageIds ?? ["main"];
    const stage = stages[ids[0]];
    if (!stage) return;
    const a = ANALYSES.find(a => a.id === mode)!;
    setViz(analysisPreset(mode, viz, field, stage.carBounds()));
    for (const id of ids) stages[id]?.setView(a.view, viz.playing, false, a.layer === "slice", a.layer === "forces");
    setFocus(window.innerWidth <= 760 ? null : a.layer);
    closePicker();
  };
  const toggle = (l: Layer) => {
    const on = !viz[l];
    // A section plane reads best on its own: smoke off, camera facing the plane.
    setViz(l === "slice" && on ? { slice: true, smoke: false } : ({ [l]: on } as Partial<VizSettings>));
    if (l === "slice" && on) for (const id of props.stageIds ?? ["main"]) stages[id]?.setView(sliceView(viz.sliceAxis), true, false, true);
    setFocus(on ? l : focus === l ? null : focus);
  };
  const shownFocus = focus && (focus === "surface" || focus === "forces" || focus === "pressureCloud" || viz[focus]) ? focus : null;
  const animated = viz.motion || viz.windDirection || viz.smoke || viz.surfaceFlow || (viz.slice && viz.sliceTracers) || (viz.streamlines && viz.stream.animate);
  const active = activeAnalysis(viz);
  const current = ANALYSES.find(a => a.id === active);
  const focusTitle = current?.layer === shownFocus ? current.title : LAYERS.find(l => l.key === shownFocus)?.label ?? (shownFocus === "pressureCloud" ? "3D pressure clouds" : "Forces");
  return (
    <div className="viz-dock">
      {picker && <AnalysisPicker active={active} surface={surface} friction={props.friction} forces={!!props.forces} onPick={pick} onClose={closePicker} />}
      {!picker && shownFocus && (
        <div className="viz-options glass" role="region" aria-label={`${shownFocus} options`}>
          <div className="viz-options-head">
            <b>{focusTitle}</b>
            <button className="icon-btn xs" aria-label="Close options" onClick={() => setFocus(null)}><X size={14} /></button>
          </div>
          <Options layer={shownFocus} viz={viz} field={field} particles={particles} stageIds={props.stageIds} forces={props.forces} driving={props.driving} />
        </div>
      )}
      <div className="analysis-launcher glass"><button ref={launcher} className={`analysis-open ${picker ? "on" : ""}`} aria-expanded={picker} aria-controls="analysis-picker" onClick={() => picker ? closePicker() : setPicker(true)}><Grid2X2 size={17} /><span>Explore airflow</span><ChevronUp size={14} /></button><span className="analysis-current">{current?.title ?? "Custom layers"}</span>{current && !picker && <button className="btn ghost sm" aria-label="View settings" onClick={() => setFocus(shownFocus ? null : current.layer)}>Settings</button>}</div>
      <div className="viz-bar glass" role="toolbar" aria-label="Visualisation layers">
        {LAYERS.map(({ key, label, icon: Icon, needsField }) => {
          const disabled = key === "motion" || key === "windDirection" ? !props.driving : needsField ? !field : !surface;
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
        {props.onFocus && <button className="icon-btn" aria-label={props.focused ? "Show panel" : "Expand view"} title={props.focused ? "Show panel" : "Expand view"} onClick={props.onFocus}>{props.focused ? <PanelLeftOpen size={16} /> : <Maximize2 size={16} />}</button>}
      </div>
    </div>
  );
}
