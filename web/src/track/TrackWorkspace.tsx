import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { WorkspaceMenu } from '../ui/Chrome';
import { cssGradient } from '../viz/colormap';
import { solve, trackPoints } from './physics';
import { cfdFromRun, loadCfd, type CfdData } from './cfd';
import { TrackStage, type TrackState, type Telemetry } from './TrackStage';
import type { FlowMode } from './CfdCar';
import { terrainInput } from './terrain';
import type { LoadedRun } from '../store/types';
import { app } from '../store/app';
import { vehicleAero } from './vehicleAero';
import type { Setup, TrackPreferences } from './settings';
import type { Wind } from './aeroMap';
import './track.css';

const fmt = (v: number) => `${Math.floor(v / 60)}:${(v % 60).toFixed(2).padStart(5, '0')}`;

export default function TrackWorkspace({ onWorkspaceChange, vehicleRun, baseRun, onBaseChange, onVehicleChange, preferences, setPreferences }: {
  onWorkspaceChange: (mode: '2d' | '3d' | 'track') => void;
  vehicleRun: LoadedRun | null; baseRun: LoadedRun | null;
  onBaseChange: (run: LoadedRun | null) => void; onVehicleChange: (run: LoadedRun | null) => void;
  preferences: TrackPreferences; setPreferences: Dispatch<SetStateAction<TrackPreferences>>;
}) {
  const { circuit: track, elevation, setup, wind } = preferences;
  const setTrack = (circuit: string) => setPreferences(p => ({ ...p, circuit }));
  const setElevation = (elevation: boolean) => setPreferences(p => ({ ...p, elevation }));
  const setSetup = (update: (s: Setup) => Setup) => setPreferences(p => ({ ...p, setup: update(p.setup) }));
  const setWind = (update: (w: Wind) => Wind) => setPreferences(p => ({ ...p, wind: update(p.wind) }));
  const [data, setData] = useState<any>(null);
  const [stockCfd, setStockCfd] = useState<CfdData | null>(null);
  const cfd = useMemo(() => vehicleRun ? cfdFromRun(vehicleRun) : stockCfd, [vehicleRun, stockCfd]);
  const baseCfd = useMemo(() => baseRun ? cfdFromRun(baseRun) : stockCfd, [baseRun, stockCfd]);
  const aero = useMemo(() => cfd ? vehicleAero(cfd) : null, [cfd]);
  const baseAero = useMemo(() => baseCfd ? vehicleAero(baseCfd) : null, [baseCfd]);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [free, setFree] = useState(false);
  const [pressure, setPressure] = useState(true);
  const [flow, setFlow] = useState<FlowMode>('smoke');
  const [rate, setRate] = useState(1);
  const [loadStatus, setLoadStatus] = useState('Loading MX-5 OpenFOAM result…');
  const [ready, setReady] = useState(false);
  const [tele, setTele] = useState<Telemetry>({ speed: 0, g: 0, down: 0, elapsed: 0, index: 0, progress: 0, airSpeed: 0, airYaw: 0, slip: 0, covered: true, samples: [], weights: [], loads: null, lateralN: 0, baseLateralN: 0, lateralG: 0, lateralGainG: 0 });
  const host = useRef<HTMLDivElement>(null), stage = useRef<TrackStage | null>(null);
  const loads = tele.loads;
  const needsStock = !vehicleRun || !baseRun;

  useEffect(() => {
    if (!needsStock || stockCfd) return;
    const abort = new AbortController();
    loadCfd(abort.signal, setLoadStatus).then(setStockCfd).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [needsStock, stockCfd]);
  useEffect(() => {
    const abort = new AbortController(); setData(null); setError(''); setReady(false);
    fetch(`/tracks/${track}.geojson`, { signal: abort.signal }).then(r => {
      if (!r.ok) throw new Error('Could not load the circuit.'); return r.json();
    }).then(setData).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [track]);
  const points = useMemo(() => data ? trackPoints(data, elevation) : [], [data, elevation]);
  const result = useMemo(() => points.length && aero && baseAero ? solve(points, setup, aero, baseAero, wind) : null, [points, setup, aero, baseAero, wind]);
  const baseline = useMemo(() => points.length && baseAero ? solve(points, setup, baseAero, baseAero, wind) : null, [points, setup, baseAero, wind]);
  const live = useRef<TrackState | null>(null);
  if (result && aero && baseAero) live.current = { paused, free, pressure, flow, rate, wind, setup, result, aero, baseAero };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.repeat || target.matches('input,select,textarea') || target.isContentEditable) return;
      if (e.code === 'Space') { e.preventDefault(); setPaused(p => !p); }
      if (e.code === 'KeyF') { e.preventDefault(); setFree(f => !f); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!host.current || !points.length || !cfd || !result) { setReady(false); return; }
    try {
      const s = new TrackStage(host.current, points, cfd, () => live.current!, setTele, elevation ? terrainInput(data) : undefined);
      stage.current = s; setReady(true);
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__trackStage = s;
      return () => { s.dispose(); stage.current = null; if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__trackStage; };
    } catch (e) { setError(`Could not open the track scene: ${(e as Error).message}`); }
  }, [points, cfd, !!result]);

  const map = useMemo(() => {
    if (!points.length) return null;
    const xs = points.map(p => p.x), zs = points.map(p => p.z), minX = Math.min(...xs), minZ = Math.min(...zs);
    const scale = 170 / Math.max(Math.max(...xs) - minX, Math.max(...zs) - minZ);
    return points.map(p => [15 + (p.x - minX) * scale, 15 + (p.z - minZ) * scale]);
  }, [points]);

  return <div className="track-lab" data-ready={ready} data-cfd-run={cfd?.manifest.runId}>
    <div ref={host} className="track-stage" />
    <header>
      <WorkspaceMenu mode="track" onChange={onWorkspaceChange} />
      <span>{vehicleRun ? vehicleRun.doc.designName : 'MX-5 NC'} / Aero lap lab</span>
      <label className="track-height" title="Optional terrain-raster heights; these are not surveyed road heights."><input type="checkbox" aria-label="Estimated elevation" checked={elevation} onChange={e => setElevation(e.target.checked)} /><span>Estimated elevation</span></label>
      <select aria-label="Circuit" value={track} onChange={e => setTrack(e.target.value)}>
        <option value="barcelona">Barcelona · Grand Prix</option><option value="monza">Monza · Grand Prix</option><option value="zandvoort">Zandvoort · Grand Prix</option>
      </select>
    </header>
    <aside>
      <div className="eyebrow">WIND TUNNEL → TRACK</div><h2>Vehicle setup</h2>
      <div className="track-vehicle"><small>Base setup</small><b>{baseRun?.doc.designName ?? 'MX-5 NC · solved stock map'}</b><small>Test setup</small><b>{vehicleRun?.doc.designName ?? 'MX-5 NC · solved stock map'}</b>
        {vehicleRun && <small>{vehicleRun.parts.length} solved parts · {vehicleRun.doc.geometry.groups?.filter(g => g.enabled).map(g => g.name).join(', ') || 'enabled wind-tunnel geometry'}</small>}
        <div><button onClick={() => { onBaseChange(vehicleRun); const mass = vehicleRun?.doc.tyreLoadAssessment?.inputs.vehicle_mass_kg ?? vehicleRun?.doc.settings.vehicle_mass_kg; if (mass && mass >= 500 && mass <= 2500) setSetup(s => ({ ...s, mass })); }} disabled={baseRun?.doc.id === vehicleRun?.doc.id}>Use test as base</button><button onClick={() => { if (vehicleRun) app.set({ run: vehicleRun, view: 'results' }); onWorkspaceChange('3d'); }}>Open wind tunnel</button></div>
        {(vehicleRun || baseRun) && <button onClick={() => { onVehicleChange(null); onBaseChange(null); }}>Return to stock MX-5</button>}
      </div>
      <div className="lap-result"><span>Estimated test lap</span><strong>{result ? fmt(result.lap) : '—'}</strong><span>Base setup lap</span><b>{baseline ? fmt(baseline.lap) : '—'}</b><span>Lap gain</span><b data-testid="lap-gain">{result && baseline ? `${(baseline.lap - result.lap).toFixed(2)} s` : '—'}</b></div>
      <hr /><small>Base braking and lateral grip at 100 km/h.</small>
      {(['brake', 'grip', 'mass', 'power'] as const).map(k => <label key={k}>
        {({ brake: 'Base braking · g', grip: 'Base lateral grip · g', mass: 'Mass · kg', power: 'Wheel power · kW' })[k]}
        <input type="number" min={k === 'mass' ? 500 : k === 'power' ? 30 : .3} max={k === 'mass' ? 2500 : k === 'power' ? 500 : 3} step={k === 'brake' || k === 'grip' ? .05 : 10} value={setup[k]} onChange={e => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v > 0) setSetup(s => ({ ...s, [k]: Math.min(k === 'mass' ? 2500 : k === 'power' ? 500 : 3, Math.max(k === 'mass' ? 500 : k === 'power' ? 30 : .3, v)) }));
        }} />
      </label>)}
      <hr /><details className="track-wind"><summary>Wind · {wind.speed ? `${wind.speed} m/s` : 'calm'}</summary><label>Wind · m/s<input aria-label="Wind speed" type="number" min="0" max="15" step=".5" value={wind.speed} onChange={e => setWind(w => ({ ...w, speed: Math.max(0, Math.min(15, Number(e.target.value) || 0)) }))} /></label>
      <label>Wind direction · °<input aria-label="Wind direction" type="number" min="0" max="360" step="15" value={wind.bearing} onChange={e => setWind(w => ({ ...w, bearing: Math.max(0, Math.min(360, Number(e.target.value) || 0)) }))} /></label>
      <small>Wind travels toward this bearing: 0° north, 90° east. Corner sideslip is a bicycle-model estimate.</small></details>
      <hr /><small>Add parts in the wind tunnel, solve, then choose “Test on track”.</small>
      <details className="track-model-notes"><summary>Grip model</summary><p>CFD lift reduces tyre load; downforce increases it. Both setups share mass, power and tyre calibration. The lateral limit is the total available tyre force.</p><p className="caveat">Exploratory lap model · constant tyre coefficient. No tyre load sensitivity, axle balance limit or banking benefit.{result?.outsideCoverage && ' Some lap points use boundary coefficients outside the solved map.'}</p></details>
    </aside>
    <section className="track-tele" aria-label="Live telemetry" data-progress={tele.progress}>
      <small>LIVE TELEMETRY</small>
      <div className="track-speed"><strong>{tele.speed.toFixed(0)}</strong> km/h</div>
      <span className="track-dynamics">{tele.g.toFixed(2)} g lateral · {fmt(tele.elapsed)} / lap</span>
      <div className="track-grip"><span>Lateral limit</span><output aria-label="Available lateral grip" data-force={tele.lateralN}>{tele.lateralG.toFixed(2)} g <small>({(tele.lateralN / 1000).toFixed(1)} kN)</small></output><small aria-label="Lateral grip gain">{tele.lateralGainG >= 0 ? '+' : ''}{tele.lateralGainG.toFixed(2)} g · {tele.lateralN - tele.baseLateralN >= 0 ? '+' : ''}{(tele.lateralN - tele.baseLateralN).toFixed(0)} N vs base</small></div>
      <div className="track-loads" role="group" aria-label="CFD vertical force">
        <div><small>Lift ↑</small><output aria-label="CFD lift" data-newtons={loads?.liftN}>{loads ? loads.liftN.toFixed(0) : '—'} <small>N</small></output></div>
        <div><small>Downforce ↓</small><output aria-label="CFD downforce" data-newtons={loads?.downforceN}>{loads ? loads.downforceN.toFixed(0) : '—'} <small>N</small></output></div>
      </div>
      <small className="track-load-caption">{loads ? `OpenFOAM · ${loads.forceSettled && loads.residualConverged ? 'exploratory' : 'unsettled case'}` : !tele.covered ? 'Outside CFD force coverage' : 'CFD force data unavailable'}</small>
    </section>
    <section className="track-cfd-status" aria-label="CFD source">
      <div className="eyebrow">{cfd?.map ? 'OPENFOAM LAP PLAYBACK' : 'WIND-TUNNEL RESULT'}</div>
        {cfd?.map ? <>
          <b>{tele.airSpeed.toFixed(0)} km/h · {tele.airYaw >= 0 ? '+' : ''}{tele.airYaw.toFixed(1)}° yaw</b>
          <p>Precomputed OpenFOAM · {cfd.map.manifest.samples.length} {cfd.map.manifest.quality === 'fast' ? 'Fast' : 'Medium'} cases · interpolated.</p>
          {!tele.covered && <p className="track-map-warning">Outside map: flow uses the boundary field; force readouts are unavailable. The lap model scales boundary coefficients.</p>}
          <details><summary>Active cases & assumptions</summary>
            <p>{cfd.map.manifest.speeds[0]}–{cfd.map.manifest.speeds.at(-1)} km/h · ±{cfd.map.manifest.yaws.at(-1)}°.</p>
            <p>{cfd.map.manifest.samples[0].cells.toLocaleString()} shared-mesh cells. Steady speed/yaw cases; turning-rate effects are not solved.</p>
            <p>Yaw comes from estimated corner sideslip and world wind, not the track heading. β = atan(½ wheelbase × signed curvature).</p>
            <p>Lift ↑ and downforce ↓ show opposing directions of the net vehicle-vertical force; only one is positive. Solver-averaged Cl is interpolated, then scaled by ½ρAV² at the current relative airspeed. Values update at 10 Hz and freeze on pause.</p>
            {loads && <p>Current Cl: {loads.cl.toFixed(3)}. These CFD loads feed the lap model’s tyre-load and drag estimates.</p>}
            {tele.samples.map((id, i) => tele.weights[i] > .001 && <div className="track-case" key={i}>{id} · {(tele.weights[i] * 100).toFixed(0)}% · {cfd.map!.samples.find(s => s.info.id === id)?.info.forceSettled ? 'settled' : 'provisional'}</div>)}
            <p>Fast exploratory map; individual solver convergence warnings are retained. Wind-tunnel configurations use their own saved geometry and results.</p>
          </details>
        </> : <>
          <b>{tele.airSpeed.toFixed(0)} km/h · {tele.airYaw >= 0 ? '+' : ''}{tele.airYaw.toFixed(1)}° yaw</b>
          <p>Single-condition CFD · speed-scaled forces. Flow shape stays at the solved yaw.</p>
          <details><summary>Source & assumptions</summary><p>Saved OpenFOAM result: {cfd?.manifest.sourceName}. Solved at {cfd?.manifest.settings.speed_kmh} km/h and {cfd?.manifest.settings.yaw_deg}° yaw. No speed/yaw map is available for this setup.</p><p>Lift and drag use this run’s Cl/Cd and current relative airspeed². Its enabled parts, wall pressure and flow field come from the wind tunnel. New yaw-dependent flow requires more solved cases.</p>{cfd?.manifest.result.warnings.map((w,i) => <p key={i}>{w}</p>)}</details>
        </>}
    </section>
    <div className="track-legend" aria-label="CFD colour scales">
      {pressure && <div><span>Surface Cp</span><i style={{ background: cssGradient('diverging') }} /><small>{cfd?.manifest.cpRange[0].toFixed(1) ?? '−1.5'} · suction <em>pressure · +{cfd?.manifest.cpRange[1].toFixed(1) ?? '1'}</em></small></div>}
      {flow !== 'off' && (flow === 'smoke' ? <div><span>Airflow relative to the car</span><i style={{ background: 'linear-gradient(to right, #e47d3b, #e5eaf0, #5087dc)' }} /><small>Slower / wake <em>Faster</em></small></div> : <div><span>Air speed · {cfd?.map ? 'CFD map' : 'solved reference'}</span><i style={{ background: cssGradient('speed') }} /><small>0 <em>{cfd ? ((cfd.map?.manifest.speedMax ?? cfd.manifest.speedMax) * 3.6).toFixed(0) : '…'} km/h</em></small></div>)}
    </div>
    <nav>
      <div className="track-controls">
        <button onClick={() => setPaused(p => !p)}>{paused ? '▶ Resume' : 'Ⅱ Pause'} · Space</button>
        <button onClick={() => setFree(f => !f)}>{free ? 'Free camera' : 'Follow camera'} · F</button>
        <button aria-pressed={pressure} onClick={() => setPressure(p => !p)}>{pressure ? 'Pressure on' : 'Body colour'}</button>
        <select aria-label="Airflow display" value={flow} onChange={e => setFlow(e.target.value as FlowMode)}><option value="streamlines">CFD streamlines</option><option value="smoke">Moving airflow</option><option value="off">Hide airflow</option></select>
        <select aria-label="Playback speed" value={rate} onChange={e => setRate(Number(e.target.value))}><option value={1}>1× speed</option><option value={2}>2× speed</option><option value={5}>5× speed</option></select>
      </div>
      <input aria-label="Lap progress" type="range" min="0" max="1000" value={Math.round(tele.progress * 1000)} onChange={e => { setPaused(true); stage.current?.seek(Number(e.target.value) / 1000); }} />
    </nav>
    <div className="track-map">{map && <svg viewBox="0 0 200 200"><polyline points={map.map(p => p.join(',')).join(' ')} fill="none" stroke="#729496" strokeWidth="3" /><circle cx={map[tele.index]?.[0]} cy={map[tele.index]?.[1]} r="5" fill="#f6b568" /></svg>}
      <small>{free ? 'Drag: orbit · right drag: pan · scroll: zoom. WASD: move · Q/E: down/up.' : 'Follow view · Space to pause · F to explore'}<br />{free && 'Road fades automatically underneath.'}</small>
    </div>
    <footer>Track: © OpenStreetMap contributors · ODbL · draft GP trace · {elevation ? 'estimated terrain heights' : 'flat road'} · nominal 12 m road / schematic kerbs · <a href="https://github.com/markthebault/open-racetrack-db/pull/10">source PR #10</a><br />{vehicleRun ? `Car: ${vehicleRun.doc.designName} · saved wind-tunnel geometry` : 'MX-5 NC: Nieve5677 / Sketchfab · CC BY 4.0 · solved exterior geometry'}</footer>
    {(!ready || error) && <div className="track-loading" role="status">{error || (!data ? 'Loading circuit…' : !cfd ? loadStatus : 'Preparing solved geometry and airflow…')}</div>}
  </div>;
}
