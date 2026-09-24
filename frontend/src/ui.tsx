import type { ReactNode } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import type { Health, Run } from "./types";

export const fmt = (n: number | undefined, digits = 2) =>
  n === undefined ? "—" : n.toFixed(digits);
export const share = (part: number, total: number) =>
  total ? `${((100 * part) / total).toFixed(0)}%` : "—";
export const active = (r: Run) => ["running", "queued"].includes(r.status);

export function simulationProgress(
  run: Run,
  presets?: Health["presets"],
) {
  if (run.status === "queued")
    return { value: 0, detail: "Waiting in queue" };
  if (run.status === "completed") return { value: 100, detail: "Complete" };
  if (run.status !== "running") return null;
  if (run.stage === "Preparing") return { value: 2, detail: "Preparing" };

  const tier = run.stage.match(/^(fast|medium|precise):/)?.[1] as
      | "fast"
      | "medium"
      | "precise"
      | undefined,
    twoMeshes = run.settings.quality === "precise",
    start = twoMeshes ? (tier === "precise" ? 50 : 3) : 3,
    end = twoMeshes ? (tier === "precise" ? 98 : 49) : 98,
    span = end - start;
  let fraction = 0;
  if (run.stage.includes("Building tunnel")) fraction = 0.02;
  else if (run.stage.includes("Meshing car")) fraction = 0.08;
  else if (run.stage.includes("Checking mesh")) fraction = 0.28;
  else if (run.stage.includes("Partitioning mesh")) fraction = 0.33;
  else if (run.stage.includes("Solving airflow")) {
    const limit =
      presets?.[tier || run.settings.quality]?.iterations ||
      { fast: 300, medium: 1000, precise: 1800 }[
        tier || run.settings.quality
      ];
    fraction = 0.38 + 0.5 * Math.min(run.iteration / limit, 1);
    return {
      value: Math.round(start + span * fraction),
      detail: `Iteration ${run.iteration.toLocaleString()} of ${limit.toLocaleString()}`,
    };
  } else if (run.stage.includes("Reassembling results")) fraction = 0.91;
  else if (run.stage.includes("Preparing visualization")) fraction = 0.96;
  return {
    value: Math.round(start + span * fraction),
    detail:
      twoMeshes && tier
        ? `${tier[0].toUpperCase() + tier.slice(1)} mesh`
        : run.stage,
  };
}
// Optional parts differ between runs of one design, so labels name them.
export const parts = (r: Run) =>
  [
    ...(r.configuration?.added ?? []).map((n) => ` + ${n}`),
    r.configuration?.excluded.length
      ? ` − ${r.configuration.excluded.length} part${r.configuration.excluded.length > 1 ? "s" : ""}`
      : "",
  ].join("");
export const megabytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
export const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// Remembered per browser; storage can be unavailable (private windows), so
// every access falls back to the default.
export function remembered<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}
export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not persisted; the choice still applies for this session.
  }
}

// A collapsible sidebar section. The summary keeps the essentials visible
// while closed, so users do not have to open a section to check it.
export function Section({
  step,
  title,
  summary,
  open,
  onToggle,
  tone,
  action,
  children,
}: {
  step?: string;
  title: string;
  summary?: ReactNode;
  open: boolean;
  onToggle: () => void;
  tone?: "warning";
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`section ${open ? "open" : ""}`}>
      <div className="section-head">
        <button
          className="section-toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          {step && <span className="step">{step}</span>}
          <span className="section-text">
            <span className="section-title">{title}</span>
            {summary && (
              <span className={`section-summary ${tone || ""}`}>
                {tone && <AlertTriangle size={12} />}
                {summary}
              </span>
            )}
          </span>
          <ChevronDown size={15} className="chevron" />
        </button>
        {action}
      </div>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

export function Metric({
  title,
  value,
  unit,
  detail,
}: {
  title: string;
  value: string;
  unit: string;
  detail: string;
}) {
  return (
    <article className="metric">
      <span>{title}</span>
      <strong>
        {value} <small>{unit}</small>
      </strong>
      <p>{detail}</p>
    </article>
  );
}

export function Warnings({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="warnings">
      {items.map((w, i) => (
        <p key={i}>
          <AlertTriangle size={15} />
          {w}
        </p>
      ))}
    </div>
  );
}

export function History({
  history,
}: {
  history: { iteration: number; cd: number }[];
}) {
  const data = history.slice(-300);
  const values = data.map((p) => p.cd),
    min = Math.min(...values),
    max = Math.max(...values);
  return (
    <svg
      className="history"
      viewBox="0 0 450 100"
      role="img"
      aria-label="Drag coefficient convergence history"
    >
      <line className="axis" x1="0" y1="90" x2="450" y2="90" />
      <polyline
        className="trace"
        fill="none"
        strokeWidth="2"
        points={data
          .map(
            (p, i) =>
              `${(i / Math.max(1, data.length - 1)) * 450},${90 - ((p.cd - min) / (max - min || 1)) * 80}`,
          )
          .join(" ")}
      />
      <text x="3" y="12" fontSize="10">
        {max.toFixed(4)}
      </text>
      <text x="3" y="99" fontSize="10">
        {min.toFixed(4)}
      </text>
    </svg>
  );
}
