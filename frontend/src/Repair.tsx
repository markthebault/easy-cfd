import { useEffect, useMemo, useRef, useState } from "react";
import { X, Wrench, Download, RotateCcw } from "lucide-react";
import Viewer from "./Viewer";
import type { Project } from "./types";

type Opening = {
  id: string;
  part_id: string;
  part_name: string;
  span: number;
  perimeter: number;
  edges: number[][][];
  patch: number[][][];
  repairable: boolean;
  reason: string;
};
type Report = {
  revision: string;
  parts: {
    part_id: string;
    name: string;
    enabled: boolean;
    openings: Opening[];
    nonmanifold_edges: number;
    watertight: boolean;
  }[];
  added_triangles: number;
  remaining_openings: number;
  closed_parts: number;
  total_parts: number;
};
async function request<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.detail || "Repair request failed.");
  return data;
}
export default function Repair({
  project,
  theme,
  close,
  applied,
}: {
  project: Project;
  theme: string;
  close: () => void;
  applied: (p: Project) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const [report, setReport] = useState<Report | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [focus, setFocus] = useState("");
  const [preview, setPreview] = useState<Report | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const url = `/api/projects/${project.id}/repair`;
  useEffect(() => {
    let alive = true;
    request<Report>(url)
      .then((r) => {
        if (alive) setReport(r);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [url]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy, close]);
  const openings = useMemo(
    () => report?.parts.flatMap((p) => p.openings) || [],
    [report],
  );
  const overlay = useMemo(
    () => ({
      edges: openings
        .filter((o) => o.id !== focus && !(preview && selected.includes(o.id)))
        .flatMap((o) => o.edges),
      selectedEdges: openings
        .filter((o) => o.id === focus && !(preview && selected.includes(o.id)))
        .flatMap((o) => o.edges),
      patches: preview
        ? openings
            .filter((o) => selected.includes(o.id))
            .flatMap((o) => o.patch)
        : [],
    }),
    [openings, selected, focus, preview, done],
  );
  const run = async (apply: boolean) => {
    if (!report) return;
    setBusy(true);
    setError("");
    try {
      const body = { revision: report.revision, selected };
      if (apply) {
        const p = await request<Project>(url + "/apply", body);
        await applied(p);
        setDone(true);
      } else setPreview(await request<Report>(url + "/preview", body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const stats = preview || report;
  return (
    <div className="modal-backdrop repair-backdrop">
      <dialog
        ref={dialog}
        className="repair-dialog"
        aria-label="Repair openings"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) close();
        }}
      >
        <header className="repair-heading">
          <div>
            <span className="eyebrow">GEOMETRY WORKSHOP · FIRST VERSION</span>
            <h2>
              <Wrench size={21} /> Repair openings
            </h2>
          </div>
          <button
            autoFocus
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            <X size={16} /> Close
          </button>
        </header>
        <div className="repair-layout">
          <aside className="repair-controls">
            <p>
              Choose a rim, preview its cap, then apply. Existing surface
              vertices stay in place.
            </p>
            {stats && (
              <div className="repair-stats" aria-live="polite">
                <strong>
                  {done
                    ? "Repairs applied"
                    : `${stats.remaining_openings} ${stats.remaining_openings === 1 ? "opening" : "openings"} ${preview ? "remaining" : "found"}`}
                </strong>
                <span>
                  {stats.closed_parts} / {stats.total_parts} parts watertight
                </span>
              </div>
            )}
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            {busy && (
              <p role="status">
                {report ? "Checking patches…" : "Finding open edges…"}
              </p>
            )}
            {!done && (
              <div className="repair-openings">
                {report?.parts
                  .filter((part) => !part.watertight || part.openings.length)
                  .map((part) => (
                    <div key={part.part_id} className="repair-part">
                      <h3>
                        {part.name}{" "}
                        {!part.enabled && <small> · excluded from run</small>}
                      </h3>
                      {!part.openings.length && (
                        <p className="micro">
                          {part.watertight
                            ? "Closed surface"
                            : "No simple openings found"}
                        </p>
                      )}
                      {part.nonmanifold_edges > 0 && (
                        <p className="repair-warning">
                          {part.nonmanifold_edges} edges join more than two
                          faces. Requires manual repair.
                        </p>
                      )}
                      {part.openings.map((o, i) => (
                        <div
                          key={o.id}
                          className={`repair-opening ${focus === o.id ? "focused" : ""}`}
                        >
                          <div className="repair-opening-row">
                            <input
                              type="checkbox"
                              aria-label={`Select ${part.name} opening ${i + 1}`}
                              checked={selected.includes(o.id)}
                              disabled={busy || !o.repairable}
                              onChange={(e) => {
                                setSelected(
                                  e.target.checked
                                    ? [...selected, o.id]
                                    : selected.filter((s) => s !== o.id),
                                );
                                setFocus(o.id);
                                setPreview(null);
                              }}
                            />
                            <button
                              disabled={busy}
                              onClick={() => setFocus(o.id)}
                              aria-pressed={focus === o.id}
                            >
                              Opening {i + 1}
                              <small>
                                {(o.span * 1000).toFixed(1)} mm across ·{" "}
                                {o.edges.length} edges
                              </small>
                            </button>
                          </div>
                          {o.reason && (
                            <p className="repair-warning">{o.reason}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
              </div>
            )}
            {preview && (
              <div className="repair-summary" role="status">
                <strong>
                  {preview.added_triangles}{" "}
                  {preview.added_triangles === 1 ? "triangle" : "triangles"}{" "}
                  added · 0 vertices moved
                </strong>
                <p>
                  {done
                    ? "Green shows the applied caps."
                    : "Green shows the proposed caps."}{" "}
                  Check both sides and preserve intentional airflow gaps.
                </p>
              </div>
            )}
            {done ? (
              <>
                <p>
                  The geometry checks ran again. Review any remaining errors
                  before a simulation.
                </p>
                <a className="secondary repair-download" href={url + "/export"}>
                  <Download size={16} /> Download repaired STLs
                </a>
                <p className="micro">
                  Use Rotate & scale to change orientation or size. Download
                  and reimport these STLs to change source files. Your originals
                  are preserved.
                </p>
              </>
            ) : (
              <div className="repair-actions">
                <button
                  className="secondary"
                  disabled={busy || !selected.length}
                  onClick={() => {
                    setSelected([]);
                    setPreview(null);
                  }}
                >
                  <RotateCcw size={14} /> Reset selection
                </button>
                <button
                  className="primary"
                  disabled={busy || !selected.length}
                  onClick={() => run(!!preview)}
                >
                  {preview
                    ? "Apply repairs"
                    : `Preview ${selected.length || "selected"} ${selected.length === 1 ? "cap" : "caps"}`}
                </button>
              </div>
            )}
            {!done && project.geometry?.repaired && (
              <a className="secondary repair-download" href={url + "/export"}>
                <Download size={16} /> Download repaired STLs
              </a>
            )}
            <p className="micro">
              Only simple, nearly flat openings can be capped here. Curved tears
              and intersections need manual work. Watertightness does not
              establish CFD readiness.
            </p>
          </aside>
          <div className="repair-scene">
            <div className="repair-legend">
              <span className="rim-dot" /> Open rim{" "}
              <span className="selected-dot" /> Focused rim{" "}
              <span className="patch-dot" /> New cap
            </div>
            <Viewer
              geometry={project.geometry}
              geometryBase={`/api/projects/${project.id}/geometry`}
              field=""
              mode="geometry"
              axis="z"
              position={0}
              theme={theme}
              repairOverlay={overlay}
            />
            <p className="repair-scene-note">
              Drag to rotate · Scroll to zoom · Use Top or Side to inspect each
              cap
            </p>
          </div>
        </div>
      </dialog>
    </div>
  );
}
