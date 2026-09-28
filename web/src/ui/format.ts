// Number and text formatting shared by the panels.

import type { GeometrySummary } from "../store/types";
import { G, type RunResult, type Settings } from "../solver/types";
import { PRESETS } from "../solver/types";

export const fmt = (v: number, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : "–");

export function fmtInt(v: number): string {
  return Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "–";
}

export function fmtCells(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
  return String(n);
}

export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return "–";
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  if (m < 60) return r ? `${m} min ${r} s` : `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function fmtDate(t: number): string {
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Signed vertical load in kilograms: downforce when the car is pushed onto the road. */
export function verticalLoad(r: RunResult): { label: "Downforce" | "Lift"; kg: number; newtons: number } {
  const down = r.downforce >= 0;
  return { label: down ? "Downforce" : "Lift", kg: Math.abs(r.downforce) / G, newtons: Math.abs(r.downforce) };
}

export function qualityLabel(s: Settings): string {
  if (s.quality === "custom") return `Custom ${s.custom_cells} cells · ${s.custom_passes} passes`;
  return PRESETS[s.quality].label;
}

export function conditionsLine(s: Settings): string {
  return `${Math.round(s.speed_kmh)} km/h · ${fmt(s.yaw_deg, 0)}° yaw · ${qualityLabel(s)}`;
}

/**
 * Optional groups a run simulated (everything except Body and Wheels), e.g. "Rear wing B".
 * Empty when the run has no optional groups; "no optional groups" when all were off.
 */
export function groupsLine(g: GeometrySummary): string {
  const optional = (g.groups ?? []).filter((x) => x.id !== "g:body" && x.id !== "g:wheels");
  if (!optional.length) return "";
  const on = optional.filter((x) => x.enabled).map((x) => x.name);
  return on.length ? on.join(" + ") : "no optional groups";
}

export function pct(part: number, total: number): string {
  if (!total) return "–";
  return `${((100 * part) / total).toFixed(0)} %`;
}

export function signed(v: number, digits = 1): string {
  if (!Number.isFinite(v)) return "–";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
}
