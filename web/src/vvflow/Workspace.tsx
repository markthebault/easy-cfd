import { useEffect, useRef, useState } from 'react';
import type { Case, Frame, Message } from './types';
import { Particles } from './particles';
import './vvflow.css';
const initial: Case = new URLSearchParams(location.search).get('profile') === 'mx5-nc'
  ? { shape: 3, panels: 240, re: 40000, dt: .005, angle: 0 }
  : { shape: 0, panels: 120, re: 600, dt: .02, angle: 0 };
const names = ['Cylinder', 'NACA 0012', 'Deploying spoiler', 'MX-5 NC'];
type Sample = { t: number; cx: number; cy: number; cm: number };
function History({ samples }: { samples: Sample[] }) {
  const recent = samples.filter(s => s.t > .2).slice(-600), end = recent.at(-1)?.t || 1, start = recent[0]?.t || 0;
  const bound = Math.max(1, ...recent.flatMap(s => [Math.abs(s.cx), Math.abs(s.cy)]));
  const path = (key: 'cx' | 'cy') => recent.map((s, i) => `${i ? 'L' : 'M'}${20 + (s.t - start) / Math.max(.1, end - start) * 940},${49 - s[key] / bound * 34}`).join(' ');
  return <div className="vv-history"><div><span>Instantaneous section forces</span><span><i className="vv-red" /> Cx <i className="vv-blue" /> Cy</span></div><svg viewBox="0 0 980 100" preserveAspectRatio="none" aria-label="Force history"><path d="M20 49 H960" stroke="currentColor" opacity=".16" /><path d={path('cx')} fill="none" stroke="#fa7569" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /><path d={path('cy')} fill="none" stroke="#66aaff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /><text x="20" y="96">{start.toFixed(1)}</text><text x="910" y="96">{end.toFixed(1)} t*</text></svg></div>;
}
export function VVWorkspace() {
  const [config, setConfig] = useState<Case>(initial), [active, setActive] = useState<Case>(initial);
  const [version, setVersion] = useState(0), [frame, setFrame] = useState<Frame | null>(null);
  const [status, setStatus] = useState('Loading solver'), [ready, setReady] = useState(false), [running, setRunning] = useState(false), [error, setError] = useState('');
  const [pointSize, setPointSize] = useState(1.3), [wide, setWide] = useState(false), [light, setLight] = useState(false);
  const [view, setView] = useState([-1.4, -2, 8, 4]), [samples, setSamples] = useState<Sample[]>([]);
  const [ms, setMs] = useState(0);
  const worker = useRef<Worker | null>(null), canvas = useRef<HTMLCanvasElement>(null), stage = useRef<HTMLDivElement>(null), renderer = useRef<Particles | null>(null);
  const previous = useRef({ steps: 0, ms: 0 }), drag = useRef<{ x: number; y: number; view: number[] } | null>(null);
  const fit = (shape: number, far = wide) => {
    const bounds = stage.current?.getBoundingClientRect(), aspect = bounds ? bounds.width / bounds.height : 2;
    const width = far ? (shape === 0 ? 20 : 9) : (shape === 0 ? 8 : 3.4), height = width / aspect;
    setView([shape === 0 ? -1.4 : -.4, (shape === 3 ? .13 : 0) - height / 2, width, height]);
  };
  useEffect(() => {
    setReady(false); setRunning(false); setFrame(null); setSamples([]); setError(''); setStatus('Loading solver');previous.current = { steps: 0, ms: 0 };setMs(0);
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }); worker.current = w;
    const fail = (message: string) => { setError(message); setStatus('Stopped'); setRunning(false); setReady(false); };
    w.onerror = e => fail(e.message || 'Worker failed to start');
    w.onmessage = (event: MessageEvent<Message>) => {
      const m = event.data;
      if (m.type === 'error') fail(m.error);
      else if (m.type === 'ready') { setReady(true); setStatus('Ready'); }
      else if (m.type === 'frame') {
        setFrame(m); setRunning(m.running);setStatus(m.running ? 'Computing locally' : m.stats[0] >= 40 ? 'Preview complete' : 'Paused');
        if (m.stats[5] > previous.current.steps) {
          const steps = m.stats[5] - previous.current.steps;
          setMs(m.elapsed / steps);previous.current = { steps: m.stats[5], ms: m.elapsed };
          setSamples(s => [...s, { t: m.stats[9], cx: m.stats[1], cy: m.stats[2], cm: m.stats[3] }]);
        }
      }
    };
    w.postMessage({ type: 'init', config: active });
    fit(active.shape);
    return () => { w.terminate(); worker.current = null; };
  // Each apply creates a fresh isolated solver; old workers are terminated.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, version]);
  useEffect(() => {
    try { renderer.current = new Particles(canvas.current!); } catch (e) { setError(String(e)); }
    return () => { renderer.current?.dispose(); renderer.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { const observer = new ResizeObserver(() => fit(active.shape)); observer.observe(stage.current!);return () => observer.disconnect(); }, [active.shape, wide]);
  useEffect(() => { if (frame) renderer.current?.draw(frame.particles, view, pointSize); }, [frame, view, pointSize]);
  const apply = () => { setActive({ ...config }); setVersion(v => v + 1); };
  const command = (type: string) => { if (type === 'run') setRunning(true); worker.current?.postMessage({ type }); };
  const choose = (shape: number) => { const c = { ...config, shape, re: shape === 0 ? 600 : 40000, panels: shape === 0 ? 120 : 240, dt: shape === 0 ? .02 : .005, angle: shape === 0 || shape === 3 ? 0 : 5 };setConfig(c);setActive(c); };
  const changed = JSON.stringify(config) !== JSON.stringify(active), stats = frame?.stats || Array(10).fill(0);
  const exportCSV = () => {
    const csv = 't_star,Cx,Cy,Cm_origin\n' + samples.map(s => `${s.t},${s.cx},${s.cy},${s.cm}`).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), a = document.createElement('a'); a.href = url;a.download = `vvflow-${active.shape}-${active.re}.csv`;a.click();setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const contours: { id: number; points: string }[] = [];
  if (frame) for (let i = 0; i < frame.bodies.length; i += 3) { const id = frame.bodies[i + 2];if (contours.at(-1)?.id !== id) contours.push({ id, points: '' });contours.at(-1)!.points += `${frame.bodies[i]},${-frame.bodies[i + 1]} `; }
  return <div className={`vv-app ${light ? 'vv-light' : ''}`}>
    <header className="vv-header"><a href="/?workspace=2d" title="Return to current 2D solver">EasyCFD <span>/ 2D lab</span></a><span className="vv-badge">vvflow · browser experiment</span><a className="vv-original" href="/?workspace=2d">Current solver ↗</a></header>
    <div className="vv-layout"><aside className="vv-sidebar"><h1>Follow the wake.</h1><p>A vortex solver, running on your device.</p>
      <label className="vv-label">Case</label><div className="vv-cases">{names.map((name, shape) => <button key={name} aria-label={name} className={config.shape === shape ? 'selected' : ''} onClick={() => choose(shape)}>{name}<span>↗</span></button>)}</div>
      <div className="vv-settings"><label>Reynolds number<input aria-label="Reynolds number" type="number" min="20" max="100000" step="100" value={config.re} onChange={e => setConfig(c => ({ ...c, re: +e.target.value }))} /></label><label>Surface segments<select aria-label="Surface segments" value={config.panels} onChange={e => setConfig(c => ({ ...c, panels: +e.target.value }))}>{[80, 120, 180, 240, 320].map(n => <option key={n}>{n}</option>)}</select></label><label>Timestep<select aria-label="Timestep" value={config.dt} onChange={e => setConfig(c => ({ ...c, dt: +e.target.value }))}>{[.005, .01, .02, .04].map(n => <option key={n}>{n}</option>)}</select></label>{(config.shape === 1 || config.shape === 2) && <label>Angle of attack<input aria-label="Angle of attack" type="number" min="-20" max="20" step="1" value={config.angle} onChange={e => setConfig(c => ({ ...c, angle: +e.target.value }))} /></label>}</div>
      {changed && <button className="vv-apply" onClick={apply}>Apply & reset</button>}
      <div className="vv-actions"><button className="vv-primary" disabled={!ready || changed || stats[0] >= 40} onClick={() => command(running ? 'pause' : 'run')}>{running ? 'Pause' : 'Run flow'}</button><button onClick={apply} title="Reset simulation">Reset</button><button disabled={!ready || running || changed || stats[0] >= 40} onClick={() => command('step')} title="Advance one solver step">Step</button></div>
      <div className="vv-appearance"><label className="vv-label" htmlFor="vv-points">Particle size</label><input id="vv-points" type="range" min=".5" max="2" step=".1" value={pointSize} onChange={e => setPointSize(+e.target.value)} /><div><button onClick={() => { setWide(!wide);fit(active.shape, !wide); }}>{wide ? 'Near view' : 'Full wake'}</button><button onClick={() => setLight(!light)}>{light ? 'Dark' : 'Light'}</button></div></div>
      <p className="vv-case-note">{active.shape === 3 ? 'The same MX-5 NC PRHT outline as the 2D editor, scaled to a 4 m length. Free-air flow; no ground boundary is modelled.' : active.shape === 2 ? 'The spoiler opens at t*=5–7, then retracts at 15–17. A separate plate with a small gap; this is not an exact recreation of the video.' : 'An impulsive start in unbounded 2D flow. Allow the initial transient to pass before interpreting the wake.'}</p>
      <a className="vv-source" href="/vvflow/NOTICE.txt" target="_blank" rel="noreferrer">Solver sources & licences ↗</a>
    </aside><main className="vv-main"><div className="vv-status"><span><i className={running ? 'live' : ''} />{status}</span><span>{Math.round(stats[4]).toLocaleString()} vortices <b>·</b> {ms.toFixed(1)} ms / step</span></div>
      {error && <div className="vv-error" role="alert">{error}<button onClick={apply}>Reset solver</button></div>}
      <div className="vv-stage" ref={stage} onPointerDown={e => { drag.current = { x: e.clientX, y: e.clientY, view: [...view] };e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (!drag.current) return;const r = e.currentTarget.getBoundingClientRect(), d = drag.current;setView([d.view[0] - (e.clientX - d.x) / r.width * d.view[2], d.view[1] + (e.clientY - d.y) / r.height * d.view[3], d.view[2], d.view[3]]); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onWheel={e => { const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12, r = e.currentTarget.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = 1 - (e.clientY - r.top) / r.height;setView(v => { const width = Math.max(.25, Math.min(80, v[2] * factor)), height = width * v[3] / v[2];return [v[0] + x * (v[2] - width), v[1] + y * (v[3] - height), width, height]; }); }}>
        <canvas ref={canvas} aria-label="Computed vortex particles" /><svg className="vv-geometry" viewBox={`${view[0]} ${-view[1] - view[3]} ${view[2]} ${view[3]}`} preserveAspectRatio="none">{contours.map(c => <polygon key={c.id} points={c.points} />)}</svg>
        <div className="vv-flow-direction">FLOW →</div><div className="vv-time">t* <strong>{stats[0].toFixed(2)}</strong></div><div className="vv-stage-help">Drag to pan · scroll to zoom <button onClick={() => fit(active.shape)}>Fit</button></div>
        <div className="vv-key"><span><i className="vv-red" /> Counterclockwise</span><span><i className="vv-blue" /> Clockwise</span></div>
      </div>
      <div className="vv-results"><div><span>Cx</span><strong>{stats[1].toFixed(3)}</strong></div><div><span>Cy</span><strong>{stats[2].toFixed(3)}</strong></div>{active.shape === 2 && <div><span>Spoiler angle</span><strong>{(stats[6] * 180 / Math.PI).toFixed(1)}°</strong></div>}<button disabled={!samples.length} onClick={exportCSV}>Export CSV ↓</button></div>
      <History samples={samples} />
      <footer>Experimental 2D results · U=1, reference length=1{active.shape === 3 ? " (car length)" : ""} · no validated accuracy claim · preview ends at t*=40</footer>
    </main></div>
  </div>;
}
