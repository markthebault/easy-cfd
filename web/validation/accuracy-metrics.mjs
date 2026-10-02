// Agreement is checked separately from whether the reference and candidate are qualified.
export const LIMIT = 100;
export const TOLERANCE = 0.03;
export const coefficientError = (value, reference) => Number.isFinite(value) && Number.isFinite(reference)
  ? Math.abs(value-reference)/Math.max(Math.abs(reference),0.01) : Infinity;

export function comparison(result, reference) {
  if (!reference || reference.settingsMatch === false) return { agrees: false, qualified: false, reason: "Missing or mismatched OpenFOAM reference" };
  const cdError = coefficientError(result.cd, reference.cd), clError = coefficientError(result.cl, reference.cl);
  const agrees = cdError <= TOLERANCE && clError <= TOLERANCE;
  const stable = result.settled && (result.cdBand ?? Infinity)/Math.max(Math.abs(result.cd),0.01) <= 0.01
    && (result.clBand ?? Infinity)/Math.max(Math.abs(result.cl),0.01) <= 0.01;
  const finite = result.diagnostics?.nonFinite === 0 && result.diagnostics?.clipped === 0;
  const conserved = (result.diagnostics?.relativeDivergence ?? Infinity) <= .001;
  const referenceReady = reference.forceSettled === true && reference.residualConverged === true && reference.meshIndependent === true;
  return { cdError, clError, agrees, stable, finite, conserved, referenceReady, qualified: agrees && stable && finite && conserved && referenceReady };
}
