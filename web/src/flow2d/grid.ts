export type TunnelId = "small" | "medium" | "large" | "legacy";
export type Grid = { id: TunnelId; label: string; width: number; height: number; nx: number; ny: number };
// Endpoint spacing is identical in x/y: D2Q9 requires square lattice cells.
export const TUNNELS: Record<TunnelId, Grid> = {
  small: { id: "small", label: "Small", width: 3, height: 2, nx: 601, ny: 401 },
  medium: { id: "medium", label: "Medium", width: 7, height: 3, nx: 701, ny: 301 },
  large: { id: "large", label: "Large", width: 20, height: 7, nx: 801, ny: 281 },
  legacy: { id: "legacy", label: "Previous", width: 4.2, height: 1.2, nx: 672, ny: 192 },
};
export const LEGACY_GRID = TUNNELS.legacy;
export const isTunnel = (value: unknown): value is TunnelId => typeof value === "string" && Object.hasOwn(TUNNELS, value);
export const cellSize = (grid: Grid) => grid.width / (grid.nx - 1);
// Preserve the same illustrative molecular viscosity when cell spacing changes.
export const liveTau = (grid: Grid) => .5 + .006 * cellSize(LEGACY_GRID) / cellSize(grid);
