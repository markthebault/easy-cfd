import * as T from 'three';

export const ROAD_HEIGHT = 0.04;
const WORLD_UP = new T.Vector3(0, 1, 0);

/** One continuous, closed path shared by road, tire contact and the animated car pose. */
export class TrackPath {
  readonly curve: T.CatmullRomCurve3;
  readonly distances: number[] = [0];
  readonly length: number;
  constructor(readonly points: T.Vector3[]) {
    this.curve = new T.CatmullRomCurve3(points, true, 'centripetal');
    for (let i = 0; i < points.length; i++) this.distances.push(this.distances[i] + points[i].distanceTo(points[(i + 1) % points.length]));
    this.length = this.distances.at(-1)!;
  }
  atDistance(distance: number) {
    const d = T.MathUtils.euclideanModulo(distance, this.length);
    let lo = 0, hi = this.points.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (this.distances[mid] <= d) lo = mid; else hi = mid; }
    const fraction = (d - this.distances[lo]) / (this.distances[lo + 1] - this.distances[lo]);
    return this.at((lo + fraction) / this.points.length);
  }
  at(t: number) {
    const u = T.MathUtils.euclideanModulo(t, 1);
    const position = this.curve.getPoint(u);
    const forward = this.curve.getTangent(u).normalize();
    const right = new T.Vector3().crossVectors(forward, WORLD_UP).normalize();
    const up = new T.Vector3().crossVectors(right, forward).normalize();
    return { position, forward, right, up };
  }
  pose(distance: number, wheelbase: number, tireBottom: number) {
    const center = this.atDistance(distance);
    const front = this.atDistance(distance + wheelbase / 2).position;
    const rear = this.atDistance(distance - wheelbase / 2).position;
    const forward = front.clone().sub(rear).normalize();
    const right = new T.Vector3().crossVectors(forward, WORLD_UP).normalize();
    const up = new T.Vector3().crossVectors(right, forward).normalize();
    const roadCenter = front.add(rear).multiplyScalar(.5);
    // The road surface is raised above the trace. The exact solved tire minima touch that surface.
    const position = center.position.clone();
    position.y = roadCenter.y;
    position.addScaledVector(up, ROAD_HEIGHT - tireBottom);
    const quaternion = new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(right, up, forward.clone().negate()));
    return { position, quaternion, forward, up };
  }
}
