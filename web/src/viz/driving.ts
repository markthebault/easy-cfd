import type { Settings } from "../solver/types";

export type DrivingConditions = Pick<Settings, "speed_kmh" | "yaw_deg" | "moving_ground" | "wheels">;

/** A common time scale keeps road travel, wind and tyre rotation consistent and readable. */
export const MOTION_TIME_SCALE = 0.05;
export function drivingVelocity(s: DrivingConditions): [number, number, number] {
  const speed = s.speed_kmh / 3.6;
  return [speed, speed * Math.tan(s.yaw_deg * Math.PI / 180), 0];
}
export function rollingAngle(distance: number, radius: number): number {
  // Nose points to -X. At the tyre's bottom, rotation about -Y moves the tread toward +X.
  return radius > 0 ? -distance / radius : 0;
}
