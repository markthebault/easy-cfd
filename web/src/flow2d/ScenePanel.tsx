import { Copy, Trash2 } from "lucide-react";
import { bounds, isEnabled, isCarShape, moveShape, rotateShape, scaleShape, sceneGrid, selectedShape, selectedShapes, transformSelection, type Scene } from "./scene";
import { TUNNELS, type TunnelId } from "./grid";

function TransformField({ label, value, unit, onCommit }: { label: string; value: number; unit: string; onCommit: (value: number) => void }) {
  return <label className="flow-transform-field"><span>{label}</span><div><input key={value.toFixed(2)} type="number" aria-label={label} defaultValue={Number(value.toFixed(2))} step={unit === "°" ? 1 : 5} onBlur={e => { const n = e.currentTarget.valueAsNumber; if (Number.isFinite(n) && Math.abs(n - value) > .001) onCommit(n); }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} /><small>{unit}</small></div></label>;
}
export function ScenePanel({ scene, mobile, lockAspect, onLockAspect, onSelect, onSelectAll, onTunnel, onExample, onCarSize, onRename, onEnabled, onCommit, onAdd, onDuplicate, onDelete }: {
  scene: Scene; mobile: boolean; lockAspect: boolean; onLockAspect: (lock: boolean) => void; onSelect: (id: string, additive?: boolean) => void; onSelectAll: () => void;
  onCommit: (scene: Scene) => void; onAdd: (key: string) => void; onDuplicate: () => void; onDelete: () => void;
  onRename: (id: string, name: string) => void; onEnabled: (id: string, enabled: boolean) => void;
  onTunnel: (id: TunnelId) => void; onExample: (kind: "car" | "airfoil") => void; onCarSize: () => void;
}) {
  const grid = sceneGrid(scene);
  const shape = selectedShape(scene), selection = selectedShapes(scene), box = selection.length ? bounds(selection.flatMap(s => s.points)) : null;
  const clearance = (input: HTMLInputElement) => { const n = input.valueAsNumber / 1000; if (box && Math.abs(n - box.minY) > .0001) onCommit(transformSelection(scene, s => moveShape(s, 0, n - box.minY))); };
  return <details className="flow-scene glass" open={!mobile}>
    <summary><span>{grid.width} × {grid.height} m · {scene.shapes.length} {scene.shapes.length === 1 ? "SHAPE" : "SHAPES"}</span><b>{selection.length > 1 ? `${selection.length} shapes selected` : shape?.name ?? "Scene"}</b></summary>
    <label className="flow-tunnel-size">Simulation box<select aria-label="Simulation box" value={grid.id} onChange={e => onTunnel(e.target.value as TunnelId)}>{["small", "medium", "large"].map(id => { const g = TUNNELS[id as TunnelId]; return <option key={id} value={id}>{g.label} · {g.width} m × {g.height} m</option>; })}{grid.id === "legacy" && <option value="legacy">Previous · 4.2 m × 1.2 m</option>}</select><small>Length along airflow × height</small></label>
    <div className="flow-example-actions"><button title="Start a new wing scene · Undo restores this scene" onClick={() => onExample("airfoil")}>New parts scene</button><button title="Start a new full-size car scene · Undo restores this scene" onClick={() => onExample("car")}>New car scene</button></div>
    <div className="flow-shape-list" role="list" aria-label="Scene shapes">{scene.shapes.map(s => <div key={s.id} className={`flow-shape-row ${!isEnabled(s) ? "simulation-disabled" : ""}`} role="listitem"><button aria-pressed={selection.some(p => p.id === s.id)} onClick={e => onSelect(s.id, e.shiftKey || e.metaKey || e.ctrlKey)}><i />{s.name}</button><label className="flow-shape-toggle" title="Include this shape in the simulation"><input type="checkbox" aria-label={`Enable ${s.name}`} checked={isEnabled(s)} onChange={e => onEnabled(s.id, e.target.checked)} /></label></div>)}</div>
    {scene.shapes.length > 1 && <button className="flow-select-all" onClick={onSelectAll}>Select all <span>⌘/Ctrl+A</span></button>}
    <select className="flow-add-shape" aria-label="Add shape" value="" onChange={e => onAdd(e.target.value)}><option value="" disabled>+ Add a shape</option><option value="rectangle">Rectangle</option><option value="airfoil">Airfoil</option><option value="inverted-airfoil">Inverted airfoil (rear wing)</option><option value="splitter">Splitter</option><option value="cylinder">Circle</option><optgroup label="Silhouettes"><option value="car">Car silhouette</option><option value="mx5-nc-prht">MX-5 NC PRHT</option></optgroup></select>
    {shape && box && <>
      {selection.length === 1 && <label className="flow-name-field">Shape name<input key={`${shape.id}:${shape.name}`} aria-label="Shape name" maxLength={80} defaultValue={shape.name} onBlur={e => { const name = e.currentTarget.value.trim(); if (name) onRename(shape.id, name); else e.currentTarget.value = shape.name; }} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { e.stopPropagation(); e.currentTarget.value = shape.name; e.currentTarget.blur(); } }} /></label>}
      <div className="flow-dimensions"><span><b>{Math.round(box.width * 1000)}</b> × <b>{Math.round(box.height * 1000)}</b> mm</span><span><b>{Math.round(box.minY * 1000)}</b> mm clearance</span></div>
      {selection.length === 1 && isCarShape(shape) && <button className="flow-car-size" onClick={onCarSize}>Size as car · 4.3 × 1.5 m</button>}
      <div className="flow-transform-grid">
        <TransformField label="Horizontal position" value={box.center.x * 1000} unit="mm" onCommit={n => onCommit(transformSelection(scene, s => moveShape(s, n / 1000 - box.center.x, 0)))} />
        <TransformField label="Vertical position" value={box.center.y * 1000} unit="mm" onCommit={n => onCommit(transformSelection(scene, s => moveShape(s, 0, n / 1000 - box.center.y)))} />
        <TransformField label="Width" value={box.width * 1000} unit="mm" onCommit={n => { const ratio = n / 1000 / box.width; if (ratio > 0) onCommit(transformSelection(scene, s => scaleShape(s, ratio, lockAspect ? ratio : 1, box.center))); }} />
        <TransformField label="Height" value={box.height * 1000} unit="mm" onCommit={n => { const ratio = n / 1000 / box.height; if (ratio > 0) onCommit(transformSelection(scene, s => scaleShape(s, lockAspect ? ratio : 1, ratio, box.center))); }} />
        <TransformField label="Rotation" value={shape.rotation} unit="°" onCommit={n => onCommit(transformSelection(scene, s => rotateShape(s, n - shape.rotation, box.center)))} />
        <label className="flow-lock-proportions"><input type="checkbox" aria-label="Lock proportions" checked={lockAspect} onChange={e => onLockAspect(e.target.checked)} />Lock proportions</label>
      </div>
      <label className="flow-clearance">Ground clearance<input key={box.minY.toFixed(5)} aria-label="Ground clearance" type="range" min="25" max={Math.floor((grid.height - .05 - box.height) * 1000)} step="5" defaultValue={Math.round(box.minY * 1000)} onPointerUp={e => clearance(e.currentTarget)} onKeyUp={e => clearance(e.currentTarget)} onBlur={e => clearance(e.currentTarget)} /></label>
      <div className="flow-shape-actions"><button onClick={onDuplicate}><Copy size={13} />Duplicate</button><button onClick={onDelete}><Trash2 size={13} />Delete</button></div>
    </>}
  </details>;
}
