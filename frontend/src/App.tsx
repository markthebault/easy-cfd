import { useEffect, useState } from "react";
import {
  Wind,
  Plus,
  Upload,
  Copy,
  Pencil,
  Play,
  Check,
  ChevronRight,
  ArrowDown,
  ArrowRight,
  Activity,
  Layers,
  Box,
  GitCompareArrows,
  Download,
  Square,
  AlertTriangle,
  Terminal,
  ExternalLink,
  X,
} from "lucide-react";
import Viewer from "./Viewer";
import BlenderGuide from "./BlenderGuide";
import {
  api,
  json,
  type Project,
  type Run,
  type Health,
  type Settings,
  type Comparison,
  type Part,
} from "./types";

const fmt = (n: number | undefined, digits = 2) =>
  n === undefined ? "—" : n.toFixed(digits);
const active = (r: Run) => ["running", "queued"].includes(r.status);

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState<Project | null>(null),
    [settings, setSettings] = useState<Settings | null>(null);
  const [runs, setRuns] = useState<Run[]>([]),
    [health, setHealth] = useState<Health | null>(null),
    [selected, setSelected] = useState("");
  const [tab, setTab] = useState("setup"),
    [field, setField] = useState("Pressure"),
    [mode, setMode] = useState("surface"),
    [axis, setAxis] = useState("y"),
    [position, setPosition] = useState(50),
    [sliceDraft, setSliceDraft] = useState(50);
  const [guideOpen, setGuideOpen] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [renaming, setRenaming] = useState(false),
    [designName, setDesignName] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [importing, setImporting] = useState(false),
    [logs, setLogs] = useState<Record<string, string> | null>(null);
  const [baseline, setBaseline] = useState(""),
    [variant, setVariant] = useState(""),
    [comparison, setComparison] = useState<Comparison | null>(null),
    [highlight, setHighlight] = useState("");
  const [estimate, setEstimate] = useState<{
    previous_seconds: number | null;
    message: string;
  } | null>(null);
  useEffect(() => {
    if (!project || !settings) return;
    let disposed = false;
    api<{ previous_seconds: number | null; message: string }>(
      `/projects/${project.id}/estimate?quality=${settings.quality}`,
    )
      .then((value) => {
        if (!disposed) setEstimate(value);
      })
      .catch(() => {
        if (!disposed) setEstimate(null);
      });
    return () => {
      disposed = true;
    };
  }, [
    project?.id,
    project?.geometry?.fingerprint,
    settings?.quality,
    runs.filter((r) => r.status === "completed").length,
  ]);
  const pick = (p: Project) => {
    setProject(p);
    setSettings(p.settings);
    setHighlight("");
  };
  const refresh = async () => {
    const [p, r] = await Promise.all([
      api<Project[]>("/projects"),
      api<Run[]>("/runs"),
    ]);
    setProjects(p);
    setRuns(r);
    return { p, r };
  };
  useEffect(() => {
    refresh()
      .then(({ p }) => {
        if (p.length) pick(p[0]);
      })
      .catch((e) => setError(e.message))
      .finally(() => setInitializing(false));
    api<Health>("/health")
      .then(setHealth)
      .catch((e) => setError(e.message));
    const t = setInterval(
      () =>
        api<Run[]>("/runs")
          .then((next) =>
            setRuns((previous) =>
              next.map((r) => {
                const old = previous.find((p) => p.id === r.id);
                return old && JSON.stringify(old) === JSON.stringify(r)
                  ? old
                  : r;
              }),
            ),
          )
          .catch(() => {}),
      2000,
    );
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setPosition(sliceDraft), 250);
    return () => clearTimeout(t);
  }, [sliceDraft]);
  useEffect(() => {
    setComparison(null);
    if (baseline && variant)
      api<Comparison>(`/compare?baseline=${baseline}&variant=${variant}`)
        .then(setComparison)
        .catch((e) => setError(e.message));
  }, [baseline, variant]);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = (wing = false) =>
    action(async () => {
      const p = await api<Project>(
        "/projects",
        json("POST", {
          name: wing ? "Sample car · rear wing" : "Sample car · baseline",
          sample: true,
          wing,
        }),
      );
      await refresh();
      pick(p);
      setTab("setup");
    });
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => (s ? { ...s, [key]: value } : s));
  const save = async () => {
    if (!project || !settings) return;
    const p = await api<Project>(
      `/projects/${project.id}/settings`,
      json("PUT", settings),
    );
    pick(p);
    await refresh();
  };
  const start = () =>
    action(async () => {
      await save();
      const r = await api<Run>(`/projects/${project!.id}/runs`, json("POST"));
      setSelected(r.id);
      await refresh();
      setTab("results");
    });
  const current =
    runs.find((r) => r.id === selected) ||
    runs.find((r) => r.project_id === project?.id);
  const completed = runs.filter((r) => r.status === "completed");
  const a = runs.find((r) => r.id === baseline),
    b = runs.find((r) => r.id === variant);
  const dirty = JSON.stringify(settings) !== JSON.stringify(project?.settings);
  const anyActive = runs.some(active);
  const conditions = (
    <div className="conditions">
      <span>
        {settings?.speed_kmh ?? 100}
        <small>km/h</small>
      </span>
      <i />
      <span>
        {settings?.yaw_deg ?? 0}°<small>crosswind yaw</small>
      </span>
      <i />
      <span>
        Air<small>incompressible · steady</small>
      </span>
    </div>
  );
  const controls = (
    <div className="result-controls">
      <label>
        Field
        <select
          aria-label="Field"
          value={field}
          onChange={(e) => setField(e.target.value)}
        >
          <option value="Pressure">Surface pressure</option>
          <option value="Speed">Air speed</option>
          <option value="Turbulence">Modeled turbulence</option>
        </select>
      </label>
      <label>
        View
        <select
          aria-label="View"
          value={mode}
          onChange={(e) => setMode(e.target.value)}
        >
          <option value="surface">Surface</option>
          <option value="streamlines">Flow lines</option>
          <option value="slice">Slice plane</option>
        </select>
      </label>
      {mode === "slice" && (
        <>
          <label>
            Plane
            <select
              aria-label="Plane"
              value={axis}
              onChange={(e) => setAxis(e.target.value)}
            >
              <option value="y">Longitudinal</option>
              <option value="z">Horizontal</option>
              <option value="x">Cross-section</option>
            </select>
          </label>
          <label className="slider-label">
            Slice position
            <input
              aria-label="Slice position"
              type="range"
              min="0"
              max="100"
              value={sliceDraft}
              onChange={(e) => setSliceDraft(+e.target.value)}
            />
          </label>
        </>
      )}
    </div>
  );
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Wind size={23} />
          </span>
          easy<span>cfd</span>
          <em>LOCAL WIND TUNNEL</em>
        </a>
        <button className="guide-trigger" onClick={() => setGuideOpen(true)}>Blender export guide</button>
        <div className="runtime">
          <span className={`dot ${health?.ready ? "green" : "amber"}`} />
          {health?.ready
            ? "OpenFOAM connected"
            : health?.message || "Checking solver…"}
          {health?.ready && (
            <small>
              {health.architecture} · {health.memory_gb} GB
            </small>
          )}
        </div>
        <button
          className="icon-button"
          title="Refresh solver status"
          onClick={() =>
            action(async () => setHealth(await api<Health>("/health")))
          }
        >
          <Activity size={17} />
        </button>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-title">
            WORKSPACE{" "}
            <button
              title="New sample project"
              onClick={() => create()}
              disabled={busy || initializing}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="project-list">
            {projects.map((p) => (
              <button
                className={
                  project?.id === p.id
                    ? "project-item selected"
                    : "project-item"
                }
                key={p.id}
                onClick={() => {
                  pick(p);
                  setSelected("");
                }}
              >
                <Box size={16} />
                <span>{p.name}</span>
                <ChevronRight size={13} />
              </button>
            ))}
            {!projects.length && (
              <p className="muted small">
                Your projects stay on this computer.
              </p>
            )}
          </div>
          <div className="sidebar-divider" />
          <div className="sidebar-title">
            SIMULATION SETUP <span className="step-count">01 — 03</span>
          </div>
          {project && settings ? (
            <fieldset className="setup-fields" disabled={busy || initializing}>
              <section className="setup-section">
                <h3>
                  <span>01</span> Geometry
                </h3>
                <div className="model-info">
                  <Box size={23} />
                  <div>
                    <strong>
                      {project.geometry ? "Model loaded" : "No model yet"}
                    </strong>
                    <small>
                      {project.geometry
                        ? `${project.geometry.parts.length} parts · ${project.geometry.triangles.toLocaleString()} triangles`
                        : "STEP / STL"}
                    </small>
                  </div>
                  <button
                    className="icon-button"
                    title="Import geometry"
                    onClick={() =>
                      action(async () => {
                        await save();
                        setImporting(true);
                      })
                    }
                  >
                    <Upload size={17} />
                  </button>
                </div>
                {project.geometry && (
                  <>
                    <div className="dimensions">
                      {project.geometry.dimensions.map((d, i) => (
                        <span key={i}>
                          {["Length", "Width", "Height"][i]}
                          <b>
                            {d.toFixed(2)} <small>m</small>
                          </b>
                        </span>
                      ))}
                    </div>
                    <div className="part-list">
                      {project.geometry.parts.map((part) => (
                        <PartRow
                          key={
                            project.id + project.geometry?.fingerprint + part.id
                          }
                          part={part}
                          highlighted={highlight === part.id}
                          onHighlight={() =>
                            setHighlight(highlight === part.id ? "" : part.id)
                          }
                          onChange={(role, radius) =>
                            action(async () => {
                              await save();
                              const p = await api<Project>(
                                `/projects/${project.id}/parts/${part.id}`,
                                json("PUT", { role, radius }),
                              );
                              pick(p);
                              await refresh();
                            })
                          }
                        />
                      ))}
                    </div>
                    {project.geometry.errors.map((e, i) => (
                      <p className="validation-error" key={i}>
                        {e}
                      </p>
                    ))}
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={settings.geometry_confirmed}
                        onChange={(e) =>
                          update("geometry_confirmed", e.target.checked)
                        }
                      />
                      <span>
                        I checked size, orientation, wheel roles, and clearance.
                      </span>
                    </label>
                  </>
                )}
                <button
                  className="text-button"
                  onClick={() =>
                    action(async () => {
                      await save();
                      setImporting(true);
                    })
                  }
                >
                  <Upload size={13} /> Import STEP / STL
                </button>
              </section>
              <section className="setup-section">
                <h3>
                  <span>02</span> Driving conditions
                </h3>
                <label className="input-label">
                  Road speed
                  <div className="unit-input">
                    <input
                      aria-label="Road speed"
                      type="number"
                      min="5"
                      max="250"
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
                        onChange={(e) =>
                          update("reference_area", +e.target.value)
                        }
                      />
                      <span>m²</span>
                    </div>
                  </label>
                </div>
                <p className="micro">
                  Keep the same reference area when comparing designs. Drag is
                  along the car's length.
                </p>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.moving_ground}
                    onChange={(e) => update("moving_ground", e.target.checked)}
                  />{" "}
                  Moving road
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={settings.wheels}
                    onChange={(e) => update("wheels", e.target.checked)}
                  />{" "}
                  Rotate identified wheels
                </label>
                <details>
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
                    Inlet turbulence: 1%. Kinematic viscosity: 1.5 × 10⁻⁵ m²/s.
                    Wheel axes are transverse to the car.
                  </p>
                </details>
              </section>
              <section className="setup-section">
                <h3>
                  <span>03</span> Simulation quality
                </h3>
                <div className="quality-picker">
                  {(["fast", "medium", "precise"] as const).map((q) => (
                    <button
                      key={q}
                      className={settings.quality === q ? "chosen" : ""}
                      onClick={() => update("quality", q)}
                    >
                      {q}
                      <small>
                        {q === "fast"
                          ? "Explore"
                          : q === "medium"
                            ? "Compare"
                            : "Refine"}
                      </small>
                    </button>
                  ))}
                </div>
                <p className="micro quality-copy">
                  {settings.quality === "fast"
                    ? "Coarse mesh for a first look. Forces are provisional."
                    : settings.quality === "medium"
                      ? "Finer surface and wake resolution with boundary layers."
                      : "Runs Medium and a finer mesh, then reports how the forces change."}
                </p>
                <div className="resource-budget">
                  <Layers size={14} />
                  {health?.presets[settings.quality]?.memory_gb ?? "—"} GB
                  solver memory cap
                </div>
                <p className="micro">
                  {estimate?.previous_seconds
                    ? `Previous matching runs: about ${(estimate.previous_seconds / 60).toFixed(1)} min. Conditions can change runtime.`
                    : "Runtime not yet measured for this model and preset."}{" "}
                  Presets describe effort, not guaranteed accuracy.
                </p>
              </section>
              <div className="run-actions">
                <button
                  className="primary"
                  onClick={start}
                  disabled={
                    busy ||
                    !health?.ready ||
                    !settings.geometry_confirmed ||
                    !!project.geometry?.errors.length ||
                    !project.geometry
                  }
                >
                  <Play size={16} />
                  {busy
                    ? "Working…"
                    : anyActive
                      ? "Queue simulation"
                      : "Run simulation"}
                </button>
                <button
                  className="text-button"
                  onClick={() => action(save)}
                  disabled={busy || !dirty}
                >
                  {dirty ? "Save setup" : "Setup saved"}{" "}
                  {!dirty && <Check size={12} />}
                </button>
              </div>
            </fieldset>
          ) : (
            <div className="sidebar-empty">
              <Wind size={35} />
              <p>Start with a sample car, then bring your own design.</p>
              <button
                className="primary"
                onClick={() => create()}
                disabled={busy || initializing}
              >
                Open sample car
              </button>
            </div>
          )}
          <div className="sidebar-foot">
            Open-source tools. Local files.
            <br />
            No uploads to a cloud service.
          </div>
        </aside>
        <main>
          <div className="page-heading">
            <div className="eyebrow">AERODYNAMICS / DESIGN STUDY</div>
            <div className="heading-row">
              <h1>
                {tab === "results" && current
                  ? current.name
                  : project?.name || "Your first wind tunnel"}
              </h1>
              <div className="heading-actions">
                <button
                  className="secondary"
                  title="Rename design"
                  disabled={!project || busy}
                  onClick={() => {
                    setDesignName(project!.name);
                    setRenaming(true);
                  }}
                >
                  <Pencil size={14} />
                  Rename
                </button>
                <button
                  className="secondary"
                  disabled={!project || busy}
                  onClick={() =>
                    action(async () => {
                      await save();
                      const p = await api<Project>(
                        `/projects/${project!.id}/duplicate`,
                        json("POST"),
                      );
                      await refresh();
                      pick(p);
                      setTab("setup");
                    })
                  }
                >
                  <Copy size={14} />
                  Duplicate design
                </button>
                {project?.sample && (
                  <button
                    className="secondary"
                    disabled={busy || initializing}
                    onClick={() =>
                      action(async () => {
                        const p = await api<Project>(
                          `/projects/${project.id}/sample?wing=${project.sample !== "wing"}`,
                          json("POST"),
                        );
                        await refresh();
                        pick(p);
                      })
                    }
                  >
                    {project.sample === "wing"
                      ? "Remove wing"
                      : "Add rear wing"}
                  </button>
                )}
              </div>
            </div>
            <p className="subtitle">
              Understand the airflow. Compare the change.
            </p>
          </div>
          {error && (
            <div className="alert error" role="alert">
              <AlertTriangle size={18} />
              <span>{error}</span>
              <button onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          <div className="main-tabs">
            <nav>
              {[
                ["setup", "Model & setup", Box],
                ["results", "Simulation results", Activity],
                ["compare", "Compare designs", GitCompareArrows],
              ].map(([id, label, Icon]) => (
                <button
                  key={String(id)}
                  className={tab === id ? "active" : ""}
                  onClick={() => setTab(String(id))}
                >
                  {typeof Icon !== "string" && <Icon size={16} />}{" "}
                  {String(label)}
                  {id === "results" && anyActive && (
                    <span className="live-dot" />
                  )}
                </button>
              ))}
            </nav>
            {tab === "setup" && (
              <span className="subtle-tag">GEOMETRY PREVIEW</span>
            )}
          </div>
          {tab === "setup" && (
            <>
              <div className="canvas-panel">
                <div className="panel-top">
                  {conditions}
                  <span className="muted small">
                    {project?.geometry?.errors.length
                      ? "Geometry needs attention"
                      : project?.geometry
                        ? "Ready for review"
                        : "Start with a sample"}
                  </span>
                </div>
                <Viewer
                  geometry={project?.geometry || null}
                  geometryBase={`/api/projects/${project?.id}/geometry`}
                  field={field}
                  mode="geometry"
                  axis={axis}
                  position={position}
                  highlight={highlight}
                />
              </div>
              <div className="intro-cards">
                <article>
                  <span className="card-icon">
                    <Wind size={20} />
                  </span>
                  <h3>See the flow</h3>
                  <p>
                    Explore pressure on the body, airflow paths, and slices
                    through the wake after a run.
                  </p>
                </article>
                <article>
                  <span className="card-icon">
                    <ArrowDown size={20} />
                  </span>
                  <h3>Measure the forces</h3>
                  <p>
                    Drag resists motion. Downforce pushes the car into the road.
                    View both in newtons.
                  </p>
                </article>
                <article>
                  <span className="card-icon">
                    <GitCompareArrows size={20} />
                  </span>
                  <h3>Test a design change</h3>
                  <p>
                    Duplicate this setup, change a part, and compare under the
                    same conditions.
                  </p>
                </article>
              </div>
              <div className="note">
                <AlertTriangle size={17} />
                <p>
                  {project?.sample
                    ? "The sample is a simplified demonstration car, not a validated vehicle model. "
                    : ""}
                  Closed surfaces are required. Review gaps, intersections, and
                  wheel clearance before running.
                </p>
              </div>
            </>
          )}
          {tab === "results" && (
            <>
              <div className="run-selector">
                <label>
                  Saved run
                  <select
                    aria-label="Saved run"
                    value={current?.id || ""}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    <option value="" disabled>
                      Select a run
                    </option>
                    {runs.map((r) => (
                      <option value={r.id} key={r.id}>
                        {r.name} · {r.settings.quality} · {r.status} ·{" "}
                        {new Date(r.created).toLocaleTimeString()}
                      </option>
                    ))}
                  </select>
                </label>
                {current && (
                  <>
                    <button
                      className="secondary"
                      onClick={() =>
                        action(async () =>
                          setLogs(
                            await api<Record<string, string>>(
                              `/runs/${current.id}/logs`,
                            ),
                          ),
                        )
                      }
                    >
                      <Terminal size={14} />
                      Logs
                    </button>
                    {!active(current) && (
                      <a
                        className="secondary"
                        href={`/api/runs/${current.id}/export`}
                      >
                        <Download size={14} />
                        Export run
                      </a>
                    )}
                  </>
                )}
              </div>
              {!current ? (
                <div className="empty-state">
                  <Activity size={38} />
                  <h2>No simulations yet</h2>
                  <p>
                    Review the model and run a simulation. Only calculated
                    results appear here.
                  </p>
                  <button className="secondary" onClick={() => setTab("setup")}>
                    Back to setup <ArrowRight size={15} />
                  </button>
                </div>
              ) : (
                <>
                  <div className={`run-status ${current.status}`}>
                    <span className="dot" />
                    <strong>{current.stage}</strong>
                    <span>
                      {current.settings.speed_kmh} km/h ·{" "}
                      {current.settings.quality} · iteration {current.iteration}
                    </span>
                    {active(current) && (
                      <button
                        className="secondary"
                        onClick={() =>
                          action(async () => {
                            await api(
                              `/runs/${current.id}/cancel`,
                              json("POST"),
                            );
                            await refresh();
                          })
                        }
                      >
                        <Square size={12} />
                        Cancel
                      </button>
                    )}
                  </div>
                  <p className="micro">
                    Saved output uses the conditions shown above. Changes in the
                    setup panel apply to the next run.
                  </p>
                  {current.error && (
                    <div className="alert error">
                      <AlertTriangle size={18} />
                      <pre>{current.error}</pre>
                    </div>
                  )}
                  {current.result ? (
                    <>
                      <div className="metric-grid">
                        <Metric
                          title="Drag"
                          value={fmt(current.result.drag)}
                          unit="N"
                          detail="Resistance along the car"
                        />
                        <Metric
                          title="Downforce"
                          value={fmt(current.result.downforce)}
                          unit="N"
                          detail="Positive means downward"
                        />
                        <Metric
                          title="Drag coefficient"
                          value={fmt(current.result.cd, 4)}
                          unit="Cd"
                          detail={`Reference area ${current.settings.reference_area} m²`}
                        />
                        <Metric
                          title="Lift coefficient"
                          value={fmt(current.result.cl, 4)}
                          unit="Cl"
                          detail="Negative means downforce"
                        />
                      </div>
                      <div className="canvas-panel">
                        {controls}
                        <Viewer
                          geometry={current.geometry}
                          geometryBase={`/api/runs/${current.id}/geometry`}
                          resultBase={`/api/runs/${current.id}`}
                          field={field}
                          mode={mode}
                          axis={axis}
                          position={position}
                          range={current.result.ranges[field]}
                          label={`${field} · calculated result`}
                        />
                      </div>
                      <div className="result-foot">
                        Flow lines show average flow, not time-resolved
                        turbulence. Wall speed is zero on stationary body
                        surfaces; use a slice to inspect surrounding air.
                      </div>
                      <div className="diagnostics">
                        <div>
                          <h3>Run checks</h3>
                          <p>
                            <Check size={14} /> Mesh passed geometric checks ·{" "}
                            {current.result.cells.toLocaleString()} cells
                          </p>
                          <p>
                            {current.result.force_settled ? (
                              <Check size={14} />
                            ) : (
                              <AlertTriangle size={14} />
                            )}{" "}
                            Forces{" "}
                            {current.result.force_settled
                              ? "settled"
                              : "still changing"}
                          </p>
                          <p>
                            {current.result.residual_converged ? (
                              <Check size={14} />
                            ) : (
                              <AlertTriangle size={14} />
                            )}{" "}
                            Residual target{" "}
                            {current.result.residual_converged
                              ? "reached"
                              : "not reached"}
                          </p>
                          <p>
                            Solver time:{" "}
                            {fmt(current.result.timings.simpleFoam / 60, 1)} min
                          </p>
                          {current.result.refinement && (
                            <p>
                              Mesh sensitivity: ΔCd{" "}
                              {fmt(current.result.refinement.delta_cd, 4)} · ΔCl{" "}
                              {fmt(current.result.refinement.delta_cl, 4)}
                            </p>
                          )}
                          <details>
                            <summary>Near-wall resolution · y+</summary>
                            {current.result.y_plus.map((v) => (
                              <p key={v.patch}>
                                {v.patch}: mean {fmt(v.mean, 1)}, range{" "}
                                {fmt(v.minimum, 1)}–{fmt(v.maximum, 1)}
                              </p>
                            ))}
                            <p className="micro">
                              Wall functions require appropriate near-wall
                              resolution. Inspect these values before trusting
                              forces.
                            </p>
                          </details>
                        </div>
                        <div>
                          <h3>Force history</h3>
                          <History history={current.result.history} />
                          <p className="micro">
                            Drag coefficient over solver iterations. Values are
                            averaged over the last 50 iterations, or all
                            available if fewer.
                          </p>
                        </div>
                      </div>
                      <Warnings items={current.result.warnings} />
                    </>
                  ) : (
                    <div className="canvas-panel">
                      <Viewer
                        geometry={current.geometry}
                        geometryBase={`/api/runs/${current.id}/geometry`}
                        field={field}
                        mode="geometry"
                        axis={axis}
                        position={position}
                        label="Geometry · awaiting calculated results"
                      />
                    </div>
                  )}
                </>
              )}
            </>
          )}
          {tab === "compare" && (
            <>
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
                        {r.name} · {r.settings.quality} · {r.id.slice(0, 6)}
                      </option>
                    ))}
                  </select>
                </label>
                <ArrowRight size={19} />
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
                          {r.name} · {r.settings.quality} · {r.id.slice(0, 6)}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              {comparison && a && b ? (
                <>
                  <Warnings items={comparison.warnings} />
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
                            <td>
                              {
                                (
                                  {
                                    drag: "Drag · N",
                                    downforce: "Downforce · N",
                                    cd: "Drag coefficient",
                                    cl: "Lift coefficient",
                                  } as Record<string, string>
                                )[key]
                              }
                            </td>
                            <td>{fmt(c.baseline, key.length === 2 ? 4 : 2)}</td>
                            <td>{fmt(c.variant, key.length === 2 ? 4 : 2)}</td>
                            <td>
                              {c.delta > 0 ? "+" : ""}
                              {fmt(c.delta, key.length === 2 ? 4 : 2)}{" "}
                              <small>
                                {c.percent === null
                                  ? "percentage unavailable"
                                  : `(${c.percent > 0 ? "+" : ""}${fmt(c.percent, 1)}%)`}
                              </small>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
                        sync="comparison"
                        label={i ? "Variant" : "Baseline"}
                      />
                    ))}
                  </div>
                  <p className="result-foot">
                    Cameras and color scales are synchronized. Differences are
                    measurements from these simulations, not a validated
                    performance claim.
                  </p>
                </>
              ) : (
                <div className="empty-state">
                  <GitCompareArrows size={38} />
                  <h2>One change. Same conditions.</h2>
                  <p>
                    Complete two runs, then compare their forces and airflow
                    side by side.
                  </p>
                </div>
              )}
            </>
          )}
          <footer>
            Easy CFD{" "}
            <span>
              OpenFOAM 2412 · Steady RANS · Research and design exploration
            </span>
            <a href="/docs" target="_blank" rel="noreferrer">
              Local API <ExternalLink size={11} />
            </a>
          </footer>
        </main>
      </div>
      {renaming && project && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Rename design"
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  await save();
                  const updated = await api<Project>(
                    `/projects/${project.id}/name`,
                    json("PUT", { name: designName }),
                  );
                  pick(updated);
                  await refresh();
                  setRenaming(false);
                });
              }}
            >
              <div className="modal-heading">
                <h2>Rename design</h2>
                <button type="button" onClick={() => setRenaming(false)}>
                  <X size={20} />
                </button>
              </div>
              <label className="input-label">
                Design name
                <input
                  aria-label="Design name"
                  autoFocus
                  required
                  maxLength={100}
                  value={designName}
                  onChange={(e) => setDesignName(e.target.value)}
                />
              </label>
              <button
                className="primary"
                disabled={busy || !designName.trim()}
                type="submit"
              >
                Save name
              </button>
            </form>
          </div>
        </div>
      )}
      {guideOpen && <BlenderGuide close={() => setGuideOpen(false)} />}
      {importing && project && (
        <ImportModal
          project={project}
          openGuide={() => setGuideOpen(true)}
          close={() => setImporting(false)}
          onImported={async (p) => {
            pick(p);
            await refresh();
            setImporting(false);
            setTab("setup");
          }}
        />
      )}
      {logs && (
        <div className="modal-backdrop">
          <div className="modal log-modal">
            <div className="modal-heading">
              <h2>Solver logs</h2>
              <button onClick={() => setLogs(null)}>
                <X />
              </button>
            </div>
            {Object.entries(logs).map(([name, text]) => (
              <details key={name}>
                <summary>{name}</summary>
                <pre>{text}</pre>
              </details>
            ))}
            {!Object.keys(logs).length && <p>No logs yet.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({
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
function Warnings({ items }: { items: string[] }) {
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
function History({
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
      viewBox="0 0 450 100"
      role="img"
      aria-label="Drag coefficient convergence history"
    >
      <line x1="0" y1="90" x2="450" y2="90" stroke="#dce3e3" />
      <polyline
        fill="none"
        stroke="#168877"
        strokeWidth="2"
        points={data
          .map(
            (p, i) =>
              `${(i / Math.max(1, data.length - 1)) * 450},${90 - ((p.cd - min) / (max - min || 1)) * 80}`,
          )
          .join(" ")}
      />
      <text x="3" y="12" fontSize="10" fill="#75838d">
        {max.toFixed(4)}
      </text>
      <text x="3" y="99" fontSize="10" fill="#75838d">
        {min.toFixed(4)}
      </text>
    </svg>
  );
}
function PartRow({
  part,
  highlighted,
  onHighlight,
  onChange,
}: {
  part: Part;
  highlighted: boolean;
  onHighlight: () => void;
  onChange: (role: string, radius: number) => void;
}) {
  const [radius, setRadius] = useState(
    part.wheel?.radius ||
      Math.max(0.01, (part.bounds[1][2] - part.bounds[0][2]) / 2),
  );
  return (
    <div className={`part-row ${highlighted ? "highlighted" : ""}`}>
      <button title="Highlight part" onClick={onHighlight}>
        {part.issues.length ? <AlertTriangle size={12} /> : <Box size={12} />}
        <span>{part.name}</span>
      </button>
      <select
        aria-label={`${part.name} role`}
        value={part.role}
        onChange={(e) => onChange(e.target.value, radius)}
      >
        <option value="body">Body</option>
        <option value="wheel">Wheel</option>
      </select>
      {part.role === "wheel" && (
        <label className="wheel-radius">
          Radius · m
          <input
            aria-label={`${part.name} radius`}
            type="number"
            min=".01"
            max="2"
            step=".01"
            value={radius}
            onChange={(e) => setRadius(+e.target.value)}
            onBlur={() => {
              if (radius !== part.wheel?.radius) onChange("wheel", radius);
            }}
          />
        </label>
      )}
    </div>
  );
}
function ImportModal({
  openGuide,
  project,
  close,
  onImported,
}: {
  project: Project;
  close: () => void;
  openGuide: () => void;
  onImported: (p: Project) => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]),
    [units, setUnits] = useState("m"),
    [forward, setForward] = useState("-X"),
    [up, setUp] = useState("+Z"),
    [clearance, setClearance] = useState(0.01),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      files.forEach((f) => body.append("files", f));
      body.append("options", JSON.stringify({ units, forward, up, clearance }));
      await onImported(
        await api<Project>(`/projects/${project.id}/import`, {
          method: "POST",
          body,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="modal-heading">
          <h2>Import your design</h2>
          <button onClick={close} disabled={busy}>
            <X size={20} />
          </button>
        </div>
        <p>
          Import the complete exterior assembly. This replaces the current
          model; saved runs keep their original geometry.
        </p>
        <button className="text-button" type="button" onClick={openGuide}>Preparing a model in Blender? Read the export guide</button>
        <label className="file-drop">
          <Upload size={27} />
          <strong>Choose STEP or STL files</strong>
          <span>Multiple parts · Up to 100 MB total</span>
          <input
            aria-label="Geometry files"
            type="file"
            multiple
            accept=".stl,.step,.stp"
            onChange={(e) => setFiles(Array.from(e.target.files || []))}
          />
        </label>
        {files.map((f, i) => (
          <p className="small" key={i}>
            {f.name} · {(f.size / 1024 / 1024).toFixed(1)} MB
          </p>
        ))}
        <div className="input-pair">
          <label className="input-label">
            STL units
            <select value={units} onChange={(e) => setUnits(e.target.value)}>
              <option value="m">Metres</option>
              <option value="mm">Millimetres</option>
              <option value="cm">Centimetres</option>
              <option value="in">Inches</option>
            </select>
          </label>
          <label className="input-label">
            Lowest point above road · m
            <input
              type="number"
              step=".005"
              min=".005"
              max="2"
              value={clearance}
              onChange={(e) => setClearance(+e.target.value)}
            />
          </label>
        </div>
        <div className="input-pair">
          <label className="input-label">
            Nose points toward
            <select
              value={forward}
              onChange={(e) => setForward(e.target.value)}
            >
              {["-X", "+X", "-Y", "+Y", "-Z", "+Z"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="input-label">
            Up direction
            <select value={up} onChange={(e) => setUp(e.target.value)}>
              {["+Z", "-Z", "+Y", "-Y", "+X", "-X"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="micro">
          STEP uses its embedded units. Parts keep their relative positions.
          Wheel centers initially use each part's bounding-box center; export
          separate wheels with transverse axes.
        </p>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        <button
          className="primary"
          disabled={busy || !files.length || forward[1] === up[1]}
          onClick={submit}
        >
          {busy ? "Checking geometry…" : "Import & check model"}
        </button>
      </div>
    </div>
  );
}
