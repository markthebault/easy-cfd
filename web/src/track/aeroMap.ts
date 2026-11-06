import type { VizField } from '../solver/extract';
import type { Vec3 } from '../solver/types';

export interface MapSample {
  id: string; runId: string; speedKmh: number; yawDeg: number;
  field: string; cp: Record<string, string>; meshHash: string; cells: number;
  freestream: number; inlet: Vec3; speedMax: number;
  loads?: { cl: number; cd: number; downforceN: number; density: number; referenceArea: number };
  forceSettled: boolean; residualConverged: boolean; warnings: string[];
  hashes: Record<string, string>;
}
export interface MapManifest {
  version: 1; engine: 'openfoam'; quality: 'fast' | 'medium'; speeds: number[]; yaws: number[]; samples: MapSample[];
  meshHash: string; geometryHashes: Record<string, string>; speedMax: number; limitations: string[];
  grid: { origin: Vec3; spacing: Vec3; dims: [number, number, number]; length: number };
}
export interface AeroMap { manifest: MapManifest; samples: { info: MapSample; field: VizField; cp: Float32Array[] }[] }
export interface AeroWeights { indices: [number, number, number, number]; weights: [number, number, number, number]; speedKmh: number; yawDeg: number; covered: boolean }
export interface AirConditions { speedKmh: number; relativeSpeedKmh: number; yawDeg: number; slipRad: number; turnRate: number }
export interface Wind { speed: number; bearing: number }
export interface AeroLoads {
  netLiftN: number; liftN: number; downforceN: number; dragN: number; cl: number;
  forceSettled: boolean; residualConverged: boolean;
}

function bracket(axis: number[], value: number) {
  const clamped = Math.max(axis[0], Math.min(axis.at(-1)!, value));
  let i = 0; while (i < axis.length - 2 && axis[i + 1] < clamped) i++;
  return { a: axis[i], b: axis[i + 1], mix: (clamped - axis[i]) / (axis[i + 1] - axis[i]), value: clamped };
}
export function mapWeights(map: MapManifest, speed: number, yaw: number): AeroWeights {
  const s = bracket(map.speeds, speed), a = bracket(map.yaws, yaw);
  const at = (v: number, y: number) => {
    const i = map.samples.findIndex(p => p.speedKmh === v && p.yawDeg === y);
    if (i < 0) throw new Error('CFD map is missing a solved grid corner.'); return i;
  };
  return {
    indices: [at(s.a, a.a), at(s.b, a.a), at(s.a, a.b), at(s.b, a.b)],
    weights: [(1 - s.mix) * (1 - a.mix), s.mix * (1 - a.mix), (1 - s.mix) * a.mix, s.mix * a.mix],
    speedKmh: s.value, yawDeg: a.value,
    covered: speed >= map.speeds[0] && speed <= map.speeds.at(-1)! && yaw >= map.yaws[0] && yaw <= map.yaws.at(-1)!,
  };
}

/** Interpolate dimensionless Cl, then recover the net vertical force at the current airspeed.
 * Map speed is the longitudinal inlet component; OpenFOAM normalizes Cl by the full
 * inlet magnitude. Never interpolate endpoint forces in N: their dynamic pressures differ.
 * Outside the solved envelope, keep the visualization's boundary field but withhold loads.
 */
export function mapLoads(map: MapManifest, blend: AeroWeights): AeroLoads | null {
  if (!blend.covered) return null;
  const active = blend.indices.flatMap((index, i) => blend.weights[i] > 0 ? [{ sample: map.samples[index], weight: blend.weights[i] }] : []);
  const reference = active[0]?.sample.loads;
  if (!reference || !Number.isFinite(reference.density) || reference.density <= 0 || !Number.isFinite(reference.referenceArea) || reference.referenceArea <= 0) return null;
  let cl = 0, cd = 0;
  for (const { sample, weight } of active) {
    if (!sample.loads || !Number.isFinite(sample.loads.cl) || !Number.isFinite(sample.loads.cd) || sample.loads.density !== reference.density || sample.loads.referenceArea !== reference.referenceArea) return null;
    cl += weight * sample.loads.cl;
    cd += weight * sample.loads.cd;
  }
  const speed = blend.speedKmh / 3.6 / Math.cos(blend.yawDeg * Math.PI / 180);
  const netLiftN = .5 * reference.density * reference.referenceArea * speed * speed * cl;
  return {
    netLiftN, liftN: Math.max(0, netLiftN), downforceN: Math.max(0, -netLiftN), dragN: .5 * reference.density * reference.referenceArea * speed * speed * cd, cl,
    forceSettled: active.every(({ sample }) => sample.forceSettled),
    residualConverged: active.every(({ sample }) => sample.residualConverged),
  };
}

/** Kinematic bicycle estimate at the CG, NOT a tyre-dynamics or rotating-frame CFD solution.
 * Heading alone never generates yaw. Beta relates the body heading to the path velocity;
 * stationary world wind is then projected into the body's rear/right axes.
 * Wind bearing is the direction air travels: 0° north, 90° east.
 */
export function airConditions(speed: number, forward: { x: number; z: number }, signedCurvature: number, rearToCG: number, wind: Wind): AirConditions {
  const slipRad = Math.atan(rearToCG * signedCurvature);
  const psi = Math.atan2(-forward.x, -forward.z) - slipRad;
  const bx = -Math.sin(psi), bz = -Math.cos(psi);
  const rx = Math.cos(psi), rz = -Math.sin(psi);
  const bearing = wind.bearing * Math.PI / 180;
  const ax = wind.speed * Math.sin(bearing) - forward.x * speed;
  const az = -wind.speed * Math.cos(bearing) - forward.z * speed;
  const longitudinal = -ax * bx - az * bz, lateral = ax * rx + az * rz;
  return { speedKmh: longitudinal * 3.6, relativeSpeedKmh: Math.hypot(ax, az) * 3.6, yawDeg: Math.atan2(lateral, longitudinal) * 180 / Math.PI, slipRad, turnRate: speed * signedCurvature };
}
