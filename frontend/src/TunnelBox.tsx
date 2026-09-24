import { useEffect, useState } from "react";
import type { Project, Settings, SimulationBox } from "./types";
import { api, json } from "./types";

export function useDomain(project: Project | null, settings: Settings | null) {
  const [preview, setPreview] = useState<{
    bounds: number[];
    error?: string | null;
    projectId: string;
    fingerprint: string;
  } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError("");
    if (!project?.geometry || !settings) {
      setPreview(null);
      setPending(false);
      return;
    }
    const timer = setTimeout(() => {
      api<{ bounds: number[]; error?: string | null }>(
        `/projects/${project.id}/domain-preview`,
        json("POST", settings),
      )
        .then((p) => {
          if (!cancelled) {
            setPreview({
              ...p,
              projectId: project.id,
              fingerprint: project.geometry!.fingerprint,
            });
            setError(p.error || "");
            setPending(false);
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setError(e.message);
            setPending(false);
          }
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [project?.id, project?.geometry, settings]);
  return {
    preview:
      preview?.projectId === project?.id &&
      preview?.fingerprint === project?.geometry?.fingerprint
        ? preview
        : null,
    error,
    pending,
  };
}

export default function TunnelBox({
  settings,
  bounds,
  error,
  update,
  visible,
  onVisible,
}: {
  settings: Settings;
  bounds?: number[];
  error: string;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  visible: boolean;
  onVisible: (value: boolean) => void;
}) {
  const box = settings.simulation_box;
  const fields: [keyof SimulationBox, string][] = [
    ["x_min", "Inlet X"],
    ["x_max", "Outlet X"],
    ["y_min", "Side Y minimum"],
    ["y_max", "Side Y maximum"],
    ["z_max", "Top Z"],
  ];
  return (
    <div className="tunnel-controls">
      <h3>Simulation box</h3>
      <label className="check-row">
        <input
          type="checkbox"
          checked={visible}
          onChange={(e) => onVisible(e.target.checked)}
        />
        Show box in 3D
      </label>
      <label className="input-label">
        Box size
        <select
          aria-label="Simulation box size"
          value={box ? "custom" : "automatic"}
          onChange={(e) => {
            if (e.target.value === "automatic") update("simulation_box", null);
            else if (bounds) {
              update("simulation_box", {
                x_min: bounds[0],
                x_max: bounds[1],
                y_min: bounds[2],
                y_max: bounds[3],
                z_max: bounds[5],
              });
              onVisible(true);
            }
          }}
        >
          <option value="automatic">Automatic · relative to model</option>
          <option value="custom" disabled={!bounds && !box}>
            Custom · exact coordinates
          </option>
        </select>
      </label>
      {box && (
        <div className="input-pair tunnel-inputs">
          {fields.map(([key, label]) => (
            <label className="input-label" key={key}>
              {label}
              <div className="unit-input">
                <input
                  type="number"
                  step="0.01"
                  aria-label={label}
                  value={box[key]}
                  onChange={(e) =>
                    update("simulation_box", { ...box, [key]: +e.target.value })
                  }
                />
                <span>m</span>
              </div>
            </label>
          ))}
        </div>
      )}
      {bounds && (
        <p className="micro" data-testid="box-dimensions">
          Box: {(bounds[1] - bounds[0]).toFixed(3)} ×{" "}
          {(bounds[3] - bounds[2]).toFixed(3)} × {bounds[5].toFixed(3)} m
        </p>
      )}
      <p className="micro">
        Floor at Z = 0. Air enters at minimum X and leaves at maximum X. Leave
        space around the model. Use Fit box, Front, Side and Top to inspect
        clearance.
      </p>
      {error && (
        <p className="validation-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
