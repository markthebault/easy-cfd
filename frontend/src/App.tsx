import { useEffect, useState } from "react";
import {
  Wind,
  Plus,
  Upload,
  Copy,
  Pencil,
  Activity,
  Box,
  GitCompareArrows,
  AlertTriangle,
  ExternalLink,
  X,
  Sun,
  Moon,
  Monitor,
  BookOpen,
  RefreshCw,
  Pause,
  Play,
} from "lucide-react";
import Viewer from "./Viewer";
import BlenderGuide from "./BlenderGuide";
import {
  ConditionsBody,
  conditionsSummary,
  DesignList,
  GeometryBody,
  geometrySummary,
  RunBar,
} from "./Setup";
import { ResultsView, RunActions, RunList } from "./Results";
import type { PlaneSettings } from "./planeFlow";
import { CompareView } from "./Compare";
import { active, remember, remembered, Section } from "./ui";
import {
  api,
  json,
  type Project,
  type Run,
  type Health,
  type Settings,
  type Comparison,
  type ImportOptions,
} from "./types";

type Theme = "system" | "light" | "dark";
const THEMES: Theme[] = ["system", "light", "dark"];
const dark = () => window.matchMedia?.("(prefers-color-scheme: dark)").matches;

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
    [importing, setImporting] = useState<"" | "replace" | "add">(""),
    [logs, setLogs] = useState<Record<string, string> | null>(null);
  const [baseline, setBaseline] = useState(""),
    [variant, setVariant] = useState(""),
    [comparison, setComparison] = useState<Comparison | null>(null),
    [highlight, setHighlight] = useState("");
  const [history, setHistory] = useState<{
    run: string;
    points: { iteration: number; cd: number }[];
  } | null>(null);
  const [historyFailed, setHistoryFailed] = useState("");
  const [estimate, setEstimate] = useState<{
    previous_seconds: number | null;
    message: string;
  } | null>(null);
  // Layout preferences, remembered per browser.
  const [theme, setTheme] = useState<Theme>(() =>
      remembered<Theme>("easycfd-theme", "system"),
    ),
    [systemDark, setSystemDark] = useState(dark),
    [section, setSection] = useState(() =>
      remembered<string>("easycfd-section", "geometry"),
    ),
    [designsOpen, setDesignsOpen] = useState(
      () => remembered<string>("easycfd-designs", "closed") === "open",
    ),
    [runScope, setRunScope] = useState<"design" | "all">("design"),
    // Animated plane view; starts paused for people who ask for less motion.
    [plane, setPlane] = useState<PlaneSettings>(() => ({
      playing: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
      speed: 1,
      tracers: 3500,
    }));
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(media.matches);
    media?.addEventListener("change", listener);
    return () => media?.removeEventListener("change", listener);
  }, []);
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    remember("easycfd-theme", theme);
  }, [theme]);
  // One setup section open at a time keeps the Run area in view.
  const toggleSection = (id: string) => {
    const next = section === id ? "" : id;
    setSection(next);
    remember("easycfd-section", next);
  };
  const toggleDesigns = () => {
    setDesignsOpen(!designsOpen);
    remember("easycfd-designs", designsOpen ? "closed" : "open");
  };
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
  // Geometry edits save pending settings first, as other project changes do.
  const edit = (change: () => Promise<Project>) =>
    action(async () => {
      await save();
      pick(await change());
      await refresh();
    });
  const reorient = (options: ImportOptions) =>
    edit(() =>
      api<Project>(
        `/projects/${project!.id}/import-options`,
        json("PUT", options),
      ),
    );
  const start = () =>
    action(async () => {
      await save();
      const r = await api<Run>(`/projects/${project!.id}/runs`, json("POST"));
      setSelected(r.id);
      await refresh();
      setTab("results");
    });
  const scoped =
    runScope === "all"
      ? runs
      : runs.filter((r) => r.project_id === project?.id);
  const current =
    runs.find((r) => r.id === selected) ||
    runs.find((r) => r.project_id === project?.id);
  const completed = runs.filter((r) => r.status === "completed");
  // The polled run list omits force history; load it once per completed run
  // shown, retrying with backoff so a brief connection failure recovers.
  useEffect(() => {
    if (current?.status !== "completed" || history?.run === current.id) return;
    const id = current.id;
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) =>
      api<Run>(`/runs/${id}`)
        .then((r) => {
          if (disposed) return;
          setHistory({ run: id, points: r.result?.history ?? [] });
          setHistoryFailed("");
        })
        .catch(() => {
          if (disposed) return;
          setHistoryFailed(id);
          timer = setTimeout(
            () => load(attempt + 1),
            Math.min(2000 * 2 ** attempt, 30000),
          );
        });
    load(0);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [current?.id, current?.status]);
  const dirty = JSON.stringify(settings) !== JSON.stringify(project?.settings);
  const anyActive = runs.some(active);
  const openImport = (mode: "replace" | "add") =>
    action(async () => {
      await save();
      setImporting(mode);
    });
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
          <option value="plane">Animated plane</option>
        </select>
      </label>
      {(mode === "slice" || mode === "plane") && (
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
      {mode === "plane" && (
        <>
          <button
            className="secondary small"
            onClick={() => setPlane({ ...plane, playing: !plane.playing })}
          >
            {plane.playing ? <Pause size={13} /> : <Play size={13} />}
            {plane.playing ? "Pause" : "Play"}
          </button>
          <label className="slider-label">
            Motion {plane.speed}×
            <input
              aria-label="Animation speed"
              type="range"
              min="0.25"
              max="4"
              step="0.25"
              value={plane.speed}
              onChange={(e) => setPlane({ ...plane, speed: +e.target.value })}
            />
          </label>
          <label>
            Tracers
            <select
              aria-label="Tracers"
              value={plane.tracers}
              onChange={(e) => setPlane({ ...plane, tracers: +e.target.value })}
            >
              {[1500, 3500, 6000, 9000].map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  const designs = (
    <Section
      title="Designs"
      summary={
        designsOpen
          ? `${projects.length} on this computer`
          : project?.name || `${projects.length} designs`
      }
      open={designsOpen}
      onToggle={toggleDesigns}
      action={
        <button
          className="icon-button"
          title="New sample project"
          onClick={() => create()}
          disabled={busy || initializing}
        >
          <Plus size={16} />
        </button>
      }
    >
      <DesignList
        projects={projects}
        runs={runs}
        current={project?.id}
        onPick={(p) => {
          pick(p);
          setSelected("");
        }}
      />
      {!projects.length && (
        <p className="micro">Your projects stay on this computer.</p>
      )}
    </Section>
  );
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">
            <Wind size={20} />
          </span>
          easy<span>cfd</span>
        </a>
        <em className="brand-tag">Local wind tunnel</em>
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
          <button
            className="icon-button"
            title="Refresh solver status"
            onClick={() =>
              action(async () => setHealth(await api<Health>("/health")))
            }
          >
            <RefreshCw size={14} />
          </button>
        </div>
        <button className="guide-trigger" onClick={() => setGuideOpen(true)}>
          <BookOpen size={14} /> Blender export guide
        </button>
        <button
          className="icon-button"
          title={`Theme: ${theme}. Click to change.`}
          aria-label={`Theme: ${theme}`}
          onClick={() =>
            setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length])
          }
        >
          <ThemeIcon size={16} />
        </button>
      </header>
      <div className={`workspace ${tab === "compare" ? "wide" : ""}`}>
        {tab !== "compare" && (
          <aside className="sidebar">
            <div className="sidebar-scroll">
              {designs}
              {!project || !settings ? (
                <div className="sidebar-empty">
                  <Wind size={32} />
                  <p>Start with a sample car, then bring your own design.</p>
                  <button
                    className="primary"
                    onClick={() => create()}
                    disabled={busy || initializing}
                  >
                    Open sample car
                  </button>
                </div>
              ) : tab === "setup" ? (
                <fieldset
                  className="setup-fields"
                  disabled={busy || initializing}
                >
                  <Section
                    step="01"
                    title="Geometry"
                    summary={
                      project.geometry?.errors.length
                        ? `${project.geometry.errors.length} problem${project.geometry.errors.length > 1 ? "s" : ""} to fix`
                        : geometrySummary(project)
                    }
                    tone={
                      project.geometry?.errors.length ? "warning" : undefined
                    }
                    open={section === "geometry"}
                    onToggle={() => toggleSection("geometry")}
                  >
                    <GeometryBody
                      project={project}
                      highlight={highlight}
                      onHighlight={setHighlight}
                      onImport={openImport}
                      onReorient={reorient}
                      onRole={(part, role, radius) =>
                        edit(() =>
                          api<Project>(
                            `/projects/${project.id}/parts/${part.id}`,
                            json("PUT", { role, radius }),
                          ),
                        )
                      }
                      onEnabled={(part_ids, enabled) =>
                        edit(() =>
                          api<Project>(
                            `/projects/${project.id}/parts-enabled`,
                            json("PUT", { part_ids, enabled }),
                          ),
                        )
                      }
                      onRemove={(file) => {
                        const name = project.geometry?.sources?.find(
                          (s) => s.file === file,
                        )?.name;
                        if (
                          window.confirm(
                            `Remove ${name} from this design? Saved runs are not affected.`,
                          )
                        )
                          edit(() =>
                            api<Project>(
                              `/projects/${project.id}/sources/${encodeURIComponent(file)}`,
                              json("DELETE"),
                            ),
                          );
                      }}
                    />
                  </Section>
                  <Section
                    step="02"
                    title="Driving conditions"
                    summary={conditionsSummary(settings)}
                    open={section === "conditions"}
                    onToggle={() => toggleSection("conditions")}
                  >
                    <ConditionsBody
                      settings={settings}
                      project={project}
                      update={update}
                    />
                  </Section>
                </fieldset>
              ) : (
                <div className="run-section">
                  <div className="sidebar-label">
                    Runs
                    <div
                      className="segmented"
                      role="group"
                      aria-label="Runs shown"
                    >
                      {(["design", "all"] as const).map((s) => (
                        <button
                          key={s}
                          aria-pressed={runScope === s}
                          className={runScope === s ? "chosen" : ""}
                          onClick={() => setRunScope(s)}
                        >
                          {s === "design" ? "This design" : "All"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <RunList
                    runs={scoped}
                    selected={current?.id}
                    onSelect={setSelected}
                  />
                </div>
              )}
            </div>
            {project && settings && tab === "setup" && (
              <fieldset
                className="run-bar-fields"
                disabled={busy || initializing}
              >
                <RunBar
                  project={project}
                  settings={settings}
                  update={update}
                  health={health}
                  estimate={estimate}
                  busy={busy}
                  anyActive={anyActive}
                  dirty={dirty}
                  onRun={start}
                  onSave={() => action(save)}
                />
              </fieldset>
            )}
            {tab === "results" && current && (
              <RunActions
                run={current}
                onLogs={() =>
                  action(async () =>
                    setLogs(
                      await api<Record<string, string>>(
                        `/runs/${current.id}/logs`,
                      ),
                    ),
                  )
                }
                onCancel={() =>
                  action(async () => {
                    await api(`/runs/${current.id}/cancel`, json("POST"));
                    await refresh();
                  })
                }
              />
            )}
          </aside>
        )}
        <main>
          <div className="design-bar">
            <div className="design-title">
              <h1 title={project?.name}>
                {project?.name || "Your first wind tunnel"}
              </h1>
              <button
                className="icon-button"
                title="Rename design"
                disabled={!project || busy}
                onClick={() => {
                  setDesignName(project!.name);
                  setRenaming(true);
                }}
              >
                <Pencil size={14} />
              </button>
            </div>
            <nav className="tabs">
              {(
                [
                  ["setup", "Model & setup", "Model", Box],
                  ["results", "Simulation results", "Results", Activity],
                  ["compare", "Compare designs", "Compare", GitCompareArrows],
                ] as const
              ).map(([id, full, short, Icon]) => (
                <button
                  key={id}
                  className={tab === id ? "active" : ""}
                  aria-current={tab === id ? "page" : undefined}
                  aria-label={full}
                  onClick={() => setTab(id)}
                >
                  <Icon size={15} />
                  {/* Short labels on narrow windows; the accessible name stays whole. */}
                  <span className="tab-long">{full}</span>
                  <span className="tab-short">{short}</span>
                  {id === "results" && anyActive && (
                    <span className="live-dot" />
                  )}
                </button>
              ))}
            </nav>
            <div className="design-actions">
              {project?.sample && (
                <button
                  className="secondary small"
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
                  {project.sample === "wing" ? "Remove wing" : "Add rear wing"}
                </button>
              )}
              <button
                className="secondary small"
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
                <Copy size={13} />
                Duplicate design
              </button>
            </div>
          </div>
          {error && (
            <div className="alert error" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss">
                <X size={15} />
              </button>
            </div>
          )}
          {tab === "setup" && (
            <div className="fold">
              <div className="canvas-panel fill">
                <div className="panel-top">
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
                  <span className="muted small">
                    {project?.geometry?.errors.length
                      ? "Geometry needs attention"
                      : project?.geometry
                        ? project.sample
                          ? "Simplified demonstration car, not a validated vehicle model"
                          : "Ready for review"
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
                  theme={resolved}
                />
              </div>
              <p className="micro fold-note">
                <AlertTriangle size={12} /> Closed surfaces are required. Review
                gaps, intersections, and wheel clearance before running.
                Duplicate a design or switch optional parts, run, then compare
                under the same conditions.
              </p>
            </div>
          )}
          {tab === "results" && (
            <ResultsView
              plane={plane}
              current={current}
              history={history}
              historyFailed={historyFailed}
              controls={controls}
              field={field}
              mode={mode}
              axis={axis}
              position={position}
              theme={resolved}
              onBack={() => setTab("setup")}
            />
          )}
          {tab === "compare" && (
            <CompareView
              plane={plane}
              completed={completed}
              baseline={baseline}
              variant={variant}
              setBaseline={setBaseline}
              setVariant={setVariant}
              comparison={comparison}
              controls={controls}
              field={field}
              mode={mode}
              axis={axis}
              position={position}
              theme={resolved}
            />
          )}
          <footer>
            Easy CFD{" "}
            <span>
              OpenFOAM 2412 · Steady RANS · Research and design exploration ·
              Open-source tools, local files, no cloud uploads
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
          mode={importing}
          openGuide={() => setGuideOpen(true)}
          close={() => setImporting("")}
          onImported={async (p) => {
            pick(p);
            await refresh();
            setImporting("");
            setTab("setup");
            setSection("geometry");
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

function ImportModal({
  openGuide,
  project,
  mode,
  close,
  onImported,
}: {
  project: Project;
  mode: "replace" | "add";
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
  const adding = mode === "add",
    frame = project.geometry?.import_options;
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const body = new FormData();
      files.forEach((f) => body.append("files", f));
      if (!adding)
        body.append(
          "options",
          JSON.stringify({ units, forward, up, clearance }),
        );
      await onImported(
        await api<Project>(
          `/projects/${project.id}/${adding ? "parts" : "import"}`,
          { method: "POST", body },
        ),
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
          <h2>{adding ? "Add parts" : "Import your design"}</h2>
          <button onClick={close} disabled={busy}>
            <X size={20} />
          </button>
        </div>
        {adding ? (
          <p>
            Add optional parts such as a rear wing or splitter. Export them from
            the same scene as the car, without moving the car. They use the
            car&apos;s units and axes
            {frame &&
              ` (${frame.units}, nose ${frame.forward}, up ${frame.up})`}{" "}
            and are placed exactly where they were exported. Switch each one on
            or off before a run.
          </p>
        ) : (
          <p>
            Import the complete exterior assembly. This replaces the current
            model; saved runs keep their original geometry.
          </p>
        )}
        <button className="text-button" type="button" onClick={openGuide}>
          Preparing a model in Blender? Read the export guide
        </button>
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
        {!adding && (
          <>
            <div className="input-pair">
              <label className="input-label">
                STL units
                <select
                  value={units}
                  onChange={(e) => setUnits(e.target.value)}
                >
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
              Wheel centers initially use each part's bounding-box center;
              export separate wheels with transverse axes.
            </p>
          </>
        )}
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
          {busy
            ? "Checking geometry…"
            : adding
              ? "Add & check parts"
              : "Import & check model"}
        </button>
      </div>
    </div>
  );
}
