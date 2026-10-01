import * as THREE from "three";
import type { VizField } from "../solver/extract";
import { surfaceNets } from "./wake";

/** Static pressure coefficient. Missing fluid and car samples cannot form an iso-surface. */
export function pressureCoefficients(f: VizField): Float32Array {
  const q = 0.5 * f.freestream ** 2;
  return Float32Array.from(f.p, (p, i) => f.solid[i] || q <= 0 ? NaN : p / q);
}

export function pressureCloudGeometry(f: VizField, cp: Float32Array, level: number): THREE.BufferGeometry {
  const { positions, index } = surfaceNets(f, cp, level);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export function pressureCloudMaterial(positive: boolean): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color: positive ? 0xf7795b : 0x529dff,
    shininess: 60, transparent: true, opacity: 0.32,
    side: THREE.DoubleSide, depthWrite: false,
  });
}
