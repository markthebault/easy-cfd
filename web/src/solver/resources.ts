/** Conservative planning limits, including CPU preparation, GPU buffers and readbacks. */
export const QUICK_CELLS = 2_500_000;
export const QUICK_BYTES = 3 * 1024 ** 3;
export function resourcePlan(
  cells: number,
  ghostedCells: number,
  geometryBytes: number,
) {
  return {
    cells,
    bytes: ghostedCells * 640 + geometryBytes * 6 + 128 * 1024 ** 2,
    largestBuffer: ghostedCells * 20,
  };
}
export function preflight(
  cells: number,
  ghostedCells: number,
  geometryBytes: number,
  bufferLimit = Infinity,
) {
  const p = resourcePlan(cells, ghostedCells, geometryBytes);
  if (cells > QUICK_CELLS || p.bytes > QUICK_BYTES)
    throw new Error(
      `This grid needs ${cells.toLocaleString()} cells and an estimated ${(p.bytes / 1024 ** 3).toFixed(2)} GiB peak memory. Quick runs are limited to 2.5 M cells / 3 GiB. Reduce cells or detail refinement.`,
    );
  if (p.largestBuffer > bufferLimit)
    throw new Error(
      `A solver buffer needs ${p.largestBuffer.toLocaleString()} bytes, above this GPU's ${bufferLimit.toLocaleString()} byte limit. Reduce the grid before running.`,
    );
  return p;
}
