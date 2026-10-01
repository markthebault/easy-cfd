import { CircleGauge, Focus, Maximize2, Navigation2, PanelLeftOpen, Pause, Play, Wind } from "lucide-react";
import type { DrivingConditions } from "../viz/driving";
import { app, setViz } from "../store/app";
import { useStore } from "../store/store";
import { stages } from "./StageView";
import { Segmented } from "./controls";
import { boundaryLine } from "./format";

export function DrivingDock({ conditions, focused, onFocus }: { conditions: DrivingConditions; focused: boolean; onFocus: () => void }) {
  const v = useStore(app, s => s.viz);
  const yaw = conditions.yaw_deg;
  return <div className="driving-dock">
    <div className="driving-preview glass" role="region" aria-label="Driving preview">
      <div className="driving-heading">
        <span className="wind-compass"><Navigation2 size={24} style={{ transform: `rotate(${90 - yaw}deg)` }} /></span>
        <div><b>Driving preview</b><span>{Math.round(conditions.speed_kmh)} km/h <i>·</i> {yaw === 0 ? "Head-on wind" : `${yaw > 0 ? "+" : ""}${yaw}° crosswind`}</span></div>
        <button className="icon-btn" aria-label={focused ? "Show setup" : "Expand view"} title={focused ? "Show setup" : "Expand view"} onClick={onFocus}>{focused ? <PanelLeftOpen size={17} /> : <Maximize2 size={17} />}</button>
        <button className="icon-btn" aria-label="Reset preview camera" title="Reset view" onClick={() => stages.main?.setView("iso", v.playing)}><Focus size={17} /></button>
      </div>
      <div className="driving-controls">
        <button className="drive-play" aria-label={v.playing ? "Pause animation" : "Play animation"} onClick={() => setViz({ playing: !v.playing })}>{v.playing ? <Pause size={17} /> : <Play size={17} />}<span>{v.playing ? "Pause" : "Play"}</span></button>
        <button className={`drive-chip ${v.windDirection ? "on" : ""}`} aria-pressed={v.windDirection} onClick={() => setViz({ windDirection: !v.windDirection })}><Wind size={15} />Smoke</button>
        <button className={`drive-chip ${v.motion ? "on" : ""}`} aria-pressed={v.motion} onClick={() => setViz({ motion: !v.motion })}><CircleGauge size={15} />Road &amp; tyres</button>
        <Segmented<number> label="Preview playback speed" size="sm" value={v.flowSpeed} options={[{ value: 0.25, label: "¼×" }, { value: 0.5, label: "½×" }, { value: 1, label: "1×" }]} onChange={flowSpeed => setViz({ flowSpeed })} />
      </div>
      <div className="driving-caption"><span className={`drive-status ${v.playing ? "playing" : ""}`} />{v.playing ? "Motion slowed for viewing" : "Preview paused"}<span className="drive-boundaries">{boundaryLine(conditions)}</span></div>
      <p className="driving-note">Five smoke streams follow the body shape. Illustrative preview; run a simulation for computed airflow.</p>
    </div>
  </div>;
}
