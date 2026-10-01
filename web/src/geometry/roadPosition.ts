import type { Part } from "./model";

type RoadPart = Pick<Part, "positions" | "role" | "enabled">;

export const ROAD_CONTACT_ERROR = "Ground contact is for preview. Use Simulation gap to leave the 5 mm clearance required for a run.";

export function lowestPoint(parts: RoadPart[]): number | null {
  let lowest = Infinity;
  for (const p of parts) for (let i = 2; i < p.positions.length; i += 3) lowest = Math.min(lowest, p.positions[i]);
  return Number.isFinite(lowest) ? lowest : null;
}

/** Anchor to actual tyre vertices, with a model-bottom fallback when there are no enabled wheels. */
export function roadPosition(parts: RoadPart[]) {
  const enabled = parts.filter(p => p.enabled);
  const wheels = enabled.filter(p => p.role === "wheel");
  return { height: lowestPoint(wheels.length ? wheels : enabled), wheels: wheels.length, lowest: lowestPoint(enabled) };
}

/** Change only the shared vertical translation; keep orientation, scale and part assembly intact. */
export function clearanceForRoadHeight(clearance: number, currentHeight: number, targetHeight: number) {
  return clearance + targetHeight - currentHeight;
}
