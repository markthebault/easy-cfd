import { useEffect, useRef, useState } from "react";
import { X, Combine, Download, RotateCcw } from "lucide-react";
import Viewer from "./Viewer";
import type { Geometry, Project } from "./types";

const neutralOverlay = { edges: [], selectedEdges: [], patches: [] };

type Distance = { p95_mm: number; max_mm: number; samples: number };
type Preview = {
  token: string;
  geometry: Geometry;
  report: {
    source_components: number;
    result_components: number;
    watertight: boolean;
    can_apply: boolean;
    pitch_mm: number;
    gap_mm: number;
    effective_gap_mm: number;
    message: string;
    original_to_result: Distance;
    result_to_original: Distance;
    dimensions_before: number[];
    dimensions_after: number[];
    result_triangles: number;
  };
};
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(
    url,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Check the selected parts and resolution.",
    );
  return data;
}
export default function MergeSeal({
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
  const [revision, setRevision] = useState("");
  const [selected, setSelected] = useState<string[]>(
    () =>
      project.geometry?.parts
        .filter((p) => p.role === "body" && p.enabled !== false)
        .slice(0, 1)
        .map((p) => p.id) || [],
  );
  const [pitch, setPitch] = useState(20),
    [gap, setGap] = useState(40);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showOriginal, setShowOriginal] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [done, setDone] = useState(false);
  const token = useRef("");
  const original = useRef(project.geometry);
  const url = `/api/projects/${project.id}`;
  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;
    request<{ revision: string }>(url + "/seal")
      .then((r) => {
        if (alive) setRevision(r.revision);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
      if (token.current)
        void fetch(`${url}/seal-previews/${token.current}`, {
          method: "DELETE",
        });
    };
  }, [url]);
  const reset = () => {
    if (token.current)
      void fetch(`${url}/seal-previews/${token.current}`, { method: "DELETE" });
    token.current = "";
    setPreview(null);
    setShowOriginal(false);
    setError("");
  };
  const build = async () => {
    reset();
    setBusy(true);
    try {
      const result = await request<Preview>(url + "/seal/preview", {
        revision,
        part_ids: selected,
        pitch_mm: pitch,
        gap_mm: gap,
      });
      token.current = result.token;
      setPreview(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const p = await request<Project>(url + "/seal/apply", {
        token: preview.token,
      });
      token.current = "";
      await applied(p);
      setDone(true);
      setShowOriginal(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const report = preview?.report;
  const geometry = done
    ? project.geometry
    : preview && !showOriginal
      ? preview.geometry
      : original.current;
  const base =
    preview && !showOriginal && !done
      ? `${url}/seal-previews/${preview.token}/geometry`
      : `${url}/geometry`;
  return (
    <div className="modal-backdrop repair-backdrop">
      <dialog
        ref={dialog}
        className="repair-dialog"
        aria-label="Merge and seal"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) close();
        }}
      >
        <header className="repair-heading">
          <div>
            <span className="eyebrow">
              GEOMETRY WORKSHOP · SURFACE RECONSTRUCTION
            </span>
            <h2>
              <Combine size={21} /> Merge &amp; seal
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
          <aside className="repair-controls seal-controls">
            <p>
              Rebuild selected components as one closed body. This changes the
              surface. Keep wheels and intentional airflow gaps separate.
            </p>
            {!done && (
              <fieldset disabled={busy} className="seal-fields">
                <div
                  className="seal-parts"
                  role="group"
                  aria-label="Parts to merge"
                >
                  {project.geometry?.parts.map((p) => (
                    <label key={p.id} className="seal-part">
                      <input
                        type="checkbox"
                        aria-label={`Merge ${p.name}`}
                        checked={selected.includes(p.id)}
                        disabled={p.role === "wheel" || p.enabled === false}
                        onChange={(e) => {
                          reset();
                          setSelected(
                            e.target.checked
                              ? [...selected, p.id]
                              : selected.filter((id) => id !== p.id),
                          );
                        }}
                      />
                      <span>
                        {p.name}
                        <small>
                          {p.role === "wheel"
                            ? "Wheel · kept separate"
                            : `${p.grouped_components ?? 1} ${p.grouped_components === 1 || !p.grouped_components ? "component" : "components"}`}
                          {p.enabled === false ? " · disabled" : ""}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="input-pair">
                  <label className="input-label">
                    Resolution · mm
                    <input
                      aria-label="Seal resolution"
                      type="number"
                      min="5"
                      max="100"
                      step="5"
                      value={pitch}
                      onChange={(e) => {
                        reset();
                        setPitch(+e.target.value);
                      }}
                    />
                  </label>
                  <label className="input-label">
                    Gap target · mm
                    <input
                      aria-label="Seal gap target"
                      type="number"
                      min="0"
                      max="200"
                      step="5"
                      value={gap}
                      onChange={(e) => {
                        reset();
                        setGap(+e.target.value);
                      }}
                    />
                  </label>
                </div>
                <p className="micro">
                  Smaller resolution values preserve finer detail and use more
                  memory. Gap target is approximate; inspect intakes and wheel
                  arches.
                </p>
              </fieldset>
            )}
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            {busy && (
              <p role="status">
                {preview
                  ? "Saving sealed body…"
                  : "Rebuilding and measuring the surface…"}
              </p>
            )}
            {report && (
              <>
                <div className="repair-stats" aria-live="polite">
                  <strong>
                    {done
                      ? "Sealed body applied"
                      : `${report.source_components} → ${report.result_components} ${report.result_components === 1 ? "solid" : "solids"}`}
                  </strong>
                  <span>
                    {report.watertight
                      ? "Watertight surface"
                      : "Surface needs repair"}{" "}
                    · {report.result_triangles.toLocaleString()} triangles
                  </span>
                </div>
                <div className="seal-measurements">
                  <div>
                    <span>New → original surface</span>
                    <strong>
                      {report.result_to_original.p95_mm.toFixed(1)} mm
                    </strong>
                  </div>
                  <div>
                    <span>Original → new surface</span>
                    <strong>
                      {report.original_to_result.p95_mm.toFixed(1)} mm
                    </strong>
                  </div>
                  <p className="micro">
                    95th percentile of sampled distances, not an error bound.
                    Removed interior surfaces affect the second value. Largest
                    sampled distance:{" "}
                    {Math.max(
                      report.result_to_original.max_mm,
                      report.original_to_result.max_mm,
                    ).toFixed(1)}{" "}
                    mm.
                  </p>
                  <div>
                    <span>Gap target on this grid</span>
                    <strong>{report.effective_gap_mm.toFixed(0)} mm</strong>
                  </div>
                </div>
                <p className={report.can_apply ? "micro" : "repair-warning"}>
                  {report.message}
                </p>
                {!!preview.geometry.errors.length && (
                  <details className="seal-errors">
                    <summary>
                      {preview.geometry.errors.length} remaining geometry checks
                    </summary>
                    {preview.geometry.errors.map((e) => (
                      <p key={e} className="repair-warning">
                        {e}
                      </p>
                    ))}
                  </details>
                )}
              </>
            )}
            {done ? (
              <>
                <a
                  className="secondary repair-download"
                  href={url + "/repair/export"}
                >
                  <Download size={16} /> Download sealed STLs
                </a>
                <p className="micro">
                  Original files are preserved. Use Rotate & scale to change
                  orientation or size. Reimport to change source files. Check wheel roles
                  and road clearance before running CFD.
                </p>
              </>
            ) : (
              <div className="repair-actions">
                {preview && (
                  <button className="secondary" disabled={busy} onClick={reset}>
                    <RotateCcw size={14} /> Discard preview
                  </button>
                )}
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !revision ||
                    !selected.length ||
                    pitch < 5 ||
                    pitch > 100 ||
                    gap < 0 ||
                    gap > 200 ||
                    (!!preview && !report?.can_apply)
                  }
                  onClick={preview ? apply : build}
                >
                  {preview ? "Apply sealed body" : "Preview merged body"}
                </button>
              </div>
            )}
          </aside>
          <div className="repair-scene">
            <div className="seal-view-bar">
              <span>
                {done
                  ? "Applied surface"
                  : preview && !showOriginal
                    ? "Sealed preview"
                    : "Original components"}
              </span>
              {preview && !done && (
                <div
                  className="segmented"
                  role="group"
                  aria-label="Compare surfaces"
                >
                  <button
                    disabled={busy}
                    className={showOriginal ? "chosen" : ""}
                    aria-pressed={showOriginal}
                    onClick={() => setShowOriginal(true)}
                  >
                    Original
                  </button>
                  <button
                    disabled={busy}
                    className={!showOriginal ? "chosen" : ""}
                    aria-pressed={!showOriginal}
                    onClick={() => setShowOriginal(false)}
                  >
                    Sealed preview
                  </button>
                </div>
              )}
            </div>
            <Viewer
              repairOverlay={neutralOverlay}
              geometry={geometry}
              geometryBase={base}
              field=""
              mode="geometry"
              axis="z"
              position={0}
              theme={theme}
            />
            <p className="repair-scene-note">
              Compare silhouettes and gaps from several angles. No disconnected
              islands are discarded.
            </p>
          </div>
        </div>
      </dialog>
    </div>
  );
}
