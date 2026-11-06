/** Periodic shape-preserving cubic interpolation of the source's station/height profile.
 * Heights and vertical scale are retained; unlike straight ramps, grade is continuous at knots.
 */
export class ElevationProfile {
  readonly knots: number[][];
  readonly slopes: number[];
  constructor(samples: number[][], readonly length: number) {
    const points = samples.filter(p => p.length >= 2 && p.every(Number.isFinite) && p[0] >= 0 && p[0] < length).map(p => p.slice(0, 2));
    points.sort((a, b) => a[0] - b[0]);
    if (points[0]?.[0] !== 0) points.unshift([0, points[0]?.[1] ?? 0]);
    const n = points.length;
    this.slopes = points.map((p, i) => {
      const before = points[(i + n - 1) % n], after = points[(i + 1) % n];
      const h0 = i ? p[0] - before[0] : length - before[0];
      const h1 = i + 1 < n ? after[0] - p[0] : length - p[0];
      const d0 = (p[1] - before[1]) / h0, d1 = (after[1] - p[1]) / h1;
      if (d0 * d1 <= 0 || !Number.isFinite(d0 + d1)) return 0;
      const w0 = 2 * h1 + h0, w1 = h1 + 2 * h0;
      return (w0 + w1) / (w0 / d0 + w1 / d1);
    });
    this.knots = [...points, [length, points[0][1]]];
    this.slopes.push(this.slopes[0]);
  }
  at(distance: number) {
    const d = ((distance % this.length) + this.length) % this.length;
    let lo = 0, hi = this.knots.length - 1;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (this.knots[mid][0] <= d) lo = mid; else hi = mid; }
    const a = this.knots[lo], b = this.knots[lo + 1], h = b[0] - a[0], t = (d - a[0]) / h;
    return (2*t*t*t - 3*t*t + 1)*a[1] + (t*t*t - 2*t*t + t)*h*this.slopes[lo] + (-2*t*t*t + 3*t*t)*b[1] + (t*t*t - t*t)*h*this.slopes[lo + 1];
  }
}
