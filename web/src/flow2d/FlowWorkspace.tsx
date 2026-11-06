import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, Check, CircleHelp, Hand, Maximize, Minus, MousePointer2, Pause, Play, Plus, RotateCcw, Spline, Undo2, Upload, Waves, X } from "lucide-react";
import { WorkspaceMenu } from "../ui/Chrome";
import { useStore } from "../store/store";
import { app } from "../store/app";
import { PRESETS, type Point, type Profile } from "./geometry";
import { viewport, screenPoint, zoomCamera, type Camera, type Layer, type AnimationMode } from "./render";
import { addedPreset, bounds, enabledShapes, isCarShape, moveShape, restoreScene, sceneError, sceneFrom, sceneGrid, replaceShape, scaleShape, selectedShape, selectedShapes, shapeFrom, simulationKey, SCENE_KEY, type Scene } from "./scene";
import { curvePath, curved, sampleCurve, type CurveNode, type DrawTool } from "./curves";
import { DrawTools } from "./DrawTools";
import { MetricsPanel } from "./MetricsPanel";
import { TUNNELS } from "./grid";
import { ShapeEditor, type EditMode } from "./ShapeEditor";
import { ScenePanel } from "./ScenePanel";
import { useFlow } from "./useFlow";
import { importSvg } from "./importSvg";
import "./flow2d.css";
import solverSource from "./lbm.ts?raw";
import gpuSource from "./gpu.ts?raw";
import latticeSource from "./lattice.ts?raw";
import boundarySource from "./boundary.ts?raw";
import solverNotice from "../../../docs/flow2d/README.md?raw";
import lgpl from "../../../docs/flow2d/licenses/LGPL-3.0.txt?raw";
import gpl from "../../../docs/flow2d/licenses/GPL-3.0.txt?raw";

export function FlowWorkspace({ onWorkspaceChange }: { onWorkspaceChange: (mode: "2d" | "3d" | "track") => void }) {
  const dark = useStore(app, s => s.dark);
  const [scene, setScene] = useState(restoreScene), [history, setHistory] = useState<Scene[]>([]);
  const [mode, setMode] = useState<EditMode>("select"), [draft, setDraft] = useState<CurveNode[]>([]);
  const [tool, setTool] = useState<DrawTool>("line"), [snap, setSnap] = useState(true), [lockAspect, setLockAspect] = useState(false), [panMode, setPanMode] = useState(false);
  const [camera, setCamera] = useState<Camera>({ zoom: 1, pan: { x: 0, y: 0 } });
  const [playing, setPlaying] = useState(!matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [layer, setLayer] = useState<Layer>("flow"), [animation, setAnimation] = useState<AnimationMode>("smoke");
  const [playback, setPlayback] = useState(1), [restart, setRestart] = useState(0), [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState<File | null>(null), [importWidth, setImportWidth] = useState(600), [help, setHelp] = useState(false);
  const root = useRef<HTMLDivElement>(null), fileInput = useRef<HTMLInputElement>(null), current = useRef(scene); current.current = scene;
  const { canvas, size, status, metrics, message, setMessage } = useFlow(scene, restart, playing, dragging, playback, layer, animation, dark, camera);
  const profile = selectedShape(scene), selection = selectedShapes(scene), grid = sceneGrid(scene);
  const zoom = (factor: number) => setCamera(c => zoomCamera(c, c.zoom * factor, size.width, size.height, undefined, grid));
  const selectAll = () => { setMode("select"); setPanMode(false); setDraft([]); setScene(s => ({ ...s, selectedId: s.shapes.at(-1)?.id ?? null, selectedIds: s.shapes.map(p => p.id) })); };
  useEffect(() => {
    const element = root.current!;
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest(".flow-scene,.flow-tools,.flow-draw-tools,.flow-hint,.flow-bottom,.flow-modal-backdrop,.flow-view-controls,.flow-metrics")) return;
      e.preventDefault(); const rect = element.getBoundingClientRect();
      setCamera(c => zoomCamera(c, c.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * .0015), size.width, size.height, { x: e.clientX - rect.left, y: e.clientY - rect.top }, grid));
    };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, [size.width, size.height, grid]);
  useEffect(() => { if (status.error) setPlaying(false); }, [status.error]);
  function commit(next: Scene, before = current.current) {
    const error = sceneError(next);
    if (error) { setScene(before); setMessage(error); return false; }
    if (sceneGrid(next).id !== sceneGrid(before).id) setCamera({ zoom: 1, pan: { x: 0, y: 0 } });
    setHistory(h => [...h.slice(-29), structuredClone(before)]); setScene(next); setMessage(""); if (simulationKey(next) !== simulationKey(before)) setRestart(n => n + 1); persist(next); return true;
  }
  function persist(value: Scene) { try { localStorage.setItem(SCENE_KEY, JSON.stringify(value)); } catch { /* Optional storage. */ } }
  function undo() {
    if (mode === "draw") { setDraft(d => d.slice(0, -1)); return; }
    const previous = history.at(-1); if (previous) { if (sceneGrid(previous).id !== grid.id) setCamera({ zoom: 1, pan: { x: 0, y: 0 } }); setScene(previous); setHistory(h => h.slice(0, -1)); setMessage(""); if (simulationKey(previous) !== simulationKey(scene)) setRestart(n => n + 1); persist(previous); }
  }
  const select = (id: string, additive = false) => { setScene(s => { const ids = additive ? new Set(selectedShapes(s).map(p => p.id)) : new Set<string>(); if (additive && ids.has(id)) ids.delete(id); else ids.add(id); return { ...s, selectedId: [...ids].at(-1) ?? null, selectedIds: [...ids] }; }); if (additive) setMode("select"); };
  function append(profile: Profile & { curve?: CurveNode[] }) { const shape = shapeFrom(profile); return commit({ ...scene, shapes: [...scene.shapes, shape], selectedId: shape.id, selectedIds: [shape.id] }); }
  function finishDrawing() { const curve = curved(draft) ? draft : undefined, names = { line: "Custom profile", bezier: "Bézier profile", rectangle: "Rectangle", ellipse: "Ellipse", freehand: "Freehand profile" }; if (draft.length >= 3 && append({ name: names[tool], points: curve ? sampleCurve(curve) : draft, ...(curve ? { curve } : {}) })) { setDraft([]); setMode("points"); } }
  function deleteShape() { if (!selection.length) return; const ids = new Set(selection.map(s => s.id)), shapes = scene.shapes.filter(s => !ids.has(s.id)), id = shapes.at(-1)?.id ?? null; commit({ ...scene, shapes, selectedId: id, selectedIds: id ? [id] : [] }); }
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select, [contenteditable=true]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); selectAll(); }
      if (e.key === "Escape") { setMode("select"); setDraft([]); setPanMode(false); setHelp(false); setImporting(null); }
      if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "v") { setMode("select"); setDraft([]); setPanMode(false); }
      if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "h") setPanMode(p => !p);
      if ((e.key === "Delete" || e.key === "Backspace") && mode === "select") { e.preventDefault(); deleteShape(); }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  });
  async function confirmImport() {
    if (!importing) return;
    try {
      let next = shapeFrom(importSvg(await importing.text(), importing.name, importWidth, grid));
      const b = bounds(next.points), selected = profile ? bounds(profile.points) : null;
      if (selected && selected.maxY + b.height + .08 < grid.height - .05) next = moveShape(next, selected.center.x - b.center.x, selected.maxY + .08 - b.minY);
      if (commit({ ...scene, shapes: [...scene.shapes, next], selectedId: next.id, selectedIds: [next.id] })) { setImporting(null); setMode("select"); }
    } catch (e) { setMessage(e instanceof Error ? e.message : "Could not read that SVG."); }
  }
  function calibrateCar() {
    if (!profile) return;
    const b = bounds(profile.points), target = grid.width < 4.5 || grid.height < 1.7 ? TUNNELS.large : grid;
    let shape = scaleShape(profile, 4.3 / b.width, 1.5 / b.height, { x: b.minX, y: b.minY });
    const sized = bounds(shape.points), dx = Math.max(.1 - sized.minX, Math.min(0, target.width - .1 - sized.maxX));
    const dy = Math.max(.025 - sized.minY, Math.min(0, target.height - .05 - sized.maxY));
    shape = moveShape(shape, dx, dy);
    if (commit({ ...replaceShape(scene, shape), tunnel: target.id })) setCamera({ zoom: 1, pan: { x: 0, y: 0 } });
  }
  function focusSelection() {
    if (!selection.length) return;
    const b = bounds(selection.flatMap(s => s.points)), base = viewport(size.width, size.height, undefined, grid);
    const scale = Math.min((size.width - 60) / b.width, Math.max(100, size.height - (size.width < 600 ? 560 : 445)) / b.height) * .8;
    const next = { zoom: Math.max(.5, Math.min(6, scale / base.scale)), pan: { x: 0, y: 0 } };
    const p = screenPoint(b.center, viewport(size.width, size.height, next, grid));
    next.pan = { x: size.width / 2 - p.x, y: base.y + grid.height * base.scale / 2 - p.y }; setCamera(next);
  }
  function exportSvg() {
    const active = enabledShapes(scene); if (!active.length) return;
    const box = bounds(active.flatMap(s => s.points));
    const project = (p: Point) => ({ x: Number(((p.x - box.minX) * 1000).toFixed(3)), y: Number(((box.maxY - p.y) * 1000).toFixed(3)) });
    const polygons = active.map(s => s.curve ? `<path d="${curvePath(s.curve, project)}"/>` : `<polygon points="${s.points.map(p => { const q = project(p); return `${q.x},${q.y}`; }).join(" ")}"/>`).join("");
    const blob = new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${box.width * 1000}mm" height="${box.height * 1000}mm" viewBox="0 0 ${box.width * 1000} ${box.height * 1000}">${polygons}</svg>`], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = "easycfd-scene.svg"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div ref={root} className={`flow-workspace ${mode === "draw" ? "is-drawing" : ""}`} data-testid="flow-workspace">
    <canvas ref={canvas} onPointerDown={() => { if (mode !== "draw" && !panMode) setScene(s => ({ ...s, selectedId: null, selectedIds: [] })); }} className="flow-canvas" data-domain-width={grid.width} data-domain-height={grid.height} data-grid-nx={grid.nx} data-grid-ny={grid.ny} aria-label="Animated two-dimensional airflow around the shapes" />
    <header className="topbar flow-topbar"><WorkspaceMenu mode="2d" onChange={onWorkspaceChange} /><span className="flow-project-name">{profile?.name ?? "2D scene"}</span><div className="spacer" /><button className="icon-btn" aria-label="About 2D flow" title="About 2D flow" onClick={() => setHelp(true)}><CircleHelp size={18} /></button></header>
    <div className="flow-heading"><span className="flow-eyebrow">THE 2D WIND TUNNEL</span><h1>Explore the flow.</h1><p>Move, rotate and build your own shapes.</p></div>
    <div className="flow-tools glass" role="toolbar" aria-label="Profile tools">
      <button aria-label="Select and transform shapes" title="Select · V · Drag empty space to box-select · Shift adds to selection" className={mode === "select" && !panMode ? "selected" : ""} aria-pressed={mode === "select" && !panMode} onClick={() => { setMode("select"); setPanMode(false); setDraft([]); }}><MousePointer2 size={16} /><span>Select</span></button>
      <button aria-label="Edit points" className={mode === "points" ? "selected" : ""} aria-pressed={mode === "points"} disabled={selection.length !== 1} onClick={() => { setMode("points"); setPanMode(false); setDraft([]); }}><Spline size={16} /><span>Edit points</span></button>
      <button className={mode === "draw" ? "selected" : ""} aria-pressed={mode === "draw"} onClick={() => { setMode(m => m === "draw" ? "select" : "draw"); setPanMode(false); setDraft([]); }}><Plus size={17} /><span>Draw</span></button>
      <button onClick={() => fileInput.current?.click()}><Upload size={16} /><span>Import SVG</span></button><span className="flow-tool-divider" />
      <button aria-label="Undo profile change" title="Undo · ⌘Z / Ctrl+Z" disabled={mode === "draw" ? !draft.length : !history.length} onClick={undo}><Undo2 size={16} /></button><button aria-label="Export profile SVG" title="Export enabled shapes as SVG" disabled={!enabledShapes(scene).length} onClick={exportSvg}><ArrowDownToLine size={16} /></button>
    </div>
    <input ref={fileInput} type="file" accept=".svg,image/svg+xml" hidden onChange={e => { const file = e.target.files?.[0]; if (file) { setImporting(file); setMessage(""); } e.target.value = ""; }} />
    <ScenePanel scene={scene} mobile={size.width < 650} lockAspect={lockAspect} onLockAspect={setLockAspect} onSelect={select} onSelectAll={selectAll} onTunnel={id => commit({ ...scene, tunnel: id })} onExample={kind => { if (commit(sceneFrom(PRESETS[kind]))) { setMode("select"); setDraft([]); setCamera({ zoom: 1, pan: { x: 0, y: 0 } }); } }} onCarSize={calibrateCar} onRename={(id, name) => { const shape = scene.shapes.find(s => s.id === id); if (shape && shape.name !== name) commit(replaceShape(scene, { ...shape, name, ...(isCarShape(shape) ? { preset: "car" } : {}) })); }} onEnabled={(id, enabled) => { const shape = scene.shapes.find(s => s.id === id); if (shape) commit(replaceShape(scene, { ...shape, enabled })); }} onCommit={next => commit(next)} onAdd={key => { const target = PRESETS[key]?.vehicle && grid.id === "small" ? TUNNELS.large : grid; const shape = addedPreset(key, profile, target); if (commit({ ...scene, tunnel: target.id, shapes: [...scene.shapes, shape], selectedId: shape.id, selectedIds: [shape.id] })) setMode("select"); }} onDelete={deleteShape} onDuplicate={() => { const copies = selection.map(p => ({ ...moveShape(p, .08, .08), id: crypto.randomUUID(), name: `${p.name.slice(0,75)} copy` })); if (copies.length) commit({ ...scene, shapes: [...scene.shapes, ...copies], selectedId: copies.at(-1)!.id, selectedIds: copies.map(p => p.id) }); }} />
    <MetricsPanel scene={scene} report={metrics} mobile={size.width < 650} playing={playing} onReference={referenceLength => commit({ ...scene, referenceLength })} onRestore={value => { if (commit(value)) { setMode("select"); setDraft([]); } }} />
    <ShapeEditor scene={scene} mode={mode} draft={draft} tool={tool} snap={snap} lockAspect={lockAspect} panMode={panMode} camera={camera} onPan={pan => setCamera(c => ({ ...c, pan }))} viewport={viewport(size.width, size.height, camera, grid)} onSelect={select} onPreview={setScene} onCommit={(next, before) => commit(next, before)} onDraft={setDraft} onClose={finishDrawing} onDragging={setDragging} />
    <div className="flow-view-controls glass" role="toolbar" aria-label="View controls"><button aria-label="Zoom out" onClick={() => zoom(1 / 1.25)}><Minus size={15} /></button><button aria-label="Reset zoom" title="Fit tunnel" onClick={() => setCamera({ zoom: 1, pan: { x: 0, y: 0 } })}>{Math.round(camera.zoom * 100)}%</button><button aria-label="Zoom in" onClick={() => zoom(1.25)}><Plus size={15} /></button><button aria-label="Fit selection" title="Zoom to selected shapes" disabled={!selection.length} onClick={focusSelection}><Maximize size={15} /></button><button aria-label="Pan view" aria-pressed={panMode} className={panMode ? "selected" : ""} title="Pan · H · or hold Space and drag" onClick={() => setPanMode(p => !p)}><Hand size={15} /></button></div>
    {mode === "draw" && <><DrawTools tool={tool} snap={snap} onSnap={setSnap} onTool={next => { if (!["line", "bezier"].includes(tool) || !["line", "bezier"].includes(next)) setDraft([]); setTool(next); }} /><div className="flow-hint flow-draw-hint glass"><span>{tool === "bezier" ? "Click for corners, drag for curves. Alt breaks tangent symmetry." : tool === "rectangle" || tool === "ellipse" ? "Drag to draw. Shift makes a square or circle." : tool === "freehand" ? "Trace the outline, then add the shape." : "Click to add points. Right-click or double-click a point to remove."} <small>⌘/Ctrl+Z undoes. Click the first point to close.</small></span><button className="btn primary sm" disabled={draft.length < 3} onClick={finishDrawing}><Check size={15} />{tool === "line" || tool === "bezier" ? "Close shape" : "Add shape"}</button><button className="icon-btn" aria-label="Cancel drawing" onClick={() => { setMode("select"); setDraft([]); }}><X size={16} /></button></div></>}
    {mode === "points" && <div className="flow-hint glass"><span>Drag points or curve handles. Right-click or double-click a point to remove.</span><button className="btn ghost sm" onClick={() => setMode("select")}>Done</button></div>}
    <footer className="flow-bottom"><div className="flow-bottom-row">
      <div className="flow-status" role="status"><i className={status.error ? "failed" : status.ready && playing ? "running" : ""} /><span>{status.error ? "Flow stopped" : !status.ready ? "Preparing flow…" : playing ? "Flow is evolving" : "Paused"}<small>{status.ready ? `${status.steps.toLocaleString()} steps · ${status.backend === "webgpu" ? "WebGPU" : "WASM"}` : "Starting the browser solver"}</small></span></div>
      <div className="flow-playback glass"><div className="flow-playback-main"><button className="flow-play" aria-label={playing ? "Pause simulation" : "Resume simulation"} onClick={() => setPlaying(p => !p)}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}<span>{playing ? "Pause" : "Resume"}</span></button><button className="icon-btn" aria-label="Reset flow" title="Reset flow" onClick={() => { setMessage(""); setRestart(n => n + 1); }}><RotateCcw size={16} /></button><span className="flow-tool-divider" /><div className="flow-layers" role="group" aria-label="Flow display">{(["flow", "pressure", "vorticity"] as Layer[]).map(l => <button key={l} className={layer === l ? "selected" : ""} aria-pressed={layer === l} onClick={() => setLayer(l)}>{l === "flow" && <Waves size={16} />}{l === "flow" ? "Flow" : l === "pressure" ? "Pressure" : "Vortices"}</button>)}</div></div>
      <div className="flow-animation-controls"><label>Animation<select aria-label="Flow animation" value={animation} onChange={e => setAnimation(e.target.value as AnimationMode)}><option value="smoke">Flowing smoke</option><option value="trails">Particle trails</option><option value="arrows">Velocity arrows</option><option value="none">Colour field only</option></select></label><label className="flow-speed-slider"><span>Speed</span><input type="range" aria-label="Animation speed" min="0.1" max="3" step="0.1" value={playback} onChange={e => setPlayback(Number(e.target.value))} /><output>{playback.toFixed(1)}×</output></label></div></div>
      <div className="flow-legend"><div className={`flow-colorbar ${layer}`} /><span>{layer === "pressure" ? "Lower pressure" : layer === "vorticity" ? "Clockwise" : "Slower"}<span>{layer === "pressure" ? "Higher pressure" : layer === "vorticity" ? "Counterclockwise" : "Faster"}</span></span><small>{layer === "pressure" ? "Cp −2.5 to +2.5" : layer === "vorticity" ? "Rotation · outlines show rotating cores" : "Speed relative to inlet"}</small></div>
    </div><div className="flow-footnote"><span>2D flow study · Exploratory prototype</span><button onClick={() => setHelp(true)}>How to read this <ArrowRight size={12} /></button></div></footer>
    {message && !importing && <div className="flow-message glass" role="alert">{message}<button className="icon-btn" aria-label="Dismiss message" onClick={() => setMessage("")}><X size={15} /></button></div>}
    {(importing || help) && <div className="flow-modal-backdrop" onClick={() => { setImporting(null); setHelp(false); }}><section className="flow-modal glass" role="dialog" aria-modal="true" aria-label={importing ? "Import SVG profile" : "About 2D flow"} onClick={e => e.stopPropagation()}><button className="icon-btn flow-modal-close" aria-label="Close dialog" autoFocus onClick={() => { setImporting(null); setHelp(false); }}><X size={18} /></button>
      {importing ? <><Upload size={25} /><h2>Add an SVG to your scene.</h2><p>{importing.name}</p><label>Profile width in millimetres<input type="number" aria-label="SVG profile width in millimetres" min="30" max={Math.floor((grid.width - .2) * 1000)} value={importWidth} onChange={e => setImportWidth(Number(e.target.value))} /></label><p className="small muted">One closed outline, without holes. It becomes a new shape alongside your existing geometry.</p>{message && <p role="alert" className="flow-import-error">{message}</p>}<button className="btn primary block" onClick={confirmImport}>Import profile <ArrowRight size={16} /></button></>
      : <><Waves size={26} /><h2>Follow the flow.</h2><p>Smoke, trails and arrows follow the computed velocity. The colour field evolves with the solver: Pressure shows rises and falls; Vortices shows local rotation. Smoke is a passive tracer and adds no forces. Fine outlines identify rotating vortex cores from the velocity gradients.</p><p>In Select, drag empty space to draw a selection box. Shift-drag adds shapes; Escape cancels. Drag a selected shape or the group border to move the selection. Shift-click or ⌘/Ctrl+A also selects several. Drag corners to resize, hold Shift to keep proportions, or use the round rotation handle. Draw offers straight outlines, Bézier curves, rectangles, ellipses and freehand. Right-click or double-click removes a point; ⌘/Ctrl+Z undoes. Curve handles stay editable after saving. Scroll to zoom; use the hand tool or hold Space to pan.</p><p>Rename the selected shape in its panel. Uncheck a shape to remove it from the flow calculation while keeping its editable outline. Drag &amp; lift measures the total boundary force on enabled shapes, averaged after warmup. Save a baseline after the mean settles, then rotate a profile or toggle a part to compare section coefficients. Save configuration keeps named designs and their measured values; unfinished averages are marked provisional. Keep the box and reference length fixed; negative lift means downforce.</p><p>This browser prototype adapts AeroJAX’s D2Q9 lattice Boltzmann equations to jax-js on a {grid.nx} × {grid.ny} grid in a {grid.width} m × {grid.height} m box. It is an exploratory section study with simplified boundaries. Thin details below a few cells cannot be resolved. Playback is accelerated and is not a physical-time recording or a prediction of full-car forces.</p><p><a href="https://github.com/arriemeijer-creator/AeroJAX" target="_blank" rel="noreferrer">AeroJAX · LGPL-3.0</a> / <a href="https://github.com/ekzhang/jax-js" target="_blank" rel="noreferrer">jax-js · MIT</a></p><a className="btn ghost sm" download="easycfd-2d-solver-source.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(solverNotice + "\n\n--- lbm.ts ---\n" + solverSource + "\n\n--- gpu.ts ---\n" + gpuSource + "\n\n--- lattice.ts ---\n" + latticeSource + "\n\n--- boundary.ts ---\n" + boundarySource + "\n\n--- LGPL ---\n" + lgpl + "\n\n--- GPL ---\n" + gpl)}`}>Download solver source &amp; licences</a></>}
    </section></div>}
  </div>;
}
