import { detectedAxles } from "../solver/aero";
import { resultAtAxles } from "../solver/axleAnalysis";
import type { Part } from "../geometry/model";
import type { RunDoc } from "./types";
import { toSolverParts } from "./geometry";
import { estimateTyreLoads } from "../solver/tyreLoads";

export function detectRunAxles(doc: RunDoc, parts: Part[]): RunDoc {
  if (doc.axleLoadAssessment || doc.result.balance || !doc.result.aero || doc.settings.axles) return doc;
  const axles = detectedAxles(toSolverParts(parts));
  if (!axles) return doc;
  const next: RunDoc = {...doc, axleLoadAssessment: {version:"wheel-axles-1",axles}};
  if (next.tyreLoadAssessment) next.tyreLoadAssessment = {...next.tyreLoadAssessment,
    loads:estimateTyreLoads(assessedResult(next).balance, next.tyreLoadAssessment.inputs)};
  return next;
}
export const assessedAxles = (doc: RunDoc) => doc.axleLoadAssessment?.axles ?? doc.settings.axles;
export const assessedResult = (doc: RunDoc) => resultAtAxles(doc.result, assessedAxles(doc), doc.settings.reference_area);
