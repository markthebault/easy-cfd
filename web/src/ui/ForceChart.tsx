// Cd and Cl against simulated flow passes. One axis (both are coefficients), legend plus end
// labels, a hover crosshair, and the averaging window shaded when the run is complete.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ForceSample } from "../solver/types";
import { PASSES, type HistoryUnit } from "./historyUnit";
import { movingAverage } from "./windowStats";

interface Props {
  history: ForceSample[];
  /** Seconds of simulated time per flow pass (L / U). */
  passTime: number;
  averageFrom?: number;
  height?: number;
  live?: boolean;
  /** Draw a trailing moving average over this many flow passes (raw traces are dimmed). */
  maPasses?: number;
  /** Shade the trailing statistics window starting at this simulated time. */
  windowFrom?: number;
  unit?: HistoryUnit;
}

const PAD = { l: 40, r: 44, t: 10, b: 24 };

function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

export function ForceChart({ history, passTime, averageFrom, height = 150, live, maPasses, windowFrom, unit = PASSES }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
  const clip = `clip${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  useEffect(() => {
    const el = host.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const data = useMemo(() => {
    const every = Math.max(1, Math.ceil(history.length / 500));
    // Moving average on the full history, then thinned like the raw trace.
    const ma = maPasses ? movingAverage(history, maPasses * passTime) : null;
    const out: { x: number; cd: number; cl: number; mcd?: number; mcl?: number }[] = [];
    history.forEach((h, i) => {
      if (i % every !== 0 && i !== history.length - 1) return;
      out.push({ x: h.time / passTime, cd: h.cd, cl: h.cl, mcd: ma?.[i].cd, mcl: ma?.[i].cl });
    });
    return out;
  }, [history, passTime, maPasses]);

  const w = Math.max(160, width);
  const iw = w - PAD.l - PAD.r, ih = height - PAD.t - PAD.b;
  const xMax = Math.max(data.length ? data[data.length - 1].x : 1, 0.5);
  // The start-up transient can be ten times the settled value; scale to the later part.
  const tail = data.slice(Math.floor(data.length * 0.25));
  let lo = Math.min(0, ...tail.map((d) => Math.min(d.cd, d.cl)));
  let hi = Math.max(0.1, ...tail.map((d) => Math.max(d.cd, d.cl)));
  const padY = (hi - lo) * 0.12 || 0.1;
  lo -= padY;
  hi += padY;
  const sx = (x: number) => PAD.l + (x / xMax) * iw;
  const sy = (y: number) => PAD.t + ih - ((y - lo) / (hi - lo)) * ih;
  const path = (key: "cd" | "cl" | "mcd" | "mcl") =>
    data.map((d, i) => `${i ? "L" : "M"}${sx(d.x).toFixed(1)},${sy(d[key] ?? NaN).toFixed(1)}`).join("");
  const last = data[data.length - 1];
  const yt = niceTicks(lo, hi, 4);
  const xt = niceTicks(0, xMax, Math.max(2, Math.floor(iw / 70)));
  const hv = hover !== null ? data[hover] : null;

  const onMove = (e: React.PointerEvent) => {
    if (!data.length) return;
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const x = ((e.clientX - r.left - PAD.l) / iw) * xMax;
    let best = 0;
    for (let i = 1; i < data.length; i++) if (Math.abs(data[i].x - x) < Math.abs(data[best].x - x)) best = i;
    setHover(best);
  };

  // End labels: nudge apart only when they would overlap.
  let ycd = last ? sy(last.cd) : 0, ycl = last ? sy(last.cl) : 0;
  if (Math.abs(ycd - ycl) < 12) {
    const mid = (ycd + ycl) / 2, up = ycd < ycl ? -1 : 1;
    ycd = mid + up * 6;
    ycl = mid - up * 6;
  }

  return (
    <div className="chart" ref={host}>
      <div className="chart-legend">
        <span><i className="key cd" /> Cd drag</span>
        <span><i className="key cl" /> Cl lift</span>
        {maPasses && <span className="muted">bold: {maPasses}-{unit.one} average</span>}
        <span className="muted">x: {unit.axis}</span>
      </div>
      <svg width={w} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Force coefficient history">
        <defs>
          <clipPath id={clip}>
            <rect x={PAD.l} y={PAD.t} width={iw} height={ih} />
          </clipPath>
        </defs>
        {averageFrom !== undefined && (
          <rect className="avg-window" x={sx(averageFrom / passTime)} y={PAD.t} width={Math.max(0, sx(xMax) - sx(averageFrom / passTime))} height={ih} />
        )}
        {yt.map((v) => (
          <g key={v}>
            <line className={v === 0 ? "grid zero" : "grid"} x1={PAD.l} x2={PAD.l + iw} y1={sy(v)} y2={sy(v)} />
            <text className="tick" x={PAD.l - 6} y={sy(v) + 3.5} textAnchor="end">{+v.toFixed(3)}</text>
          </g>
        ))}
        {xt.map((v) => (
          <text key={v} className="tick" x={sx(v)} y={height - 6} textAnchor="middle">{+v.toFixed(2)}</text>
        ))}
        {windowFrom !== undefined && data.length > 0 && (
          <rect className="avg-window" x={sx(Math.max(0, windowFrom / passTime))} y={PAD.t} width={Math.max(0, sx(xMax) - sx(Math.max(0, windowFrom / passTime)))} height={ih} />
        )}
        <g clipPath={`url(#${clip})`}>
          <path className={`line cd ${maPasses ? "raw" : ""}`} d={path("cd")} />
          <path className={`line cl ${maPasses ? "raw" : ""}`} d={path("cl")} />
          {maPasses && data.length > 1 && (
            <>
              <path className="line cd ma" d={path("mcd")} />
              <path className="line cl ma" d={path("mcl")} />
            </>
          )}
        </g>
        {last && (
          <>
            <circle className={`dot cd ${live ? "pulse" : ""}`} cx={sx(last.x)} cy={Math.min(PAD.t + ih, Math.max(PAD.t, sy(last.cd)))} r={4} />
            <circle className={`dot cl ${live ? "pulse" : ""}`} cx={sx(last.x)} cy={Math.min(PAD.t + ih, Math.max(PAD.t, sy(last.cl)))} r={4} />
            <text className="end-label" x={sx(last.x) + 8} y={Math.min(PAD.t + ih, Math.max(PAD.t + 8, ycd)) + 3.5}>{last.cd.toFixed(3)}</text>
            <text className="end-label" x={sx(last.x) + 8} y={Math.min(PAD.t + ih, Math.max(PAD.t + 8, ycl)) + 3.5}>{last.cl.toFixed(3)}</text>
          </>
        )}
        {hv && (
          <g>
            <line className="crosshair" x1={sx(hv.x)} x2={sx(hv.x)} y1={PAD.t} y2={PAD.t + ih} />
            <circle className="dot cd" cx={sx(hv.x)} cy={sy(hv.cd)} r={4} />
            <circle className="dot cl" cx={sx(hv.x)} cy={sy(hv.cl)} r={4} />
          </g>
        )}
        {!data.length && (
          <text className="tick" x={PAD.l + iw / 2} y={PAD.t + ih / 2} textAnchor="middle">Waiting for the first forces…</text>
        )}
      </svg>
      {hv && (
        <div className="chart-tip" style={{ left: Math.min(w - 130, Math.max(0, sx(hv.x) + 10)) }}>
          <b>{unit === PASSES ? hv.x.toFixed(2) : Math.round(hv.x)} {unit.many}</b>
          <span><i className="key cd" /> Cd {hv.cd.toFixed(4)}{hv.mcd !== undefined && <small> · avg {hv.mcd.toFixed(4)}</small>}</span>
          <span><i className="key cl" /> Cl {hv.cl.toFixed(4)}{hv.mcl !== undefined && <small> · avg {hv.mcl.toFixed(4)}</small>}</span>
        </div>
      )}
    </div>
  );
}
