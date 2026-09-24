import { useEffect, useMemo, useRef, useState } from "react";
import { X, Move3D, RotateCcw } from "lucide-react";
import vtkXMLPolyDataReader from "@kitware/vtk.js/IO/XML/XMLPolyDataReader";
import Viewer from "./Viewer";
import { rotatedBounds, transformMatrix } from "./transformMath";
import type { Geometry, Project } from "./types";

type Preview = { token: string; geometry: Geometry };
const neutral = { edges: [], selectedEdges: [], patches: [] };
const format = (v: number) =>
  Number.isFinite(v) ? Number(v.toFixed(6)).toString() : "";
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
  if (!res.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Check the transformation values.",
    );
  return data;
}
function Dimension({
  label,
  value,
  step,
  change,
  validity,
  disabled,
}: {
  label: string;
  value: number;
  step: number;
  change: (v: number) => boolean;
  validity: (valid: boolean) => void;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState(false),
    [draft, setDraft] = useState("");
  return (
    <label className="input-label">
      {label}
      <input
        aria-label={label}
        type="number"
        min="0.000001"
        step={step}
        disabled={disabled}
        value={editing ? draft : format(value)}
        onFocus={() => {
          setDraft(format(value));
          setEditing(true);
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = e.target.valueAsNumber;
          validity(Number.isFinite(v) && v > 0 && change(v));
        }}
        onBlur={() => {
          setEditing(false);
          validity(true);
        }}
      />
    </label>
  );
}
export default function Transform({
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
  const dialog = useRef<HTMLDialogElement>(null),
    token = useRef("");
  const original = useRef(project.geometry!);
  const [points, setPoints] = useState<Record<string, ArrayLike<number>>>({});
  const [revision, setRevision] = useState(""),
    [scope, setScope] = useState("all");
  const [rotation, setRotation] = useState([0, 0, 0]),
    [translation, setTranslation] = useState([0, 0, 0]);
  const [scale, setScale] = useState(1),
    [keepClearance, setKeepClearance] = useState(true),
    [unit, setUnit] = useState("m");
  const [preview, setPreview] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  const [error, setError] = useState(""),
    [valid, setValid] = useState(true);
  const url = `/api/projects/${project.id}`;
  useEffect(() => {
    dialog.current?.showModal();
    const abort = new AbortController();
    Promise.all([
      request<{ revision: string }>(url + "/transform"),
      Promise.all(
        original.current.parts.map(async (p) => {
          const response = await fetch(`${url}/geometry/${p.id}.vtp`, {
            signal: abort.signal,
          });
          if (!response.ok)
            throw new Error("Could not load object dimensions.");
          const reader = vtkXMLPolyDataReader.newInstance();
          try {
            reader.parseAsArrayBuffer(await response.arrayBuffer());
            return [
              p.id,
              Float64Array.from(reader.getOutputData().getPoints().getData()),
            ] as const;
          } finally {
            reader.delete();
          }
        }),
      ),
    ])
      .then(([r, arrays]) => {
        if (!abort.signal.aborted) {
          setRevision(r.revision);
          setPoints(Object.fromEntries(arrays));
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => {
      abort.abort();
      if (token.current)
        void fetch(`${url}/transform-previews/${token.current}`, {
          method: "DELETE",
        });
    };
  }, [url]);
  const ids = useMemo(
    () =>
      original.current.parts
        .filter((p) => scope === "all" || p.id === scope)
        .map((p) => p.id),
    [scope],
  );
  const bounds = useMemo(
    () =>
      ids.every((id) => points[id])
        ? rotatedBounds(
            ids.map((id) => points[id]),
            rotation,
          )
        : null,
    [points, ids, rotation],
  );
  const dimensions = bounds?.dimensions.map((v) => v * scale) || [0, 0, 0];
  const finite =
    [scale, ...rotation, ...translation].every(Number.isFinite) &&
    scale >= 0.0001 &&
    scale <= 10000;
  const matrices = useMemo(
    () =>
      bounds && finite && !done
        ? Object.fromEntries(
            ids.map((id) => [
              id,
              transformMatrix(bounds, scale, translation, keepClearance),
            ]),
          )
        : undefined,
    [bounds, scale, translation, keepClearance, ids, finite, done],
  );
  const clearPreview = () => {
    if (token.current)
      void fetch(`${url}/transform-previews/${token.current}`, {
        method: "DELETE",
      });
    token.current = "";
    setPreview(null);
    setError("");
  };
  const change = () => clearPreview();
  const reset = () => {
    clearPreview();
    setRotation([0, 0, 0]);
    setTranslation([0, 0, 0]);
    setScale(1);
    setValid(true);
  };
  const review = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await request<Preview>(url + "/transform/preview", {
        revision,
        part_ids: ids,
        rotation,
        translation,
        scale,
        keep_clearance: keepClearance,
      });
      token.current = data.token;
      setPreview(data);
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
      const p = await request<Project>(url + "/transform/apply", {
        token: preview.token,
      });
      token.current = "";
      await applied(p);
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const multiplier = unit === "mm" ? 1000 : unit === "cm" ? 100 : 1;
  return (
    <div className="modal-backdrop repair-backdrop">
      <dialog
        ref={dialog}
        className="repair-dialog"
        aria-label="Rotate and scale"
        onCancel={(e) => {
          e.preventDefault();
          if (!busy) close();
        }}
      >
        <header className="repair-heading">
          <div>
            <span className="eyebrow">GEOMETRY WORKSHOP · LIVE DIMENSIONS</span>
            <h2>
              <Move3D size={21} /> Rotate &amp; scale
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
          <aside className="repair-controls transform-controls">
            <fieldset
              className="seal-fields"
              disabled={busy || done || !bounds}
            >
              <label className="input-label">
                Object
                <select
                  aria-label="Object to transform"
                  value={scope}
                  onChange={(e) => {
                    reset();
                    setScope(e.target.value);
                  }}
                >
                  <option value="all">Whole model · all objects</option>
                  {original.current.parts.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.enabled === false ? " · excluded from run" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="transform-dimensions">
                <div className="transform-dimensions-title">
                  <strong>Live dimensions</strong>
                  <select
                    aria-label="Dimension units"
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  >
                    <option value="m">m</option>
                    <option value="cm">cm</option>
                    <option value="mm">mm</option>
                  </select>
                </div>
                {["Length · X", "Width · Y", "Height · Z"].map((label, i) => (
                  <Dimension
                    key={label + unit + scope}
                    label={label}
                    value={dimensions[i] * multiplier}
                    step={multiplier * 0.001}
                    disabled={!bounds || done || busy}
                    validity={setValid}
                    change={(v) => {
                      const factor =
                        v / multiplier / (bounds?.dimensions[i] || 1);
                      if (factor < 0.0001 || factor > 10000) return false;
                      change();
                      setScale(factor);
                      return true;
                    }}
                  />
                ))}
                <p className="micro">
                  Enter a real dimension. Proportions stay locked; the other two
                  dimensions update immediately.
                </p>
              </div>
              <label className="input-label">
                Scale factor
                <input
                  aria-label="Scale factor"
                  type="number"
                  min=".0001"
                  max="10000"
                  step=".01"
                  value={Number.isFinite(scale) ? scale : ""}
                  onChange={(e) => {
                    change();
                    setScale(e.target.valueAsNumber);
                  }}
                />
              </label>
              <input
                aria-label="Scale slider"
                type="range"
                min=".1"
                max="3"
                step=".001"
                value={Math.max(0.1, Math.min(3, scale || 1))}
                onChange={(e) => {
                  change();
                  setScale(+e.target.value);
                }}
              />
              <h3>Rotate · degrees</h3>
              {["X", "Y", "Z"].map((axis, i) => (
                <div key={axis} className="transform-axis">
                  <label>
                    {axis}
                    <input
                      aria-label={`Rotate ${axis}`}
                      type="number"
                      step="1"
                      value={Number.isFinite(rotation[i]) ? rotation[i] : ""}
                      onChange={(e) => {
                        change();
                        setRotation(
                          rotation.map((v, j) =>
                            j === i ? e.target.valueAsNumber : v,
                          ),
                        );
                      }}
                    />
                  </label>
                  <button
                    className="secondary small"
                    onClick={() => {
                      change();
                      setRotation(
                        rotation.map((v, j) => (j === i ? v + 90 : v)),
                      );
                    }}
                  >
                    +90° {axis}
                  </button>
                </div>
              ))}
              <p className="micro">
                Around the selected centre, in X, Y, Z order. X is length, Y is
                width, Z is up.
              </p>
              <details>
                <summary>Move · metres</summary>
                {["X", "Y", "Z"].map((axis, i) => (
                  <label key={axis} className="input-label">
                    {axis}
                    <input
                      aria-label={`Move ${axis}`}
                      type="number"
                      step=".01"
                      value={
                        Number.isFinite(translation[i]) ? translation[i] : ""
                      }
                      onChange={(e) => {
                        change();
                        setTranslation(
                          translation.map((v, j) =>
                            j === i ? e.target.valueAsNumber : v,
                          ),
                        );
                      }}
                    />
                  </label>
                ))}
              </details>
              <label className="transform-checkbox">
                <input
                  type="checkbox"
                  checked={keepClearance}
                  onChange={(e) => {
                    change();
                    setKeepClearance(e.target.checked);
                  }}
                />{" "}
                Keep the lowest point at its current height
              </label>
              <p className="micro">
                Vertical movement is added after this adjustment. Unselected
                objects stay in place.
              </p>
            </fieldset>
            {!bounds && !error && (
              <p role="status">Loading surface dimensions…</p>
            )}
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            {(!valid || !finite) && (
              <p className="repair-warning">
                Enter positive dimensions and a scale between 0.0001 and 10000.
              </p>
            )}
            {preview && (
              <div className="repair-summary" role="status">
                <strong>
                  {done
                    ? "Changes applied"
                    : preview.geometry.errors.length
                      ? "Review geometry checks"
                      : "Geometry checks passed"}
                </strong>
                {preview.geometry.errors.map((e) => (
                  <p key={e}>{e}</p>
                ))}
                {!preview.geometry.errors.length && (
                  <p>
                    Review the shape and wheel placement before running CFD.
                  </p>
                )}
              </div>
            )}
            {!done && (
              <div className="repair-actions">
                <button className="secondary" disabled={busy} onClick={reset}>
                  <RotateCcw size={14} /> Reset changes
                </button>
                <button
                  className="primary"
                  disabled={busy || !bounds || !revision || !valid || !finite}
                  onClick={preview ? apply : review}
                >
                  {busy
                    ? "Checking geometry…"
                    : preview
                      ? "Apply changes"
                      : "Review changes"}
                </button>
              </div>
            )}
          </aside>
          <div className="repair-scene">
            <div className="seal-view-bar">
              <strong>{done ? "Applied geometry" : "Live preview"}</strong>
              <span>Uniform scale · proportions locked</span>
            </div>
            <Viewer
              geometry={done ? project.geometry : original.current}
              geometryBase={`${url}/geometry`}
              modelTransforms={matrices}
              repairOverlay={neutral}
              field=""
              mode="geometry"
              axis="z"
              position={0}
              theme={theme}
            />
            <div
              className="transform-size-badge"
              role="status"
              aria-label="Live object dimensions"
            >
              {bounds && finite
                ? dimensions.map((v) => format(v * multiplier)).join(" × ") +
                  " " +
                  unit
                : "Loading dimensions…"}
              <small>Length × width × height · selected objects</small>
            </div>
            <p className="repair-scene-note">
              The surface and dimensions update as you edit. Use 3D to fit the
              model in view.
            </p>
          </div>
        </div>
      </dialog>
    </div>
  );
}
