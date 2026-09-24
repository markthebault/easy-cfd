// Bounds are measured from actual surface vertices, not rotated bounding-box corners.
export function rotatedBounds(arrays: ArrayLike<number>[], degrees: number[]) {
  const [x, y, z] = degrees.map((v) => ((v % 360) * Math.PI) / 180);
  const [a, b, c, d, e, f] = [
    Math.cos(x),
    Math.sin(x),
    Math.cos(y),
    Math.sin(y),
    Math.cos(z),
    Math.sin(z),
  ];
  const r = [
    e * c,
    e * d * b - f * a,
    e * d * a + f * b,
    f * c,
    f * d * b + e * a,
    f * d * a - e * b,
    -d,
    c * b,
    c * a,
  ];
  const low = [Infinity, Infinity, Infinity],
    high = [-Infinity, -Infinity, -Infinity];
  for (const points of arrays)
    for (let i = 0; i < points.length; i += 3)
      for (let j = 0; j < 3; j++) {
        low[j] = Math.min(low[j], points[i + j]);
        high[j] = Math.max(high[j], points[i + j]);
      }
  const center = low.map((v, i) => (v + high[i]) / 2);
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const points of arrays)
    for (let i = 0; i < points.length; i += 3) {
      const x = points[i] - center[0],
        y = points[i + 1] - center[1],
        z = points[i + 2] - center[2];
      for (let j = 0; j < 3; j++) {
        const v = r[j * 3] * x + r[j * 3 + 1] * y + r[j * 3 + 2] * z;
        min[j] = Math.min(min[j], v);
        max[j] = Math.max(max[j], v);
      }
    }
  return {
    r,
    center,
    min,
    max,
    low,
    dimensions: max.map((v, i) => v - min[i]),
  };
}
export function transformMatrix(
  bounds: ReturnType<typeof rotatedBounds>,
  scale: number,
  translation: number[],
  keepClearance: boolean,
) {
  const { r, center, min, low } = bounds;
  const lift = keepClearance ? low[2] - (center[2] + min[2] * scale) : 0;
  const t = center.map(
    (v, i) =>
      v -
      scale *
        (r[i * 3] * center[0] +
          r[i * 3 + 1] * center[1] +
          r[i * 3 + 2] * center[2]) +
      translation[i] +
      (i === 2 ? lift : 0),
  );
  return [
    r[0] * scale,
    r[3] * scale,
    r[6] * scale,
    0,
    r[1] * scale,
    r[4] * scale,
    r[7] * scale,
    0,
    r[2] * scale,
    r[5] * scale,
    r[8] * scale,
    0,
    ...t,
    1,
  ];
}
