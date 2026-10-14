import type { Settings, Vec3 } from "./types";

/** Automatic tunnel: 3 car lengths upstream, 6 downstream, 2 at each side and above. */
export function automaticDomain(low: Vec3, high: Vec3): [number, number, number, number, number, number] {
  const L = high[0] - low[0];
  return [low[0] - 3 * L, high[0] + 6 * L, low[1] - 2 * L, high[1] + 2 * L, 0, high[2] + 2 * L];
}

export function domainFor(settings: Settings, low: Vec3, high: Vec3): [number, number, number, number, number, number] {
  const b = settings.simulation_box;
  return b ? [b.x_min, b.x_max, b.y_min, b.y_max, 0, b.z_max] : automaticDomain(low, high);
}

export function validateDomain(domain: number[], low: Vec3, high: Vec3): string | null {
  const [x0, x1, y0, y1, , z1] = domain;
  if (!(x0 < low[0] && x1 > high[0] && y0 < low[1] && y1 > high[1] && z1 > high[2]))
    return "The simulation box must surround the car with space at the inlet, outlet, sides and top. The floor stays at Z = 0.";
  if (low[2] <= 0) return "The car must sit above the road (Z > 0).";
  return null;
}
