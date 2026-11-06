import type { Wind } from './aeroMap';

export type Setup = { brake: number; grip: number; mass: number; power: number };
export const initial: Setup = { brake: 1.1, grip: 1.1, mass: 1150, power: 118 };
export interface TrackPreferences { setup: Setup; circuit: string; wind: Wind; elevation: boolean }
export const initialPreferences: TrackPreferences = { setup: initial, circuit: 'barcelona', wind: { speed: 0, bearing: 0 }, elevation: false };
