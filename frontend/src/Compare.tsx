import type { ReactNode } from "react";
import { ArrowRight, GitCompareArrows, Layers } from "lucide-react";
import Viewer from "./Viewer";
import type { PlaneSettings } from "./planeFlow";
import { fmt, parts, Warnings } from "./ui";
import type { Comparison, Run } from "./types";

const LABELS: Record<string, string> = {
  drag: "Drag · N",
  downforce: "Downforce · N",
  cd: "Drag coefficient",
  cl: "Lift coefficient",
  body_drag: "Body drag · N",
  body_downforce: "Body downforce · N",
  wheels_drag: "Wheels drag · N",
  wheels_downforce: "Wheels downforce · N",
  pressure_drag: "Pressure drag · N",
  viscous_drag: "Viscous drag · N",
};
const digits = (key: string) => (key.length === 2 ? 4 : 2);
const signed = (n: number, d: number) => `${n > 0 ? "+" : ""}${fmt(n, d)}`;
const percent = (p: number | null) =>
  p === null ? "percentage unavailable" : `${p > 0 ? "+" : ""}${fmt(p, 1)}%`;

function label(r: Run) {
  return `${r.name}${parts(r)} · ${r.settings.quality} · ${r.id.slice(0, 6)}`;
}

export function CompareView({
  completed,
  baseline,
  variant,
  setBaseline,
  setVariant,
  comparison,
  controls,
  field,
  mode,
  axis,
  position,
  theme,
  plane,
}: {
  completed: Run[];
  baseline: string;
  variant: string;
  setBaseline: (id: string) => void;
  setVariant: (id: string) => void;
  comparison: Comparison | null;
  controls: ReactNode;
  field: string;
  mode: string;
  axis: string;
  position: number;
  theme: string;
  plane: PlaneSettings;
}) {
  const a = completed.find((r) => r.id === baseline),
    b = completed.find((r) => r.id === variant);
  const ready = comparison && a && b;
  return (
    <>
      <div className="fold">
        <div className="comparison-selectors">
          <label>
            Baseline
            <select
              aria-label="Baseline run"
              value={baseline}
              onChange={(e) => setBaseline(e.target.value)}
            >
              <option value="">Choose completed run</option>
              {completed.map((r) => (
                <option key={r.id} value={r.id}>
                  {label(r)}
                </option>
              ))}
            </select>
          </label>
          <ArrowRight size={18} />
          <label>
            Variant
            <select
              aria-label="Variant run"
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
            >
              <option value="">Choose completed run</option>
              {completed
                .filter((r) => r.id !== baseline)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {label(r)}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {ready ? (
          <>
            {/* Caveats sit with the numbers they qualify, never below the fold. */}
            <Warnings items={comparison.warnings} />
            <div className="delta-strip">
              {(["drag", "downforce", "cd", "cl"] as const).map((key) => {
                const c = comparison.changes[key];
                return (
                  <article className="delta" key={key}>
                    <span>{LABELS[key]}</span>
                    <strong>{signed(c.delta, digits(key))}</strong>
                    <small>
                      {percent(c.percent)} · {fmt(c.baseline, digits(key))} →{" "}
                      {fmt(c.variant, digits(key))}
                    </small>
                  </article>
                );
              })}
            </div>
            {comparison.parts && (
              <div className="parts-diff">
                <Layers size={14} />
                {comparison.parts.same ? (
                  <span>Same simulated geometry in both runs.</span>
                ) : !comparison.parts.only_baseline.length &&
                  !comparison.parts.only_variant.length ? (
                  <span>
                    Same parts, different geometry: shape, position, or
                    orientation changed.
                  </span>
                ) : (
                  <span>
                    {comparison.parts.only_variant.length > 0 &&
                      `Variant adds ${comparison.parts.only_variant.join(", ")}. `}
                    {comparison.parts.only_baseline.length > 0 &&
                      `Variant drops ${comparison.parts.only_baseline.join(", ")}.`}
                  </span>
                )}
              </div>
            )}
            <div className="canvas-panel fill">
              {controls}
              <div className="compare-viewers">
                {[a, b].map((r, i) => (
                  <Viewer
                    key={r.id + i}
                    geometry={r.geometry}
                    geometryBase={`/api/runs/${r.id}/geometry`}
                    resultBase={`/api/runs/${r.id}`}
                    field={field}
                    mode={mode}
                    axis={axis}
                    position={position}
                    range={comparison.ranges[field]}
                    theme={theme}
                    flow={plane}
                    sync="comparison"
                    label={i ? "Variant" : "Baseline"}
                  />
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-state">
            <GitCompareArrows size={38} />
            <h2>One change. Same conditions.</h2>
            <p>
              Complete two runs, then compare their forces and airflow side by
              side.
            </p>
          </div>
        )}
      </div>
      {ready && (
        <div className="details">
          <div className="comparison-table">
            <table>
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Baseline</th>
                  <th>Variant</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(comparison.changes).map(([key, c]) => (
                  <tr key={key}>
                    <td>{LABELS[key] || key}</td>
                    <td>{fmt(c.baseline, digits(key))}</td>
                    <td>{fmt(c.variant, digits(key))}</td>
                    <td>
                      {signed(c.delta, digits(key))}{" "}
                      <small>
                        {c.percent === null
                          ? percent(null)
                          : `(${percent(c.percent)})`}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="micro">
            Cameras and color scales are synchronized. Differences are
            measurements from these simulations, not a validated performance
            claim.
          </p>
        </div>
      )}
    </>
  );
}
