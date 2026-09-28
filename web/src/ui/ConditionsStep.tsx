// Step 2: driving conditions and the simulation box.

import { useRef } from "react";
import { Box, Wand2 } from "lucide-react";
import { domainFor, validateDomain } from "../solver/setup";
import type { SimulationBox, Vec3 } from "../solver/types";
import { useStore } from "../store/store";
import { app, goStep, setSettings } from "../store/app";
import { Badge, Field, NumberField, Segmented, Slider, Toggle } from "./controls";
import { fmt } from "./format";

const MIN = 5, MAX = 300;
const A0 = -135, A1 = 135;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, d0: number, d1: number): string {
  const [x0, y0] = polar(cx, cy, r, d0), [x1, y1] = polar(cx, cy, r, d1);
  return `M${x0},${y0} A${r},${r} 0 ${d1 - d0 > 180 ? 1 : 0} 1 ${x1},${y1}`;
}

/** Big draggable speed dial (keyboard: arrows ±1, shift or page keys ±10). */
function SpeedDial({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const t = (value - MIN) / (MAX - MIN);
  const ang = A0 + t * (A1 - A0);
  const set = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height * (100 / 180));
    let deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
    if (deg > 180) deg -= 360;
    deg = Math.min(A1, Math.max(A0, deg));
    onChange(Math.round(MIN + ((deg - A0) / (A1 - A0)) * (MAX - MIN)));
  };
  const key = (e: React.KeyboardEvent) => {
    const big = e.shiftKey || e.key.startsWith("Page");
    const d = { ArrowUp: 1, ArrowRight: 1, PageUp: 10, ArrowDown: -1, ArrowLeft: -1, PageDown: -10 }[e.key];
    if (d !== undefined) onChange(Math.min(MAX, Math.max(MIN, value + d * (big && Math.abs(d) === 1 ? 10 : 1))));
    else if (e.key === "Home") onChange(MIN);
    else if (e.key === "End") onChange(MAX);
    else return;
    e.preventDefault();
  };
  const [kx, ky] = polar(100, 100, 78, ang);
  return (
    <svg
      ref={ref}
      className="speed-dial"
      viewBox="0 0 200 180"
      role="slider"
      tabIndex={0}
      aria-label="Road speed"
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      aria-valuenow={value}
      aria-valuetext={`${value} km/h`}
      onKeyDown={key}
      onPointerDown={(e) => {
        dragging.current = true;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        set(e);
      }}
      onPointerMove={(e) => dragging.current && set(e)}
      onPointerUp={() => (dragging.current = false)}
    >
      <defs>
        <linearGradient id="dial-grad" x1="0" x2="1">
          <stop offset="0" stopColor="var(--accent-2)" />
          <stop offset="1" stopColor="var(--accent)" />
        </linearGradient>
      </defs>
      <path className="dial-track" d={arc(100, 100, 78, A0, A1)} />
      <path className="dial-fill" d={arc(100, 100, 78, A0, Math.max(A0 + 0.5, ang))} stroke="url(#dial-grad)" />
      {[5, 50, 100, 150, 200, 250, 300].map((v) => {
        const a = A0 + ((v - MIN) / (MAX - MIN)) * (A1 - A0);
        const [x0, y0] = polar(100, 100, 92, a), [x1, y1] = polar(100, 100, 97, a);
        const [tx, ty] = polar(100, 100, 62, a);
        return (
          <g key={v}>
            <line className="dial-tick" x1={x0} y1={y0} x2={x1} y2={y1} />
            {v % 100 === 0 || v === 5 ? <text className="dial-label" x={tx} y={ty + 3} textAnchor="middle">{v}</text> : null}
          </g>
        );
      })}
      <circle className="dial-knob" cx={kx} cy={ky} r={9} />
      <text className="dial-value" x={100} y={108} textAnchor="middle">{value}</text>
      <text className="dial-unit" x={100} y={128} textAnchor="middle">km/h · {(value / 3.6).toFixed(1)} m/s</text>
    </svg>
  );
}

function YawPreview({ yaw }: { yaw: number }) {
  const a = (yaw * Math.PI) / 180;
  // Air moves toward +X with a lateral component U·tan(yaw); screen y points down, world +Y up.
  const dx = Math.cos(a), dy = -Math.sin(a);
  const arrows = [-18, 0, 18];
  return (
    <svg className="yaw-preview" viewBox="0 0 120 64" aria-hidden>
      {arrows.map((o) => {
        const cx = 26, cy = 32 + o;
        return (
          <g key={o} className="yaw-arrow">
            <line x1={cx - dx * 12} y1={cy - dy * 12} x2={cx + dx * 12} y2={cy + dy * 12} />
            <path d={`M${cx + dx * 12},${cy + dy * 12} l${-dx * 6 - dy * 4},${-dy * 6 + dx * 4} M${cx + dx * 12},${cy + dy * 12} l${-dx * 6 + dy * 4},${-dy * 6 - dx * 4}`} />
          </g>
        );
      })}
      <rect className="yaw-car" x={52} y={22} width={56} height={20} rx={8} />
      <rect className="yaw-glass" x={66} y={25} width={20} height={14} rx={4} />
      <text className="yaw-front" x={52} y={58}>front</text>
    </svg>
  );
}

export function ConditionsStep() {
  const design = useStore(app, (s) => s.design)!;
  const report = useStore(app, (s) => s.report);
  const showBox = useStore(app, (s) => s.showBox);
  const s = design.settings;
  const low = (report?.low ?? [0, 0, 0]) as Vec3;
  const high = (report?.high ?? [1, 1, 1]) as Vec3;
  const domain = domainFor(s, low, high);
  const boxError = validateDomain(domain, low, high);
  const blockage = s.reference_area / ((domain[3] - domain[2]) * domain[5]);
  const estimate = report?.frontalArea ?? 0;
  const setBox = (patch: Partial<SimulationBox>) => {
    const cur = s.simulation_box ?? { x_min: domain[0], x_max: domain[1], y_min: domain[2], y_max: domain[3], z_max: domain[5] };
    setSettings({ simulation_box: { ...cur, ...patch } });
  };
  const box = s.simulation_box;

  return (
    <div className="step-body">
      <div className="speed-block">
        <SpeedDial value={Math.round(s.speed_kmh)} onChange={(v) => setSettings({ speed_kmh: v })} />
        <div className="presets" role="group" aria-label="Speed presets">
          {[50, 100, 130, 200, 250].map((v) => (
            <button key={v} className={`chip ${Math.round(s.speed_kmh) === v ? "on" : ""}`} onClick={() => setSettings({ speed_kmh: v })}>
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="group">
        <div className="yaw-row">
          <Slider label="Yaw (crosswind)" min={-20} max={20} step={1} value={s.yaw_deg} display={`${s.yaw_deg > 0 ? "+" : ""}${s.yaw_deg}°`} onChange={(v) => setSettings({ yaw_deg: v })} />
          <YawPreview yaw={s.yaw_deg} />
        </div>
      </div>

      <div className="group">
        <Field label="Reference area" hint="Used for Cd and Cl. Keep it the same when you compare designs.">
          <div className="row gap-s">
            <NumberField value={s.reference_area} min={0.01} max={20} step={0.05} digits={2} unit="m²" label="Reference area" onChange={(v) => setSettings({ reference_area: v })} width={116} />
            {estimate > 0 && (
              <button className="btn ghost sm" onClick={() => setSettings({ reference_area: +estimate.toFixed(3) })} title="Projected frontal area of the enabled parts">
                <Wand2 size={14} /> Use estimate {fmt(estimate, 2)} m²
              </button>
            )}
          </div>
        </Field>
        <Field label="Air density">
          <NumberField value={s.density} min={0.5} max={1.5} step={0.005} digits={3} unit="kg/m³" label="Air density" onChange={(v) => setSettings({ density: v })} width={136} />
        </Field>
        <Toggle checked={s.moving_ground} onChange={(v) => setSettings({ moving_ground: v })} label="Moving ground" hint="The road moves at car speed, as on a rolling road." />
        <Toggle checked={s.wheels} onChange={(v) => setSettings({ wheels: v })} label="Rotating wheels" hint="Parts marked Wheel spin at road speed." />
      </div>

      <div className="group">
        <div className="group-title">
          <span>Simulation box</span>
          <Badge kind={blockage > 0.05 ? "warn" : "ok"} title="Reference area divided by the tunnel cross-section">
            Blockage {(blockage * 100).toFixed(1)} %
          </Badge>
        </div>
        <Segmented<"auto" | "custom">
          label="Simulation box"
          value={box ? "custom" : "auto"}
          options={[{ value: "auto", label: "Automatic" }, { value: "custom", label: "Custom" }]}
          onChange={(v) => (v === "auto" ? setSettings({ simulation_box: null }) : setBox({}))}
        />
        {!box && <small className="field-hint">3 car lengths ahead, 6 behind, 2 to each side and above.</small>}
        {box && (
          <div className="box-grid">
            {([
              ["x_min", "Inlet X"], ["x_max", "Outlet X"], ["y_min", "Side −Y"], ["y_max", "Side +Y"], ["z_max", "Top Z"],
            ] as [keyof SimulationBox, string][]).map(([k, label]) => (
              <Field key={k} label={label}>
                <NumberField value={box[k]} step={0.1} digits={2} unit="m" label={label} invalid={!!boxError} onChange={(v) => setBox({ [k]: v })} />
              </Field>
            ))}
          </div>
        )}
        {boxError && <p className="inline-error">{boxError}</p>}
        <button className={`btn ghost sm ${showBox ? "active" : ""}`} onClick={() => app.set({ showBox: !showBox })}>
          <Box size={15} /> {showBox ? "Hide box" : "Show box in 3D"}
        </button>
        <small className="field-hint">
          Box {fmt(domain[1] - domain[0], 1)} × {fmt(domain[3] - domain[2], 1)} × {fmt(domain[5], 1)} m. The road is always at Z = 0.
        </small>
      </div>

      <button className="btn primary block" disabled={!!boxError} onClick={() => goStep("run")}>
        Continue to run
      </button>
    </div>
  );
}
