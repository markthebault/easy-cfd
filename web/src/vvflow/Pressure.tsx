import { useEffect, useRef } from 'react';
import type { PressureField } from './types';
// Fixed Cp scale: pressure difference divided by 0.5*rho*U_inf^2.
// Display clipping does not change the sampled solver values.
const low = [41, 104, 220], high = [238, 72, 43];
export function Pressure({ field, view, light }: { field: PressureField | null; view: number[]; light: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current!, bounds = target.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
    target.width = Math.round(bounds.width * dpr);target.height = Math.round(bounds.height * dpr);
    const ctx = target.getContext('2d')!;ctx.clearRect(0, 0, target.width, target.height);
    if (!field) return;
    const neutral = light ? [242, 243, 244] : [22, 26, 32];
    const { values, nx, ny, xmin, ymin, spacing } = field, image = new ImageData(nx, ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const value = values[y * nx + x], i = ((ny - y - 1) * nx + x) * 4;
      if (!Number.isFinite(value)) continue;
      const fraction = Math.min(1, Math.abs(value) / 2.5), color = value < 0 ? low : high;
      for (let c = 0; c < 3; c++) image.data[i + c] = neutral[c] + fraction * (color[c] - neutral[c]);
      image.data[i + 3] = 235;
    }
    const offscreen = document.createElement('canvas');offscreen.width = nx;offscreen.height = ny;offscreen.getContext('2d')!.putImageData(image, 0, 0);
    // Samples are at cell centres, so include a half-spacing edge around them.
    const left = (xmin - spacing / 2 - view[0]) / view[2] * target.width;
    const top = (view[1] + view[3] - (ymin + (ny - .5) * spacing)) / view[3] * target.height;
    ctx.imageSmoothingEnabled = true;ctx.drawImage(offscreen, left, top, nx * spacing / view[2] * target.width, ny * spacing / view[3] * target.height);
  }, [field, view, light]);
  return <canvas className="vv-pressure" ref={canvas} aria-label="Computed static pressure coefficient" data-time={field?.time} />;
}
