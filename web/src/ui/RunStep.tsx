// Step 3: mesh quality and the Run button.

import { useMemo } from "react";
import { Cpu, Play, Server, TriangleAlert, Zap } from "lucide-react";
import type { ServerInfo } from "../engine/openfoam";
import { OPENFOAM_ENABLED, OPENFOAM_COMING_SOON } from "../engine/features";
import { partShapes } from "../solver/detail";
import { boundsOf } from "../solver/setup";
import {
  detailRatio,
  PRESETS,
  type Quality,
  type Settings,
} from "../solver/types";
import { useStore } from "../store/store";
import { app, setSettings } from "../store/app";
import { estimate } from "../store/estimate";
import { toSolverParts } from "../store/geometry";
import { startRun } from "../store/runs";
import { weightInputError } from "../solver/tyreLoads";
import { Slider, Toggle } from "./controls";
import { boundaryLine, fmt, fmtCells, fmtDuration } from "./format";

const QUALITIES: { q: Quality; label: string; blurb: string }[] = [
  { q: "fast", label: "Basic", blurb: "Check the setup" },
  { q: "medium", label: "Regular", blurb: "Compare designs" },
  { q: "precise", label: "Precise", blurb: "Two-grid sensitivity" },
  { q: "custom", label: "Custom", blurb: "Your own mesh" },
];

function detailWhere(zones: number, boxes: number, first: string): string {
  const parts = zones - boxes;
  const p =
    parts === 1 && !boxes
      ? `around ${first}`
      : parts
        ? `around ${parts} part${parts > 1 ? "s" : ""}`
        : "";
  const b = boxes ? `in ${boxes} detail box${boxes > 1 ? "es" : ""}` : "";
  return [p, b].filter(Boolean).join(" and ");
}

export function RunStep() {
  const design = useStore(app, (s) => s.design)!;
  const report = useStore(app, (s) => s.report);
  const gpu = useStore(app, (s) => s.gpu);
  const server = useStore(app, (s) => s.server);
  const confirmed = useStore(app, (s) => s.confirmed);
  const parts = useStore(app, (s) => s.parts);
  const groups = useStore(app, (s) => s.groups);
  const s = design.settings;
  const weightError = weightInputError(s);
  // The grid is shaped by every part whose own switch is on (also those in groups switched off).
  const { shapes, low, high } = useMemo(() => {
    const solver = toSolverParts(parts, groups);
    return solver.length
      ? { shapes: partShapes(solver), ...boundsOf(solver) }
      : { shapes: [], low: [0, 0, 0] as const, high: [1, 1, 1] as const };
  }, [parts, groups]);
  const est = (settings: Settings) =>
    estimate([...low], [...high], settings, shapes);
  const current = est(s);
  const resourceBlocked =
    s.engine !== "openfoam" && !!current && current.cells > 2_500_000;
  const blocked =
    !report || report.errors.length > 0 || !confirmed || resourceBlocked;
  const noGpu = gpu.status === "unavailable" || gpu.status === "checking";
  const openfoam = OPENFOAM_ENABLED && s.engine === "openfoam";
  const fineFlow = openfoam && !!s.flow_animation && s.flow_detail === "fine";
  const qualityLimit = (q: Quality) => openfoam && q === "medium" ? 1200 : (q === "fast" ? 300 : 600) * (openfoam && s.flow_animation ? 2 : 1);
  const requestedLimit = s.max_seconds ?? (s.import_test && openfoam ? 180 : !openfoam ? qualityLimit(s.quality) : fineFlow ? 43200 : s.profile === "basic" ? qualityLimit("fast") : s.profile === "regular" ? qualityLimit("medium") : s.profile === "advanced2" ? 43200 : !s.profile && s.quality === "medium" ? 1200 : 10800);
  const mediumLevel = openfoam && !fineFlow && (!s.profile || s.profile === "regular") && (s.quality === "medium" || s.quality === "custom");
  const timeLimit = mediumLevel ? Math.min(requestedLimit,1200) : requestedLimit;
  const serverReady = OPENFOAM_ENABLED && server.status === "ready";
  const limitCeiling = openfoam
    ? s.import_test ? 180 : !fineFlow && (s.profile === "regular" || (!s.profile && s.quality === "medium"))
      ? 1200
      : s.profile === "basic"
      ? qualityLimit("fast")
      : s.profile === "advanced1"
      ? 10800
      : 43200
    : s.quality === "fast"
      ? 300
      : 600;

  return (
    <div className="step-body">
      <div
        className="engine-grid"
        role="radiogroup"
        aria-label="Solver engine"
      >
        <button
          role="radio"
          aria-checked={!openfoam}
          className={`engine-card ${!openfoam ? "on" : ""}`}
          data-testid="engine-webgpu"
          onClick={() =>
            setSettings({
              engine: "webgpu",
              import_test: false,
              profile: "regular",
              quality: "medium",
              max_seconds: 600,
              flow_detail: "standard",
            })
          }
        >
          <span className="q-label"><Zap size={15} /> WebGPU</span>
          <span className="q-blurb">On this device</span>
          <span className="q-meta">Explore and compare designs</span>
        </button>
        <button
          role="radio"
          aria-checked={openfoam}
          className={`engine-card ${openfoam ? "on" : ""}`}
          disabled={!serverReady}
          aria-describedby={!serverReady ? "openfoam-availability" : undefined}
          data-testid="engine-openfoam"
          onClick={() =>
            setSettings({
              engine: "openfoam",
              import_test: false,
              profile: "regular",
              quality: "medium",
              max_seconds: 1200,
              flow_detail: "standard",
            })
          }
        >
          <span className="q-label"><Server size={15} /> OpenFOAM</span>
          <span className="q-blurb">{OPENFOAM_ENABLED ? "On your local server" : "On demand"}</span>
          <span className="q-meta">Advanced analysis</span>
        </button>
      </div>
      {!serverReady && (
        <p id="openfoam-availability" className="field-hint" data-testid="openfoam-availability">
          {!OPENFOAM_ENABLED ? OPENFOAM_COMING_SOON : server.status === "checking"
            ? "Looking for the local OpenFOAM server…"
            : server.info?.message || "OpenFOAM is unavailable. Start the local server with just run-openfoam."}
        </p>
      )}
      {openfoam && <OpenFoamLevels settings={s} />}
      {openfoam && s.profile?.startsWith("advanced") && (
        <div className="group">
          <span className="field-label">Local refinement</span>
          {groups
            .filter((g) => g.enabled)
            .map((g) => {
              const selected =
                s.refine_groups ??
                groups
                  .filter((x) => x.enabled && x.id !== "g:body")
                  .map((x) => x.id);
              return (
                <label className="row gap-s small" key={g.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(g.id)}
                    onChange={(e) =>
                      setSettings({
                        refine_groups: e.target.checked
                          ? [...selected, g.id]
                          : selected.filter((id) => id !== g.id),
                      })
                    }
                  />
                  {g.name}
                </label>
              );
            })}
          <label className="row gap-s small">
            <input
              type="checkbox"
              checked={s.refine_underfloor !== false}
              onChange={(e) =>
                setSettings({ refine_underfloor: e.target.checked })
              }
            />
            Underfloor and road gap
          </label>
          <p className="field-hint">
            Selected surfaces receive extra local cells. The actual mesh must
            pass its cell ceiling and layer checks; requested refinement is
            never silently reduced.
          </p>
        </div>
      )}
      {resourceBlocked && (
        <p className="inline-error">
          This grid exceeds the 2.5 M cell ceiling. Reduce the cells or detail
          refinement.
        </p>
      )}
      <details className="group run-time-settings"><summary>Time limit</summary>
      <label className="field-label" htmlFor="elapsed-limit">
        Whole-job time limit (seconds)
      </label>
      <input
        id="elapsed-limit"
        type="number"
        min="30"
        max={limitCeiling}
        value={
          timeLimit
        }
        onChange={(e) =>
          setSettings({
            max_seconds: Math.max(
              30,
              Math.min(limitCeiling, Number(e.target.value)),
            ),
          })
        }
      />
      <p className="field-hint">
        {!openfoam && "WebGPU limits: 2.5 million cells / 3 GiB. GPU limits are checked before preparing the grid. "}
        Stop is available during preparation and solving.
      </p>

      </details>

      {openfoam ? (
        fineFlow ? <p className="field-hint">Detailed wake mesh · up to 2 million cells · 6 GiB. Fine cells surround the car and continue into its wake.</p> : s.profile?.startsWith("advanced") ? (
          <p className="field-hint">
            Keep Mac responsive · 2 MPI ranks / 2-CPU quota. Runtime not yet
            benchmarked. All analysis views are included when their data are
            available.
          </p>
        ) : (
          <p className="field-hint">{s.quality === "medium" ? "Medium stops within 20 minutes, including preparation and any standard recording. Unfinished results are marked incomplete." : "Stop is available throughout the run."}</p>
        )
      ) : (
        <div className="quality-grid" role="radiogroup" aria-label="Quality">
          {QUALITIES.filter(({ q }) => q === "fast" || q === "medium").map(
            ({ q, label, blurb }) => {
              const e = est({ ...s, quality: q });
              const on = s.quality === q;
              const p =
                q === "custom"
                  ? { cellsPerLength: s.custom_cells, passes: s.custom_passes }
                  : PRESETS[q];
              return (
                <button
                  key={q}
                  role="radio"
                  aria-checked={on}
                  className={`quality-card ${on ? "on" : ""}`}
                  onClick={() =>
                    setSettings({
                      quality: q,
                      profile:
                        q === "fast"
                          ? "basic"
                          : q === "medium"
                            ? "regular"
                            : undefined,
                      max_seconds: qualityLimit(q),
                    })
                  }
                >
                  <span className="q-label">
                    {label}
                    {q === "medium" && (
                      <small className="badge">recommended</small>
                    )}
                  </span>
                  <span className="q-blurb">
                    {q === "fast"
                      ? "Basic · check setup"
                      : q === "medium"
                        ? "Regular · compare designs"
                        : blurb}
                  </span>
                  <span className="q-meta">
                    {p.cellsPerLength} cells/length · {p.passes} passes
                  </span>
                  <span className="q-est">
                    {e
                      ? `${fmtCells(e.cells)} cells · ~${fmtDuration(e.seconds)}`
                      : "–"}
                  </span>
                </button>
              );
            },
          )}
        </div>
      )}

      {!openfoam && (
        <details
          className="group"
          open={
            s.quality === "custom" || s.quality === "precise" ? true : undefined
          }
        >
          <summary>Expert WebGPU settings</summary>
          <div
            className="quality-grid"
            role="radiogroup"
            aria-label="Expert quality"
          >
            {" "}
            {QUALITIES.filter(({ q }) => q === "precise" || q === "custom").map(
              ({ q, label, blurb }) => {
                const e = est({ ...s, quality: q });
                const on = s.quality === q;
                const p =
                  q === "custom"
                    ? {
                        cellsPerLength: s.custom_cells,
                        passes: s.custom_passes,
                      }
                    : PRESETS[q];
                return (
                  <button
                    key={q}
                    role="radio"
                    aria-checked={on}
                    className={`quality-card ${on ? "on" : ""}`}
                    onClick={() =>
                      setSettings({
                        quality: q,
                        profile:
                          q === "fast"
                            ? "basic"
                            : q === "medium"
                              ? "regular"
                              : undefined,
                        max_seconds: qualityLimit(q),
                      })
                    }
                  >
                    <span className="q-label">{label}</span>
                    <span className="q-blurb">
                      {q === "fast"
                        ? "Basic · check setup"
                        : q === "medium"
                          ? "Regular · compare designs"
                          : blurb}
                    </span>
                    <span className="q-meta">
                      {p.cellsPerLength} cells/length · {p.passes} passes
                    </span>
                    <span className="q-est">
                      {e
                        ? `${fmtCells(e.cells)} cells · ~${fmtDuration(e.seconds)}`
                        : "–"}
                    </span>
                  </button>
                );
              },
            )}
          </div>
          {s.quality === "custom" && (
            <div className="group">
              <Slider
                label="Cells along the car length"
                min={40}
                max={220}
                step={1}
                value={s.custom_cells}
                onChange={(v) => setSettings({ custom_cells: v })}
              />
              <Slider
                label="Flow passes"
                min={2}
                max={40}
                step={1}
                value={s.custom_passes}
                display={`${s.custom_passes} × car length`}
                onChange={(v) => setSettings({ custom_passes: v })}
              />
              <small className="field-hint">
                More passes let the wake settle; forces are averaged over the
                last 30 %.
              </small>
            </div>
          )}

          {!openfoam && (
            <div className="group">
              <Slider
                label="Detail cells around aero parts"
                min={1}
                max={4}
                step={0.5}
                value={detailRatio(s)}
                display={
                  detailRatio(s) <= 1 ? "off" : `${detailRatio(s)}× finer`
                }
                onChange={(v) => setSettings({ detail_ratio: v })}
              />
              <small className="field-hint">
                Experimental, off by default. Finer cells around thin or small
                parts and in detail boxes; 3–6× slower. On some cars they change
                the body flow or make the run unstable, and wing downforce stays
                under-predicted. See the validation notes.
              </small>
            </div>
          )}
        </details>
      )}

      {!openfoam && current && current.detail.zones.length > 0 && (
        <p className="detail-line small" data-testid="detail-line">
          Detail cells {current.detail.ratio}× finer{" "}
          {detailWhere(
            current.detail.zones.length,
            s.detail_boxes?.length ?? 0,
            current.detail.zones[0],
          )}
          {current.detail.ratio < current.detail.requested
            ? ` (limited from ${current.detail.requested}× by the cell budget)`
            : ""}
          .<span className="muted"> Set per group in the car step.</span>
        </p>
      )}

      <div className="group flow-record-option">
        <Toggle checked={!!s.flow_animation} onChange={flow_animation => {
          if(flow_animation && openfoam && s.flow_detail === "fine") {
            setSettings({import_test:false,flow_animation,profile:undefined,quality:"medium",max_seconds:43200});
            return;
          }
          const normalLimit = s.profile === "basic" ? 300 : 1200;
          const standard = openfoam && (s.profile === "basic" || s.profile === "regular");
          const from = normalLimit * (s.profile === "basic" && s.flow_animation ? 2 : 1), to = normalLimit * (s.profile === "basic" && flow_animation ? 2 : 1);
          setSettings({import_test:false,flow_animation, ...(s.import_test && flow_animation ? {profile:"basic" as const,quality:"fast" as const,max_seconds:600}:{}), ...(standard && (!s.max_seconds || s.max_seconds === from || s.max_seconds > to) ? {max_seconds:to} : {})});
        }} label="Record flow animation" hint="Watch the coloured airflow and wake evolve after the run." />
        {s.flow_animation && openfoam && <>
          <label className="field-label" htmlFor="flow-detail">Recording detail</label>
          <select id="flow-detail" value={s.flow_detail ?? "standard"} onChange={e=> {
            const flow_detail = e.target.value as "standard" | "fine";
            setSettings(flow_detail === "fine" ? {import_test:false,flow_detail, profile:undefined, quality:"medium", max_seconds:43200} : {flow_detail,profile:"advanced1",quality:"medium",max_seconds:10800});
          }}>
            <option value="standard">Standard airflow</option>
            <option value="fine">Detailed wake</option>
          </select>
        </>}
        {s.flow_animation && <p className="field-hint">{fineFlow
          ? "Resolves wake motion with DDES and records about 192 frames in four detailed sections after the flow develops. This needs substantially more computation than a standard recording."
          : `Records 48 frames over twelve car-lengths of airflow using ${openfoam ? "OpenFOAM" : "WebGPU"}.`}
          {" "}Whole-job limit including recording: {fmtDuration(timeLimit)}. Play it in Explore airflow.</p>}
      </div>

      {openfoam ? (
        !fineFlow && !s.profile?.startsWith("advanced") && (
          <OpenFoamSummary quality={s.quality} info={server.info} importTest={s.import_test} />
        )
      ) : (
        <div className="run-summary">
          <div>
            <span className="run-big">
              {current ? fmtCells(current.cells) : "–"}
            </span>
            <span className="run-small">
              cells{current ? ` · ${current.grid.join(" × ")}` : ""}
            </span>
          </div>
          <div>
            <span className="run-big">
              ~{current ? fmtDuration(current.seconds) : "–"}
            </span>
            <span className="run-small">
              {current?.calibrated
                ? "estimate from your last runs"
                : "rough estimate, improves after a run"}
            </span>
          </div>
        </div>
      )}

      {openfoam ? (
        <div className={`gpu-line ${serverReady ? "ready" : "unavailable"}`}>
          {serverReady ? (
            <>
              <Server size={15} />{" "}
              <span>
                OpenFOAM server · {server.info?.cpus ?? "?"} CPUs ·{" "}
                {fmt(server.info?.memory_gb ?? 0, 1)} GB memory
              </span>
            </>
          ) : (
            <>
              <TriangleAlert size={15} />{" "}
              <span>
                {server.info?.message || "The OpenFOAM server is not ready."}
              </span>
            </>
          )}
        </div>
      ) : (
        <div className={`gpu-line ${gpu.status}`}>
          {gpu.status === "ready" && (
            <>
              <Cpu size={15} />{" "}
              <span>WebGPU · {gpu.adapter || "GPU ready"}</span>
            </>
          )}
          {gpu.status === "checking" && (
            <>
              <Cpu size={15} /> <span>Checking WebGPU…</span>
            </>
          )}
          {(gpu.status === "software" || gpu.status === "unavailable") && (
            <>
              <TriangleAlert size={15} /> <span>{gpu.message}</span>
            </>
          )}
        </div>
      )}

      {weightError && <p className="inline-error" role="alert">{weightError} Edit the weight inputs in Conditions.</p>}
      <button
        className="btn run block"
        disabled={blocked || !!weightError || (openfoam ? !serverReady : noGpu)}
        onClick={() => startRun()}
        data-testid="run"
      >
        <Play size={20} fill="currentColor" />{" "}
        {openfoam ? "Run on OpenFOAM" : "Run simulation"}
      </button>
      <p className="small center" data-testid="run-boundaries">
        {boundaryLine(s)}
      </p>
      {blocked && (
        <small className="field-hint center">
          Finish the car step and tick the check box first.
        </small>
      )}
      {openfoam && !blocked && (
        <small className="field-hint center">
          The run continues on the server if you close this tab; open it later
          from the run list.
        </small>
      )}
    </div>
  );
}

const OF_LEVELS = [
  {profile:"basic",quality:"fast",label:"Fast",blurb:"Check the setup",limit:300},
  {profile:"regular",quality:"medium",label:"Medium",blurb:"Compare designs",limit:1200},
  {profile:"advanced1",quality:"medium",label:"Precise",blurb:"Single fine mesh",limit:10800},
  {profile:"advanced2",quality:"medium",label:"Very Precise",blurb:"Compare three meshes",limit:43200},
] as const;

function OpenFoamLevels({settings:s}:{settings:Settings}) {
  const fine = !!s.flow_animation && s.flow_detail === "fine";
  const selected = s.import_test ? "import" : s.profile ?? (s.quality === "fast" ? "basic" : s.quality === "precise" ? "advanced1" : "regular");
  return <div className="group">
    <span className="field-label">Analysis level</span>
    <div className="quality-grid of" role="radiogroup" aria-label="Analysis level">
      {OF_LEVELS.map(level => <button key={level.profile} role="radio" aria-checked={!fine && selected === level.profile}
        className={`quality-card ${!fine && selected === level.profile ? "on" : ""}`}
        onClick={()=>setSettings({import_test:false,profile:level.profile,quality:level.quality,flow_detail:"standard",max_seconds:level.limit * (level.profile === "basic" && s.flow_animation ? 2 : 1)})}>
        <span className="q-label">{level.label}</span>
        <span className="q-blurb">{level.blurb}</span>
        <span className="q-meta">Up to {level.limit >= 3600 ? `${level.limit / 3600} hours` : fmtDuration(level.limit * (level.profile === "basic" && s.flow_animation ? 2 : 1))}</span>
      </button>)}
    </div>
    <button className={`btn ${s.import_test ? "primary" : "ghost"} sm`} aria-pressed={!!s.import_test} onClick={() => setSettings({import_test:true,wheels:false,profile:undefined,quality:"fast",flow_animation:false,flow_detail:"standard",max_seconds:180})}>Quick import test</button>
    {s.import_test && <p className="field-hint">Original surfaces combined for meshing; wheels fixed. Coarse mesh, no layers, 50 iterations, up to 3 minutes. Small features may be unresolved; forces are diagnostic only.</p>}
    {fine && <p className="field-hint">Detailed wake uses a separate recording budget. Choose a level above to return to standard airflow.</p>}
  </div>;
}

function OpenFoamSummary({
  quality,
  info,
  importTest,
}: {
  quality: string;
  info: ServerInfo | null;
  importTest?: boolean;
}) {
  const q = (quality === "custom" ? "medium" : quality) as
    | "fast"
    | "medium"
    | "precise";
  const p = importTest ? {max_cells:120000,iterations:50,layers:0,label:"Import test"} : info?.presets[q];
  const m = importTest ? undefined : info?.measured[q];
  return (
    <div className="run-summary">
      <div>
        <span className="run-big">
          {p ? `≤ ${fmtCells(p.max_cells)}` : "–"}
        </span>
        <span className="run-small">
          cells, snappyHexMesh
          {p?.layers ? ` with ${p.layers} prism layers` : ""}
        </span>
      </div>
      <div>
        <span className="run-big">
          {m ? `~${fmtDuration(m.seconds)}` : "–"}
        </span>
        <span className="run-small">
          {m
            ? `median of ${m.runs} run${m.runs > 1 ? "s" : ""} on this server`
            : "runtime depends on the car; the first run measures it"}
        </span>
      </div>
    </div>
  );
}
