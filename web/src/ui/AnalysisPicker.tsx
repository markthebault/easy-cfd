import { Check, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { ANALYSES, type AnalysisMode } from "../viz/analysis";

function Thumbnail({ mode }: { mode: AnalysisMode }) {
  return <svg className={`analysis-thumb thumb-${mode}`} viewBox="0 0 100 58" fill="none" aria-hidden="true">
    {mode === "clouds" && <><ellipse cx="25" cy="32" rx="15" ry="17" fill="#fb886a" fillOpacity=".3" stroke="#fb886a" /><ellipse cx="65" cy="24" rx="25" ry="15" fill="#70acff" fillOpacity=".2" stroke="#70acff" /></>}
    {mode === "wake" && <path d="M58 24C73 13 93 17 96 26C83 29 96 45 73 43L54 38" fill="#71b9f5" fillOpacity=".25" stroke="#71b9f5" />}
    {mode === "turbulence" && <><path d="M6 9H95V46H6Z" fill="#ad92f9" fillOpacity=".14" /><ellipse cx="75" cy="31" rx="20" ry="11" fill="#ad92f9" fillOpacity=".5" /></>}
    {mode === "horizontal" ? <rect x="30" y="20" width="38" height="19" rx="7" className="thumb-car" /> : <path d="M22 36L26 29L39 27L46 20H62L71 29L80 32V39H22Z" className="thumb-car" />}
    {mode === "pressure" && <><path d="M26 29L39 27L46 20H62" stroke="#70acff" strokeWidth="4" /><path d="M22 36L26 29" stroke="#fb886a" strokeWidth="4" /></>}
    {mode === "vertical" && [0, 1, 2].map(i => <path key={i} d={`M5 ${15 + i * 8}C25 ${15 + i * 8} 30 ${5 + i * 6} 51 ${5 + i * 5}S75 ${17 + i * 8} 96 ${18 + i * 8}`} stroke="#6cc8df" strokeWidth="1.3" />)}
    {mode === "horizontal" && [-1, 1].map(i => <path key={i} d={`M5 29C24 29 21 ${29 + i * 24} 49 ${29 + i * 24}S75 29 96 29`} stroke="#6cc8df" strokeWidth="1.4" />)}
    {(mode === "surfaceFlow" || mode === "friction") && [0, 1, 2].map(i => <path key={i} d={`M${33 + i * 10} 31l7 -6l7 1`} stroke="#67d6be" strokeWidth="1.5" />)}
    {mode === "forces" && <><path d="M49 18H85M80 13L85 18L80 23" stroke="#ffaa63" strokeWidth="2" /><path d="M50 15V48M45 43L50 48L55 43" stroke="#64d8ca" strokeWidth="2" /></>}
    <path d="M8 47H92" stroke="currentColor" opacity=".18" />
  </svg>;
}

export function AnalysisPicker({ active, surface, friction, forces, onPick, onClose }: { active: AnalysisMode | null; surface: boolean; friction?: boolean; forces: boolean; onPick: (mode: AnalysisMode) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".analysis-card:not(:disabled)")?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div ref={ref} className="analysis-picker glass" role="region" aria-label="Choose an analysis view" id="analysis-picker">
    <div className="analysis-heading"><div><span className="eyebrow">ANALYSIS</span><h2>What do you want to see?</h2><p>Choose a view. We’ll position the camera and the flow for you.</p></div><button className="icon-btn" aria-label="Close analysis picker" onClick={onClose}><X size={17} /></button></div>
    <div className="analysis-grid">
      {ANALYSES.map(a => {
        const disabled = a.needsStress && !friction || a.needsSurface && !surface || a.needsForces && !forces;
        const reason = a.needsStress ? "Physical wall stress is unavailable in this run. Run it again with the updated solver." : a.needsForces ? "Available when the run finishes." : "Surface samples are not available for this run.";
        return <button key={a.id} className={`analysis-card ${active === a.id ? "selected" : ""}`} aria-pressed={active === a.id} disabled={!!disabled} onClick={() => onPick(a.id)} data-testid={`analysis-${a.id}`} title={disabled ? reason : a.description}>
          <Thumbnail mode={a.id} /><span className="analysis-copy"><b>{a.title}</b><span>{disabled ? reason : a.description}</span></span>{active === a.id && <Check size={14} className="analysis-check" />}
        </button>;
      })}
    </div>
    <details className="analysis-availability"><summary>About surface fields and noise</summary><p>Surface flow shows direction near the wall. Friction colours use physical wall stress where saved; grey means missing data. Surface fields are final snapshots, while forces are time averages. Noise needs an acoustic calculation; turbulent energy is not a sound level.</p></details>
  </div>;
}
