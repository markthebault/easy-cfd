// Explicit approximate sealing through the existing local geometry tools.
import type { Part } from "../geometry/model";
import { parseSTL, writeSTL } from "../geometry/stl";
import { api, frameOffset, soupLow } from "./openfoam";

export interface PreparationReport {
  can_apply: boolean;
  message: string;
  source_components: number;
  result_components: number;
  pitch_mm: number;
  effective_gap_mm: number;
  original_to_result: { p95_mm: number; max_mm: number };
  result_to_original: { p95_mm: number; max_mm: number };
}
export interface PreparationPreview {
  bytes: ArrayBuffer;
  part: Part;
  report: PreparationReport;
}

export async function preparePreview(parts: Part[], name: string, pitch: number, gap: number): Promise<PreparationPreview> {
  const chosen = parts.filter(p => p.enabled);
  if (!chosen.length) throw new Error("Enable at least one body part.");
  const count = chosen.reduce((n, p) => n + p.positions.length, 0);
  if (count / 9 > 1_500_000) throw new Error("Prepare at most 1,500,000 triangles at once.");
  const soup = new Float32Array(count);
  let index = 0;
  for (const p of chosen) { soup.set(p.positions, index); index += p.positions.length; }
  const project = await api<{ id: string }>("/projects", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name:`${name} · preparation`.slice(0,100),sample:false}) });
  const form = new FormData();
  form.append("files", new Blob([writeSTL(soup)]), "exterior.stl");
  form.append("options", JSON.stringify({components:"group", units:"m", forward:"-X", up:"+Z", clearance:Math.min(2, Math.max(.005,soupLow(soup)[2]))}));
  const source = await api<{geometry:{parts:{id:string}[];bounds:[number[],number[]]}}>(`/projects/${project.id}/import`, {method:"POST",body:form});
  const {revision} = await api<{revision:string}>(`/projects/${project.id}/seal`);
  const preview = await api<{token:string;report:PreparationReport;geometry:{parts:{id:string}[]}}>(`/projects/${project.id}/seal/preview`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision,part_ids:source.geometry.parts.map(p=>p.id),pitch_mm:pitch,gap_mm:gap})});
  const bytes = await api<ArrayBuffer>(`/projects/${project.id}/seal-previews/${preview.token}/geometry/${preview.geometry.parts[0].id}.stl`);
  const positions = parseSTL(bytes);
  const offset = frameOffset(soupLow(soup), source.geometry.bounds[0] as [number,number,number]);
  for (let i=0;i<positions.length;i++) positions[i] -= offset[i%3];
  const part:Part = {id:"prepared",name:"Prepared exterior",file:"prepared.stl",positions,role:"body",wheel:null,enabled:true};
  return {bytes:writeSTL(positions),part,report:preview.report};
}
