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
import { Slider } from "./controls";
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
  const serverReady = OPENFOAM_ENABLED && server.status === "ready";
  const limitCeiling = openfoam
    ? s.profile === "advanced1"
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
              profile: "regular",
              quality: "medium",
              max_seconds: 600,
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
              profile: "advanced1",
              quality: "medium",
              max_seconds: 10800,
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
      {openfoam && (
        <div className="group">
          <label className="field-label" htmlFor="advanced-profile">
            Analysis level
          </label>
          <select
            id="advanced-profile"
            value={s.profile ?? "legacy"}
            onChange={(e) => {
              const profile = e.target.value as "advanced1" | "advanced2";
              setSettings(
                profile === "advanced1" || profile === "advanced2"
                  ? {
                      profile,
                      quality: "medium",
                      max_seconds: profile === "advanced2" ? 43200 : 10800,
                    }
                  : { profile: undefined, max_seconds: undefined },
              );
            }}
          >
            <option value="legacy">Standard · choose a mesh preset</option>
            <option value="advanced1">
              Advanced 1 · single mesh
            </option>
            <option value="advanced2">
              Advanced 2 · three-mesh comparison
            </option>
          </select>
          <p className="field-hint">
            {s.profile === "advanced1"
              ? "One mesh, up to 1 million cells. Limits: 5 GiB memory, 2 CPUs and 3 hours. "
              : s.profile === "advanced2"
                ? "Compare three meshes, up to 2 million cells each. Limits: 6 GiB memory, 2 CPUs and 12 hours. "
                : "Choose Fast, Medium or Precise below. "}
            Runtime ceilings are safety limits, not measured completion times.
            {s.profile?.startsWith("advanced") && " These levels are not yet numerically qualified. Advanced 2 stops if a mesh remains unstable."}
          </p>
        </div>
      )}
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
      <label className="field-label" htmlFor="elapsed-limit">
        Whole-job time limit (seconds)
      </label>
      <input
        id="elapsed-limit"
        type="number"
        min="30"
        max={limitCeiling}
        value={
          s.max_seconds ?? (openfoam ? 10800 : s.quality === "fast" ? 300 : 600)
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

      {openfoam ? (
        s.profile?.startsWith("advanced") ? (
          <p className="field-hint">
            Keep Mac responsive · 2 MPI ranks / 2-CPU quota. Runtime not yet
            benchmarked. All analysis views are included when their data are
            available.
          </p>
        ) : (
          <OpenFoamQualities quality={s.quality} info={server.info} />
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
                      max_seconds: q === "fast" ? 300 : 600,
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
                        max_seconds: q === "fast" ? 300 : 600,
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

      {openfoam ? (
        !s.profile?.startsWith("advanced") && (
          <OpenFoamSummary quality={s.quality} info={server.info} />
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

const OF_QUALITIES: { q: "fast" | "medium" | "precise"; label: string }[] = [
  { q: "fast", label: "Fast" },
  { q: "medium", label: "Medium" },
  { q: "precise", label: "Precise" },
];

function measuredText(
  info: ServerInfo | null,
  q: "fast" | "medium" | "precise",
): string {
  const m = info?.measured[q];
  return m
    ? `~${fmtDuration(m.seconds)} (median of ${m.runs} run${m.runs > 1 ? "s" : ""} here)`
    : "no runs measured here yet";
}

function OpenFoamQualities({
  quality,
  info,
}: {
  quality: string;
  info: ServerInfo | null;
}) {
  return (
    <div
      className="quality-grid of"
      role="radiogroup"
      aria-label="OpenFOAM quality"
    >
      {OF_QUALITIES.map(({ q, label }) => {
        const p = info?.presets[q];
        const on = quality === q || (q === "medium" && quality === "custom");
        return (
          <button
            key={q}
            role="radio"
            aria-checked={on}
            className={`quality-card ${on ? "on" : ""}`}
            onClick={() =>
              setSettings({
                quality: q,
                profile: undefined,
                max_seconds: undefined,
              })
            }
          >
            <span className="q-label">{label}</span>
            <span className="q-blurb">{p?.label ?? ""}</span>
            <span className="q-meta">
              {p
                ? `≤ ${fmtCells(p.max_cells)} cells · ${p.layers ? `${p.layers} layers · ` : ""}${p.iterations} iterations`
                : "–"}
            </span>
            <span className="q-est">{measuredText(info, q)}</span>
          </button>
        );
      })}
    </div>
  );
}

function OpenFoamSummary({
  quality,
  info,
}: {
  quality: string;
  info: ServerInfo | null;
}) {
  const q = (quality === "custom" ? "medium" : quality) as
    | "fast"
    | "medium"
    | "precise";
  const p = info?.presets[q];
  const m = info?.measured[q];
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
