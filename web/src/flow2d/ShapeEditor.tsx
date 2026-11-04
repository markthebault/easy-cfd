import { useEffect, useRef, useState, type PointerEvent } from "react";
import { screenPoint, worldPoint, type Camera, type Viewport } from "./render";
import { bounds, moveShape, replaceShape, rotateShape, scaleShape, selectInBox, selectedShape, selectedShapes, transformSelection, withCurve, type Scene, type Shape } from "./scene";
import { curvePath, ellipse, mapNode, simplify, tangent, type CurveNode, type DrawTool } from "./curves";
import { type Point } from "./geometry";

export type EditMode = "select" | "points" | "draw";
type Side = "incoming" | "outgoing";
type Drag = { before: Scene; kind: "move" | "rotate" | "resize" | "point" | "control"; start: Point; index: number; changed: boolean; side?: Side; axes?: [number, number] };
type Sketch = { before: CurveNode[]; restore: CurveNode[]; kind: "anchor" | "tangent" | "control" | "rectangle" | "ellipse" | "freehand"; start: Point; index: number; side?: Side; changed: boolean; points?: Point[] };
type Marquee = { before: Scene; start: Point; additive: boolean; pointerId: number; changed: boolean };
const handles: { name: string; axes: [number, number] }[] = [
  { name: "top left", axes: [-1, 1] }, { name: "top", axes: [0, 1] }, { name: "top right", axes: [1, 1] }, { name: "right", axes: [1, 0] },
  { name: "bottom right", axes: [1, -1] }, { name: "bottom", axes: [0, -1] }, { name: "bottom left", axes: [-1, -1] }, { name: "left", axes: [-1, 0] },
];
function keyDelta(key: string, step = .005): Point | undefined { return ({ ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: step }, ArrowDown: { x: 0, y: -step } } as Record<string, Point>)[key]; }
export function ShapeEditor({ scene, mode, draft, tool, snap, lockAspect, panMode, camera, viewport: v, onPan, onSelect, onPreview, onCommit, onDraft, onClose, onDragging }: {
  scene: Scene; mode: EditMode; draft: CurveNode[]; tool: DrawTool; snap: boolean; lockAspect: boolean; panMode: boolean; camera: Camera; viewport: Viewport;
  onPan: (pan: Point) => void; onSelect: (id: string, additive?: boolean) => void; onPreview: (scene: Scene) => void;
  onCommit: (scene: Scene, before: Scene) => void; onDraft: (points: CurveNode[]) => void; onClose: () => void; onDragging: (dragging: boolean) => void;
}) {
  const svg = useRef<SVGSVGElement>(null), drag = useRef<Drag | null>(null), sketch = useRef<Sketch | null>(null), current = useRef(scene);
  const pan = useRef<{ start: Point; before: Point } | null>(null), space = useRef(false), closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = useRef(onClose); close.current = onClose;
  const anchorClicks = useRef<{ point: Point; time: number; count: number } | null>(null);
  const marquee = useRef<Marquee | null>(null), [selectionBox, setSelectionBox] = useState<{ start: Point; end: Point } | null>(null);
  current.current = scene;
  const selection = selectedShapes(scene), selected = selectedShape(scene), box = selection.length ? bounds(selection.flatMap(s => s.points)) : null, drawing = mode === "draw";
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Escape") cancelMarquee(); if (e.code === "Space" && !(e.target as HTMLElement).closest("input,select,textarea,button")) { e.preventDefault(); space.current = true; } };
    const up = (e: KeyboardEvent) => { if (e.code === "Space") space.current = false; };
    const blur = () => { space.current = false; cancelMarquee(); };
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", blur);
    return () => { clearTimeout(closeTimer.current); window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  }, []);
  useEffect(() => { clearTimeout(closeTimer.current); }, [mode, tool]);
  useEffect(() => { clearTimeout(closeTimer.current); }, [draft]);
  useEffect(() => { if (mode !== "select" || panMode) cancelMarquee(); }, [mode, panMode]);
  const local = (e: { clientX: number; clientY: number }) => { const r = svg.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const origin = (e: { clientX: number; clientY: number }) => worldPoint(local(e), v);
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) * v.scale;
  const project = (p: Point) => screenPoint(p, v);
  const format = (points: Point[]) => points.map(p => { const q = project(p); return `${q.x},${q.y}`; }).join(" ");
  const hitDraft = (p: Point) => draft.findIndex(q => distance(p, q) <= 7);
  const capture = (e: PointerEvent) => { e.preventDefault(); svg.current!.setPointerCapture(e.pointerId); onDragging(true); };
  function cancelMarquee() {
    const active = marquee.current; if (!active) return;
    marquee.current = null; setSelectionBox(null); current.current = active.before; onPreview(active.before); onDragging(false);
    if (svg.current?.hasPointerCapture(active.pointerId)) svg.current.releasePointerCapture(active.pointerId);
  }
  function begin(e: PointerEvent, id: string, kind: Drag["kind"], index = -1, side?: Side, axes?: [number, number]) {
    if (e.button !== 0 || panMode || space.current) return;
    e.preventDefault(); e.stopPropagation();
    if (kind === "move" && (e.shiftKey || e.metaKey || e.ctrlKey)) { onSelect(id, true); return; }
    const keepGroup = ["move", "rotate", "resize"].includes(kind) && selection.some(s => s.id === id);
    const before = keepGroup ? scene : { ...scene, selectedId: id, selectedIds: [id] };
    if (!keepGroup) onSelect(id);
    drag.current = { before: structuredClone(before), kind, index, side, axes, start: origin(e), changed: false }; capture(e);
  }
  function editNode(shape: Shape, index: number, change: (p: CurveNode) => CurveNode) {
    return shape.curve ? withCurve(shape, shape.curve.map((p, i) => i === index ? change(p) : p)) : { ...shape, points: shape.points.map((p, i) => i === index ? change(p) : p) };
  }
  function removePoint(index: number, inDraft = false) {
    clearTimeout(closeTimer.current);
    anchorClicks.current = null;
    if (inDraft) onDraft(draft.filter((_, i) => i !== index));
    else if (selected) onCommit(replaceShape(scene, selected.curve ? withCurve(selected, selected.curve.filter((_, i) => i !== index)) : { ...selected, points: selected.points.filter((_, i) => i !== index) }), scene);
  }
  function resize(before: Scene, delta: Point, axes: [number, number], proportional: boolean) {
    const b = bounds(selectedShapes(before).flatMap(s => s.points)), [hx, hy] = axes;
    let sx = hx ? Math.max(.01 / b.width, 1 + delta.x * hx / b.width) : 1, sy = hy ? Math.max(.01 / b.height, 1 + delta.y * hy / b.height) : 1;
    if (proportional) { const ratio = !hx ? sy : !hy ? sx : Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy; sx = ratio; sy = ratio; }
    const pivot = { x: hx > 0 ? b.minX : hx < 0 ? b.maxX : b.center.x, y: hy > 0 ? b.minY : hy < 0 ? b.maxY : b.center.y };
    return transformSelection(before, s => scaleShape(s, sx, sy, pivot));
  }
  function controls(nodes: CurveNode[], inDraft: boolean) {
    return nodes.flatMap((node, i) => (["incoming", "outgoing"] as const).filter(side => node[side]).map(side => {
      const a = project(node), b = project(node[side]!);
      const change = (p: Point, mirror = true) => { const update = (n: CurveNode) => tangent(n, side, p, mirror); if (inDraft) onDraft(draft.map((n, j) => j === i ? update(n) : n)); else onCommit(replaceShape(scene, editNode(selected!, i, update)), scene); };
      return <g key={`${i}-${side}`}><line className="flow-tangent-line" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
        <circle className="flow-tangent-handle" cx={b.x} cy={b.y} r="4" role="button" tabIndex={0} aria-label={`${inDraft ? "Drawing" : "Bézier"} ${side} handle ${i + 1}`}
          onPointerDown={e => { if (!inDraft) { begin(e, selected!.id, "control", i, side); return; } if (e.button !== 0) return; e.stopPropagation(); clearTimeout(closeTimer.current); sketch.current = { before: structuredClone(draft), restore: structuredClone(draft), kind: "control", start: origin(e), index: i, side, changed: false }; capture(e); }}
          onContextMenu={e => { e.preventDefault(); e.stopPropagation(); const update = (n: CurveNode) => { const next = { ...n }; delete next[side]; return next; }; if (inDraft) onDraft(draft.map((n, j) => j === i ? update(n) : n)); else onCommit(replaceShape(scene, editNode(selected!, i, update)), scene); }}
          onKeyDown={e => { const d = keyDelta(e.key); if (d) { e.preventDefault(); e.stopPropagation(); change({ x: node[side]!.x + d.x, y: node[side]!.y + d.y }, !e.altKey); } }} />
      </g>;
    }));
  }
  return <svg ref={svg} className={`flow-edit-overlay ${drawing ? "drawing" : ""} ${panMode ? "panning" : ""} ${selectionBox ? "selecting" : ""}`} viewBox={`0 0 ${v.width} ${v.height}`} aria-label="Profile drawing area"
    onPointerDownCapture={e => { if (e.button === 1 || e.button === 0 && (panMode || space.current)) { e.stopPropagation(); capture(e); pan.current = { start: local(e), before: { ...camera.pan } }; } }}
    onPointerDown={e => {
      if (!drawing && e.target === e.currentTarget && e.button === 0) {
        if (mode === "select") { marquee.current = { before: scene, start: origin(e), additive: e.shiftKey || e.metaKey || e.ctrlKey, pointerId: e.pointerId, changed: false }; capture(e); }
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) { const next = { ...scene, selectedId: null, selectedIds: [] }; current.current = next; onPreview(next); }
        return;
      }
      if (!drawing || e.button !== 0) return;
      clearTimeout(closeTimer.current);
      let p = origin(e); const hit = hitDraft(p), pen = tool === "line" || tool === "bezier";
      if (pen && hit >= 0) { const previous = anchorClicks.current, now = performance.now(); anchorClicks.current = { point: draft[hit], time: now, count: previous && now - previous.time < 600 && distance(previous.point, draft[hit]) < 7 ? previous.count + 1 : 1 }; sketch.current = { before: structuredClone(draft), restore: structuredClone(draft), kind: "anchor", start: p, index: hit, changed: false }; capture(e); return; }
      if (pen && draft.length >= 3 && distance(p, draft[0]) <= 9) { onClose(); return; }
      if (p.x < .04 || p.x > v.domain.width - .05 || p.y < .025 || p.y > v.domain.height - .05) return;
      if (snap) { const target = scene.shapes.flatMap(s => s.curve ?? s.points).find(q => distance(p, q) < 8); if (target) p = { x: target.x, y: target.y }; }
      if (pen && draft.length >= (tool === "bezier" ? 64 : 256)) return;
      anchorClicks.current = null;
      const next = pen ? [...draft, p] : [p];
      sketch.current = { before: structuredClone(next), restore: structuredClone(draft), kind: pen ? tool === "bezier" ? "tangent" : "anchor" : tool, start: p, index: next.length - 1, changed: false, points: [p] };
      onDraft(next); capture(e);
    }}
    onContextMenu={e => {
      if (drawing) { e.preventDefault(); const hit = hitDraft(origin(e)); if (hit >= 0) removePoint(hit, true); }
      else if (mode === "points" && selected && e.target === e.currentTarget) { const hit = (selected.curve ?? selected.points).findIndex(p => distance(p, origin(e)) <= 8); if (hit >= 0) { e.preventDefault(); removePoint(hit); } }
    }}
    onDoubleClick={e => {
      if (drawing && (anchorClicks.current?.count ?? 0) >= 2) { const hit = hitDraft(origin(e)); if (hit >= 0) { e.preventDefault(); removePoint(hit, true); } }
      // Root pointer capture retargets native double-clicks to the SVG in some
      // browsers, so also resolve editable anchors by their screen position.
      else if (mode === "points" && selected) { const hit = (selected.curve ?? selected.points).findIndex(p => distance(p, origin(e)) <= 8); if (hit >= 0) { e.preventDefault(); removePoint(hit); } }
    }}
    onPointerMove={e => {
      if (pan.current) { const p = local(e); onPan({ x: pan.current.before.x + p.x - pan.current.start.x, y: pan.current.before.y + p.y - pan.current.start.y }); return; }
      const p = origin(e), drawingDrag = sketch.current;
      if (marquee.current) {
        const active = marquee.current; if (!active.changed && distance(p, active.start) < 3) return;
        active.changed = true; setSelectionBox({ start: active.start, end: p });
        const next = selectInBox(active.before, active.start, p, active.additive); current.current = next; onPreview(next); return;
      }
      if (drawingDrag) {
        if (distance(p, drawingDrag.start) < 2 && !drawingDrag.changed) return;
        drawingDrag.changed = true;
        const { before, start, index, kind } = drawingDrag;
        if (kind === "rectangle" || kind === "ellipse") {
          let end = p;
          if (e.shiftKey) { const size = Math.max(Math.abs(p.x - start.x), Math.abs(p.y - start.y)); end = { x: start.x + Math.sign(p.x - start.x) * size, y: start.y + Math.sign(p.y - start.y) * size }; }
          onDraft(kind === "ellipse" ? ellipse(start, end) : [{ ...start }, { x: end.x, y: start.y }, { ...end }, { x: start.x, y: end.y }]);
        } else if (kind === "freehand") { const points = drawingDrag.points!; if (points.length < 512 && distance(p, points.at(-1)!) >= 3) { points.push(p); onDraft([...points]); } }
        else onDraft(before.map((node, i) => i !== index ? node : kind === "control" ? tangent(node, drawingDrag.side!, p, !e.altKey) : kind === "tangent" ? tangent(node, "outgoing", p, !e.altKey) : mapNode(node, q => ({ x: q.x + p.x - start.x, y: q.y + p.y - start.y }))));
        return;
      }
      const active = drag.current; if (!active || distance(p, active.start) < 2 && !active.changed) return;
      active.changed = true;
      const { before, start } = active, shape = selectedShape(before)!;
      let next = before;
      if (active.kind === "move") next = transformSelection(before, s => moveShape(s, p.x - start.x, p.y - start.y));
      if (active.kind === "rotate") { const center = bounds(selectedShapes(before).flatMap(s => s.points)).center; let degrees = (Math.atan2(p.y - center.y, p.x - center.x) - Math.atan2(start.y - center.y, start.x - center.x)) * 180 / Math.PI; if (e.shiftKey) degrees = Math.round(degrees / 15) * 15; next = transformSelection(before, s => rotateShape(s, degrees, center)); }
      if (active.kind === "resize") next = resize(before, { x: p.x - start.x, y: p.y - start.y }, active.axes!, lockAspect || e.shiftKey);
      if (active.kind === "point") next = replaceShape(before, editNode(shape, active.index, node => mapNode(node, q => ({ x: q.x + p.x - start.x, y: q.y + p.y - start.y }))));
      if (active.kind === "control") next = replaceShape(before, editNode(shape, active.index, node => tangent(node, active.side!, p, !e.altKey)));
      // Pointer-up can precede React's next render in WebKit. Commit the last
      // pointer position rather than whichever preview React has painted yet.
      current.current = next; onPreview(next);
    }}
    onPointerUp={e => {
      if (pan.current) { pan.current = null; onDragging(false); return; }
      if (marquee.current) { const active = marquee.current; marquee.current = null; setSelectionBox(null); onDragging(false); if (active.changed) { const next = selectInBox(active.before, active.start, origin(e), active.additive); current.current = next; onPreview(next); } return; }
      const active = drag.current, drawingDrag = sketch.current; drag.current = null; sketch.current = null; onDragging(false);
      if (active?.changed) onCommit(current.current, active.before);
      if (drawingDrag?.kind === "freehand" && drawingDrag.changed) onDraft(simplify(drawingDrag.points!, 1.5 / v.scale));
      if (drawingDrag?.kind === "anchor" && !drawingDrag.changed && drawingDrag.index === 0 && drawingDrag.before.length >= 3 && drawingDrag.restore.length === drawingDrag.before.length) closeTimer.current = setTimeout(() => close.current(), 350);
    }}
    onPointerCancel={() => { cancelMarquee(); if (drag.current) onPreview(drag.current.before); if (sketch.current) onDraft(sketch.current.restore); drag.current = null; sketch.current = null; pan.current = null; onDragging(false); }}>
    {!drawing && scene.shapes.map(shape => <polygon key={shape.id} points={format(shape.points)} className="flow-shape-hit" role="button" aria-label={`Select ${shape.name}`} aria-pressed={selection.some(s => s.id === shape.id)} tabIndex={0}
      onPointerDown={e => begin(e, shape.id, "move")} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(shape.id, e.shiftKey); return; } const d = keyDelta(e.key, e.shiftKey ? .025 : .005); if (d) { e.preventDefault(); const before = selection.some(s => s.id === shape.id) ? scene : { ...scene, selectedId: shape.id, selectedIds: [shape.id] }; onCommit(transformSelection(before, s => moveShape(s, d.x, d.y)), scene); } }} />)}
    {mode === "select" && selected && box && (() => {
      const lo = project({ x: box.minX, y: box.maxY }), hi = project({ x: box.maxX, y: box.minY }), handle = { x: (lo.x + hi.x) / 2, y: lo.y - 30 };
      return <g className="flow-selection"><rect x={lo.x - 7} y={lo.y - 7} width={hi.x - lo.x + 14} height={hi.y - lo.y + 14} rx="4" /><line x1={handle.x} y1={lo.y - 7} x2={handle.x} y2={handle.y} />
        <rect className="flow-selection-hit" x={lo.x - 7} y={lo.y - 7} width={hi.x - lo.x + 14} height={hi.y - lo.y + 14} rx="4" role="button" aria-label="Move selected shapes" tabIndex={0} onPointerDown={e => begin(e, selected.id, "move")} onKeyDown={e => { const d = keyDelta(e.key, e.shiftKey ? .025 : .005); if (d) { e.preventDefault(); onCommit(transformSelection(scene, s => moveShape(s, d.x, d.y)), scene); } }} />
        <circle className="flow-rotation-handle" role="button" aria-label="Rotate selected shape" tabIndex={0} cx={handle.x} cy={handle.y} r="7" onPointerDown={e => begin(e, selected.id, "rotate")} onKeyDown={e => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); onCommit(transformSelection(scene, s => rotateShape(s, e.key === "ArrowLeft" ? 1 : -1, box.center)), scene); } }}><title>Drag to rotate · Shift snaps to 15°</title></circle>
        {handles.map(({ name, axes: [hx, hy] }) => <rect key={name} className={`flow-resize-handle resize-${name.replace(" ", "-")}`} role="button" aria-label={`Resize ${name}`} tabIndex={0} x={(hx < 0 ? lo.x - 7 : hx > 0 ? hi.x + 7 : (lo.x + hi.x) / 2) - 4} y={(hy > 0 ? lo.y - 7 : hy < 0 ? hi.y + 7 : (lo.y + hi.y) / 2) - 4} width="8" height="8" rx="1.5"
          onPointerDown={e => begin(e, selected.id, "resize", -1, undefined, [hx, hy])} onKeyDown={e => { const d = keyDelta(e.key); if (d) { e.preventDefault(); onCommit(resize(scene, d, [hx, hy], lockAspect || e.shiftKey), scene); } }}><title>Drag to resize · Shift keeps proportions</title></rect>)}
      </g>;
    })()}
    {mode === "points" && selected && <>{selected.curve && controls(selected.curve, false)}{(selected.curve ?? selected.points).map((p, i) => { const q = project(p); return <circle key={i} cx={q.x} cy={q.y} r={v.width < 600 ? 6 : 4.5} className="flow-handle" role="button" aria-label={`Profile point ${i + 1}`} tabIndex={0}
      onPointerDown={e => begin(e, selected.id, "point", i)} onContextMenu={e => { e.preventDefault(); removePoint(i); }} onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); removePoint(i); }}
      onKeyDown={e => { const d = keyDelta(e.key); if (d) { e.preventDefault(); e.stopPropagation(); onCommit(replaceShape(scene, editNode(selected, i, node => mapNode(node, q => ({ x: q.x + d.x, y: q.y + d.y })))), scene); } if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.stopPropagation(); removePoint(i); } }} />; })}</>}
    {drawing && <><path d={curvePath(draft, project, tool === "rectangle" || tool === "ellipse")} className="flow-draft" />{controls(draft, true)}{draft.length >= 3 && <circle cx={project(draft[0]).x} cy={project(draft[0]).y} r="4.5" className="flow-close-zone" />}{draft.map((p, i) => { const q = project(p); return <circle key={i} cx={q.x} cy={q.y} r="3" className="flow-drawing-point" role="button" tabIndex={0} aria-label={`Drawing point ${i + 1}`} onKeyDown={e => { if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removePoint(i, true); } }} />; })}</>}
    {selectionBox && (() => { const a = project(selectionBox.start), b = project(selectionBox.end); return <rect className="flow-marquee" aria-label="Selection box" x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} />; })()}
  </svg>;
}
