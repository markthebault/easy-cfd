import { useEffect, useRef, useState } from "react";
import { preparePreview, type PreparationPreview } from "../engine/prepare";
import { app, applyPreparedModel } from "../store/app";
import type { Part } from "../geometry/model";

export function PrepareGeometry({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const original = useRef({ design: app.get().design!, parts: app.get().parts });
  const [pitch, setPitch] = useState(() => original.current.parts.reduce((n, p) => n + (p.enabled ? p.positions.length / 9 : 0), 0) > 500_000 ? 40 : 25);
  const [gap, setGap] = useState(100);
  const [preview, setPreview] = useState<PreparationPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showing, setShowing] = useState(false);
  const showParts = (parts: Part[]) => app.set(s => ({parts,partsVersion:s.partsVersion+1}));
  const restore = () => showParts(original.current.parts);
  useEffect(() => { dialog.current?.showModal(); return restore; }, []);
  const finish = () => { restore(); close(); };
  const build = async () => {
    restore(); setShowing(false); setPreview(null); setError(""); setBusy(true);
    try {
      const p = await preparePreview(original.current.parts, original.current.design.name, pitch, gap);
      setPreview(p); showParts([p.part]); setShowing(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <dialog ref={dialog} className="prepare-dialog glass" aria-labelledby="prepare-title" onCancel={e => {e.preventDefault(); if (!busy) finish();}}>
    <h2 id="prepare-title">Prepare for OpenFOAM</h2>
    <p>Make an approximate closed exterior from open or fragmented surfaces. Your original design stays saved. Wheels in this envelope are fixed.</p>
    <p className="small">This can close intentional gaps and change small details. Compare the preview with the original before making a copy.</p>
    <div className="row gap-m">
      <label>Resolution (mm)<input type="number" min="5" max="100" value={pitch} disabled={busy} onChange={e => {setPitch(Number(e.target.value));setPreview(null);restore();setShowing(false);}} /></label>
      <label>Close gaps up to (mm)<input type="number" min="0" max="200" value={gap} disabled={busy} onChange={e => {setGap(Number(e.target.value));setPreview(null);restore();setShowing(false);}} /></label>
    </div>
    <button className="btn secondary" disabled={busy || pitch < 5 || pitch > 100 || gap < 0 || gap > 200 || !Number.isFinite(pitch+gap)} onClick={build}>{busy ? "Preparing exterior…" : "Preview prepared model"}</button>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {preview && <>
      <p>{preview.report.message}</p>
      <p className="small">Resolution {preview.report.pitch_mm} mm · effective gap closure {preview.report.effective_gap_mm} mm after voxel rounding.</p>
      <p className="small">{preview.report.source_components} source pieces → {preview.report.result_components} closed exterior. Surface distance back to the original: 95% within {preview.report.result_to_original.p95_mm.toFixed(1)} mm; largest sampled distance {preview.report.result_to_original.max_mm.toFixed(1)} mm. Interior surfaces may be enclosed.</p>
      <div className="row gap-s"><button className="btn ghost sm" aria-pressed={!showing} onClick={() => {restore();setShowing(false);}}>Show original</button><button className="btn ghost sm" aria-pressed={showing} onClick={() => {showParts([preview.part]);setShowing(true);}}>Show prepared</button></div>
    </>}
    <div className="row gap-s"><button className="btn ghost" disabled={busy} onClick={finish}>Discard / close</button><button className="btn primary" disabled={busy || !preview?.report.can_apply} onClick={async () => {restore();const p=preview!;close();await applyPreparedModel(p,original.current.design.id);}}>Use prepared copy</button></div>
  </dialog>;
}
