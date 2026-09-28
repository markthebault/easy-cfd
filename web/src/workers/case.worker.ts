// Off-main-thread CPU work for one simulation: grid preparation (voxelisation, multigrid set-up)
// and turning GPU fields into visualisation data. The worker keeps a light copy of the case so
// live snapshots can be resampled without sending the grid back and forth.

import { extractViz, makeSampler, sampleSurface, type SurfaceSample } from "../solver/extract";
import type { FlowFields } from "../solver/gpu";
import { prepareCase, type CaseSetup } from "../solver/setup";
import type { Settings, SolverPart } from "../solver/types";

export type CaseRequest =
  | { type: "prepare"; id: number; parts: SolverPart[]; settings: Settings }
  | { type: "extract"; id: number; fields: FlowFields; target: number; surface: boolean; caseKey: number };

export type CaseResponse =
  | { type: "prepared"; id: number; setup: CaseSetup }
  | { type: "extracted"; id: number; field: ReturnType<typeof extractViz>; surface: SurfaceSample[] | null }
  | { type: "error"; id: number; message: string };

// One light case per prepared grid: a Precise run prepares two and extracts from both.
const lites = new Map<number, CaseSetup>();
let nextKey = 1;
let parts: SolverPart[] = [];

function buffersOf(value: unknown, out: Set<ArrayBuffer>) {
  if (ArrayBuffer.isView(value)) out.add(value.buffer as ArrayBuffer);
  else if (Array.isArray(value)) for (const v of value) buffersOf(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) buffersOf(v, out);
}

const post = (msg: CaseResponse, transfer: ArrayBuffer[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (e: MessageEvent<CaseRequest>) => {
  const msg = e.data;
  try {
    if (msg.type === "prepare") {
      parts = msg.parts;
      const setup = prepareCase(parts, msg.settings);
      setup.caseKey = nextKey++;
      // Only what extraction reads; everything else is transferred to the main thread.
      const lite = {
        grid: structuredClone(setup.grid), NX: setup.NX, NY: setup.NY, NZ: setup.NZ, NC: setup.NC, flags: setup.flags.slice(),
        domain: setup.domain, low: setup.low, high: setup.high, length: setup.length, freestream: setup.freestream, inlet: setup.inlet,
      } as CaseSetup;
      lites.set(setup.caseKey, lite);
      const transfer = new Set<ArrayBuffer>();
      buffersOf(setup, transfer);
      post({ type: "prepared", id: msg.id, setup }, [...transfer]);
    } else if (msg.type === "extract") {
      const lite = lites.get(msg.caseKey);
      if (!lite) throw new Error("Case not prepared.");
      if (msg.fields.pres.length !== lite.NC) throw new Error("The flow fields do not belong to this grid.");
      const field = extractViz(lite, msg.fields, msg.target);
      let surface: SurfaceSample[] | null = null;
      if (msg.surface) {
        const sampler = makeSampler(lite, msg.fields);
        surface = parts.map((p) => sampleSurface(lite, sampler, p.positions));
      }
      const transfer = new Set<ArrayBuffer>();
      buffersOf(field, transfer);
      buffersOf(surface, transfer);
      post({ type: "extracted", id: msg.id, field, surface }, [...transfer]);
    }
  } catch (err) {
    post({ type: "error", id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
