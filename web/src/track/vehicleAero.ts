import type { AeroLoads, AirConditions, MapManifest } from './aeroMap';
import { mapLoads, mapWeights } from './aeroMap';
import type { CfdData } from './cfd';

export interface VehicleAero {
  map?: MapManifest;
  cl: number; cd: number; density: number; referenceArea: number; wheelbase: number;
  forceSettled: boolean; residualConverged: boolean;
}

export function vehicleAero(data: CfdData): VehicleAero {
  const { settings, result } = data.manifest;
  const axles = data.parts.flatMap(p => p.info.wheel ? [p.info.wheel.center[0]] : []);
  const wheelbase = axles.length > 1 ? Math.max(...axles) - Math.min(...axles) : 2.33;
  return { map: data.map?.manifest, cl: result.cl, cd: result.cd, density: settings.density,
    referenceArea: settings.reference_area, wheelbase: wheelbase > .5 ? wheelbase : 2.33,
    forceSettled: result.forceSettled, residualConverged: result.residualConverged };
}

/** Quasi-steady force for the lap model. A map uses boundary coefficients outside coverage;
 * a single wind-tunnel run holds its coefficients constant and only scales dynamic pressure.
 * Neither path creates new CFD flow fields or new yaw solutions.
 */
export function vehicleLoads(model: VehicleAero, air: Pick<AirConditions, 'speedKmh' | 'relativeSpeedKmh' | 'yawDeg'>): AeroLoads & { covered: boolean } {
  if (model.map) {
    const blend = mapWeights(model.map, air.speedKmh, air.yawDeg);
    const boundary = mapLoads(model.map, { ...blend, covered: true });
    if (!boundary) throw new Error('This CFD map has no compatible force coefficients.');
    const referenceSpeed = blend.speedKmh / Math.cos(blend.yawDeg * Math.PI / 180);
    const scale = (air.relativeSpeedKmh / referenceSpeed) ** 2;
    return { ...boundary, netLiftN: boundary.netLiftN * scale, liftN: boundary.liftN * scale,
      downforceN: boundary.downforceN * scale, dragN: boundary.dragN * scale, covered: blend.covered };
  }
  const qArea = .5 * model.density * model.referenceArea * (air.relativeSpeedKmh / 3.6) ** 2;
  const netLiftN = qArea * model.cl;
  return { netLiftN, liftN: Math.max(0, netLiftN), downforceN: Math.max(0, -netLiftN), dragN: qArea * model.cd,
    cl: model.cl, covered: true, forceSettled: model.forceSettled, residualConverged: model.residualConverged };
}

/** The user's base grip/braking inputs are measured at 100 km/h on the base car. */
export function gripCalibration(model: VehicleAero | null, mass: number) {
  const weight = mass * 9.81;
  const lift = model ? vehicleLoads(model, { speedKmh: 100, relativeSpeedKmh: 100, yawDeg: 0 }).netLiftN : 0;
  return weight / Math.max(weight * .01, weight - lift);
}

export function lateralCapacity(gripG: number, mass: number, calibration: number, netLiftN: number) {
  return gripG * calibration * Math.max(0, mass * 9.81 - netLiftN);
}
