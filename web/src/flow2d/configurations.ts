import { sceneError, type Scene } from "./scene";
import type { ForceReport } from "./metrics";

export type Configuration = { id: string; name: string; savedAt: string; scene: Scene; report: ForceReport };
export const CONFIGURATION_KEY = "easycfd.flow2d.configurations.v1";
export const MAX_CONFIGURATIONS = 12;
function validConfiguration(value: unknown): value is Configuration {
  try {
    const c = value as Configuration;
    return !!c && typeof c.id === "string" && typeof c.name === "string" && c.name.trim().length > 0 && c.name.length <= 80 && typeof c.savedAt === "string" && Array.isArray(c.scene?.shapes) && !sceneError(c.scene) && typeof c.report?.key === "string" && typeof c.report.signature === "string" && c.report.cd !== null && c.report.cl !== null && Number.isFinite(c.report.cd) && Number.isFinite(c.report.cl) && Number.isFinite(c.report.averagingTravel) && c.report.averagingTravel > 0 && ["sampling", "settling", "ready"].includes(c.report.status);
  } catch { return false; }
}
export function restoreConfigurations(): Configuration[] {
  try {
    const value = JSON.parse(localStorage.getItem(CONFIGURATION_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(validConfiguration).slice(0, MAX_CONFIGURATIONS);
  } catch { return []; }
}
export function persistConfigurations(configurations: Configuration[]) {
  try { localStorage.setItem(CONFIGURATION_KEY, JSON.stringify(configurations)); } catch { /* Optional browser storage. */ }
}
