import { Circle, PenTool, Pencil, RectangleHorizontal, Spline } from "lucide-react";
import type { DrawTool } from "./curves";

const tools = [
  { id: "line", name: "Lines", icon: PenTool, title: "Click to place straight outline points" },
  { id: "bezier", name: "Bézier", icon: Spline, title: "Click for a corner; drag for a smooth curve" },
  { id: "rectangle", name: "Rectangle", icon: RectangleHorizontal, title: "Drag a rectangle; Shift draws a square" },
  { id: "ellipse", name: "Ellipse", icon: Circle, title: "Drag an ellipse; Shift draws a circle" },
  { id: "freehand", name: "Freehand", icon: Pencil, title: "Trace an outline with the mouse or pen" },
] as const;
export function DrawTools({ tool, snap, onTool, onSnap }: { tool: DrawTool; snap: boolean; onTool: (tool: DrawTool) => void; onSnap: (value: boolean) => void }) {
  return <div className="flow-draw-tools glass" role="toolbar" aria-label="Drawing tools"><div>{tools.map(({ id, name, icon: Icon, title }) => <button key={id} aria-label={`${name} drawing tool`} title={title} aria-pressed={tool === id} className={tool === id ? "selected" : ""} onClick={() => onTool(id)}><Icon size={16} /><span>{name}</span></button>)}</div><label><input type="checkbox" checked={snap} onChange={e => onSnap(e.target.checked)} />Snap to points</label></div>;
}
