import { balanceAtAxles, momentOrigin } from "./aero";
import type { Axles, RunResult } from "./types";

/** Derived analysis only. The stored CFD result and its original moment origin stay unchanged. */
export function resultAtAxles(result: RunResult, axles: Axles | undefined, referenceArea: number): RunResult {
  if (result.balance || !result.aero || !axles) return result;
  const qArea = result.dynamicPressure * referenceArea;
  const balance = balanceAtAxles(result.aero, axles, qArea);
  if (!balance) return result;
  const origin = momentOrigin(axles), from = result.aero.origin;
  const history = result.history.map(h => {
    if (h.pitch === undefined) return h;
    const pitch = h.pitch + (from[2]-origin[2])*h.cd*qArea - (from[0]-origin[0])*h.cl*qArea;
    const rearLift = -pitch/balance.wheelbase;
    return {...h, pitch, rearLift, frontLift: h.cl*qArea-rearLift};
  });
  const window = result.provenance?.averaging;
  const samples = window ? history.filter(h => h.time >= window.start && h.time <= window.end) : [];
  const band = (key: "pitch" | "frontLift" | "rearLift") => {
    const values = samples.map(h => h[key]);
    return values.length >= 2 && values.every(v => v !== undefined && Number.isFinite(v))
      ? (Math.max(...values as number[])-Math.min(...values as number[]))/2 : undefined;
  };
  const front = band("frontLift"), rear = band("rearLift"), pitch = band("pitch");
  const levels = result.levels?.map(l => ({...l, balance: l.aero ? balanceAtAxles(l.aero,axles,qArea) : undefined}));
  const spread = (key: "pitch" | "frontLift" | "rearLift") => {
    const values = levels?.map(l => l.balance?.[key]);
    return values && values.length >= 2 && values.every(v => v !== undefined && Number.isFinite(v))
      ? Math.max(...values as number[])-Math.min(...values as number[]) : undefined;
  };
  return {...result, balance, history, levels,
    balanceBands: front === undefined || rear === undefined || pitch === undefined ? undefined : {frontLift:front,rearLift:rear,pitch},
    meshSensitivity: result.meshSensitivity ? {...result.meshSensitivity, frontLift:spread("frontLift"),rearLift:spread("rearLift"),pitch:spread("pitch")} : undefined};
}
