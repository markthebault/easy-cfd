import {
  AlertTriangle,
  Box,
  Check,
  Layers,
  Play,
  Plus,
  Upload,
} from "lucide-react";
import { OrientationTools, PartList } from "./GeometryTools";
import { fmt, time } from "./ui";
import type {
  Health,
  ImportOptions,
  Part,
  Project,
  Run,
  Settings,
} from "./types";

export function DesignList({
  projects,
  runs,
  current,
  onPick,
}: {
  projects: Project[];
  runs: Run[];
  current?: string;
  onPick: (p: Project) => void;
}) {
  return (
    <div className="project-list">
      {projects.map((p) => {
        const count = runs.filter((r) => r.project_id === p.id).length;
        return (
          <button
            className={
              current === p.id ? "project-item selected" : "project-item"
            }
            key={p.id}
            onClick={() => onPick(p)}
          >
            <Box size={15} />
            <span className="project-text">
              <span className="project-name">{p.name}</span>
              {/* Names repeat across variants; parts, runs and date tell them apart. */}
              <small>
                {p.geometry ? `${p.geometry.parts.length} parts` : "No model"} ·{" "}
                {count} run{count === 1 ? "" : "s"} · {time(p.created)}
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function geometrySummary(project: Project) {
  const g = project.geometry;
  if (!g) return "No model yet";
  const on = g.parts.filter((p) => p.enabled !== false).length;
  return `${g.dimensions.map((d) => d.toFixed(2)).join(" × ")} m · ${on}/${g.parts.length} parts`;
}

export function GeometryBody({
  project,
  highlight,
  onHighlight,
  onImport,
  onReorient,
  onRole,
  onEnabled,
  onRemove,
}: {
  project: Project;
  highlight: string;
  onHighlight: (id: string) => void;
  onImport: (mode: "replace" | "add") => void;
  onReorient: (options: ImportOptions) => void;
  onRole: (part: Part, role: string, radius: number) => void;
  onEnabled: (ids: string[], enabled: boolean) => void;
  onRemove: (file: string) => void;
}) {
  const g = project.geometry;
  return (
    <>
      <div className="model-info">
        <Box size={20} />
        <div>
          <strong>{g ? "Model loaded" : "No model yet"}</strong>
          <small>
            {g
              ? `${g.parts.length} parts · ${g.triangles.toLocaleString()} triangles`
              : "STEP / STL"}
          </small>
        </div>
      </div>
      {g && (
        <>
          <div className="dimensions">
            {g.dimensions.map((d, i) => (
              <span key={i}>
                {["Length", "Width", "Height"][i]}
                <b>
                  {d.toFixed(2)} <small>m</small>
                </b>
              </span>
            ))}
          </div>
          <OrientationTools key={project.id} geometry={g} apply={onReorient} />
          <PartList
            design={project.id}
            geometry={g}
            highlight={highlight}
            onHighlight={onHighlight}
            onRole={onRole}
            onEnabled={onEnabled}
            onRemove={onRemove}
          />
          {g.errors.map((e, i) => (
            <p className="validation-error" key={i}>
              {e}
            </p>
          ))}
        </>
      )}
      <div className="button-row">
        <button className="secondary small" onClick={() => onImport("replace")}>
          <Upload size={13} /> Import STEP / STL
        </button>
        {g?.import_options && (
          <button className="secondary small" onClick={() => onImport("add")}>
            <Plus size={13} /> Add parts
          </button>
        )}
      </div>
      {g?.import_options && (
        <p className="micro">Add parts: wings, splitters and other options.</p>
      )}
    </>
  );
}

export function conditionsSummary(s: Settings) {
  return `${s.speed_kmh} km/h · ${s.yaw_deg}° yaw · ${s.reference_area} m²`;
}

export function ConditionsBody({
  settings,
  project,
  update,
}: {
  settings: Settings;
  project: Project;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  const estimate = project.geometry?.frontal_area_estimate;
  return (
    <>
      <label className="input-label">
        Road speed
        <div className="unit-input">
          <input
            aria-label="Road speed"
            type="number"
            min="5"
            max="300"
            value={settings.speed_kmh}
            onChange={(e) => update("speed_kmh", +e.target.value)}
          />
          <span>km/h</span>
        </div>
      </label>
      <div className="input-pair">
        <label className="input-label">
          Crosswind yaw
          <div className="unit-input">
            <input
              aria-label="Crosswind yaw"
              type="number"
              min="-20"
              max="20"
              value={settings.yaw_deg}
              onChange={(e) => update("yaw_deg", +e.target.value)}
            />
            <span>°</span>
          </div>
        </label>
        <label className="input-label">
          Reference area
          <div className="unit-input">
            <input
              aria-label="Reference area"
              type="number"
              step=".1"
              min=".01"
              value={settings.reference_area}
              onChange={(e) => update("reference_area", +e.target.value)}
            />
            <span>m²</span>
          </div>
        </label>
      </div>
      <p className="micro">
        Keep the same reference area when comparing designs. Drag is along the
        car&apos;s length.
      </p>
      {estimate ? (
        <p className="micro">
          Estimated frontal area ≈ {fmt(estimate)} m² (upper bound, ignores
          overlap between parts).{" "}
          <button
            className="link-button"
            onClick={() => update("reference_area", estimate)}
          >
            Use estimate
          </button>
        </p>
      ) : null}
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.moving_ground}
          onChange={(e) => update("moving_ground", e.target.checked)}
        />
        Moving road
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={settings.wheels}
          onChange={(e) => update("wheels", e.target.checked)}
        />
        Rotate identified wheels
      </label>
      <details className="plain-details">
        <summary>Air properties</summary>
        <label className="input-label">
          Density · kg/m³
          <input
            type="number"
            step=".001"
            min=".8"
            max="1.5"
            value={settings.density}
            onChange={(e) => update("density", +e.target.value)}
          />
        </label>
        <p className="micro">
          Inlet turbulence: 1%. Kinematic viscosity: 1.5 × 10⁻⁵ m²/s. Wheel axes
          are transverse to the car.
        </p>
      </details>
    </>
  );
}

// Always visible: the quality choice, the geometry confirmation and the reason
// a run cannot start, next to the button they gate.
export function RunBar({
  project,
  settings,
  update,
  health,
  estimate,
  busy,
  anyActive,
  dirty,
  onRun,
  onSave,
}: {
  project: Project;
  settings: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  health: Health | null;
  estimate: { previous_seconds: number | null } | null;
  busy: boolean;
  anyActive: boolean;
  dirty: boolean;
  onRun: () => void;
  onSave: () => void;
}) {
  const blocked = !health?.ready
    ? health?.message || "Waiting for the solver."
    : !project.geometry
      ? "Import a model first."
      : project.geometry.errors.length
        ? "Fix the geometry problems in 01 Geometry."
        : !settings.geometry_confirmed
          ? "Confirm the geometry check to run."
          : "";
  return (
    <div className="run-bar">
      <div className="run-bar-title">
        <span className="step">03</span> Run
      </div>
      <div className="quality-picker" role="group" aria-label="Quality">
        {(["fast", "medium", "precise"] as const).map((q) => (
          <button
            key={q}
            className={settings.quality === q ? "chosen" : ""}
            aria-pressed={settings.quality === q}
            onClick={() => update("quality", q)}
          >
            {q}
            <small>
              {q === "fast" ? "Explore" : q === "medium" ? "Compare" : "Refine"}
            </small>
          </button>
        ))}
      </div>
      <p className="micro quality-copy">
        {settings.quality === "fast"
          ? "Coarse mesh for a first look. Forces are provisional."
          : settings.quality === "medium"
            ? "Finer surface and wake resolution with boundary layers."
            : "Runs Medium and a finer mesh, then reports how the forces change."}{" "}
        <span className="nowrap">
          <Layers size={11} />{" "}
          {health?.presets[settings.quality]?.memory_gb ?? "—"} GB cap
        </span>
        {" · "}
        {estimate?.previous_seconds
          ? `about ${(estimate.previous_seconds / 60).toFixed(1)} min before`
          : "runtime not yet measured"}
        . Presets describe effort, not guaranteed accuracy.
      </p>
      {project.geometry && (
        <label className="check-row confirm">
          <input
            type="checkbox"
            checked={settings.geometry_confirmed}
            onChange={(e) => update("geometry_confirmed", e.target.checked)}
          />
          <span>I checked size, orientation, wheel roles, and clearance.</span>
        </label>
      )}
      <div className="run-actions">
        <button
          className="primary"
          onClick={onRun}
          disabled={busy || !!blocked}
        >
          <Play size={15} />
          {busy
            ? "Working…"
            : anyActive
              ? "Queue simulation"
              : "Run simulation"}
        </button>
        <button
          className="secondary"
          onClick={onSave}
          disabled={busy || !dirty}
          title="Save the setup without running"
        >
          {dirty ? "Save setup" : "Setup saved"} {!dirty && <Check size={12} />}
        </button>
      </div>
      {blocked && (
        <p className="blocked" role="status">
          <AlertTriangle size={12} /> {blocked}
        </p>
      )}
    </div>
  );
}
