// Promise wrapper around case.worker.ts.

import type { SurfaceSample, VizField } from "../solver/extract";
import type { FlowFields } from "../solver/gpu";
import type { CaseSetup } from "../solver/setup";
import type { Settings, SolverPart } from "../solver/types";
import type { CaseRequest, CaseResponse } from "./case.worker";

type Pending = { resolve: (v: CaseResponse) => void; reject: (e: Error) => void };

// Distributive Omit so each request variant keeps its own fields.
type Req = CaseRequest extends infer R ? (R extends CaseRequest ? Omit<R, "id"> : never) : never;

export class CaseWorker {
  private worker = new Worker(new URL("./case.worker.ts", import.meta.url), { type: "module" });
  private pending = new Map<number, Pending>();
  private next = 1;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<CaseResponse>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.type === "error") p.reject(new Error(e.data.message));
      else p.resolve(e.data);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "The preparation worker failed."));
      this.pending.clear();
    };
  }

  private call(req: Req, transfer: Transferable[] = []): Promise<CaseResponse> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id }, transfer);
    });
  }

  /** Part arrays are copied (not transferred): the main thread keeps drawing them. */
  async prepare(parts: SolverPart[], settings: Settings): Promise<CaseSetup> {
    const r = await this.call({ type: "prepare", parts, settings });
    if (r.type !== "prepared") throw new Error("Unexpected worker reply.");
    return r.setup;
  }

  /** Fields are transferred; the caller must not use them afterwards. */
  /** `setup` is the grid the fields were computed on (from this worker's prepare()). */
  async extract(fields: FlowFields, setup: CaseSetup, target: number, surface: boolean): Promise<{ field: VizField; surface: SurfaceSample[] | null }> {
    if (setup.caseKey === undefined) throw new Error("That grid was not prepared by this worker.");
    const r = await this.call({ type: "extract", fields, target, surface, caseKey: setup.caseKey }, [fields.vel.buffer, fields.pres.buffer, fields.turb.buffer]);
    if (r.type !== "extracted") throw new Error("Unexpected worker reply.");
    return { field: r.field, surface: r.surface };
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new DOMException("Worker stopped", "AbortError"));
    this.pending.clear();
  }
}
