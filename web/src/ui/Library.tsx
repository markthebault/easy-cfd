// Designs and runs saved in this browser.

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Columns2, Copy, FilePlus2, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { listRuns, type ServerRun } from "../engine/openfoam";
import { importedRunIds, importServerRun } from "../store/openfoamRuns";
import { useStore } from "../store/store";
import { app, deleteDesign, duplicateDesign, newDesign, openDesign, renameDesign } from "../store/app";
import { deleteRun, openRun, startCompare } from "../store/runs";
import { conditionsLine, fmtDate, groupsLine, verticalLoad } from "./format";

function Rename({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  return (
    <input
      ref={ref}
      className="rename"
      value={v}
      aria-label="New name"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => onDone(v)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(v);
        if (e.key === "Escape") onDone(null);
      }}
    />
  );
}

/** Runs on the OpenFOAM server (from this UI or the original one), to open here. */
function ServerRuns() {
  const [list, setList] = useState<ServerRun[] | null>(null);
  const [error, setError] = useState("");
  const saved = useStore(app, (s) => s.runs);
  const load = () => {
    setError("");
    listRuns().then(setList).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);
  // Recomputed when the browser's run list changes (after an import).
  const imported = useMemo(() => importedRunIds(), [saved]);
  return (
    <>
      <div className="compare-bar">
        <span className="muted small">Runs made on this server, also from the original UI.</span>
        <button className="btn ghost sm" onClick={load}><RefreshCw size={14} /> Refresh</button>
      </div>
      {error && <p className="inline-error">{error}</p>}
      {list && !list.length && <p className="muted small center">No runs on the server yet.</p>}
      <ul className="lib-list">
        {(list ?? []).map((r) => {
          const done = r.status === "completed";
          const have = imported.has(r.id);
          const pending = r.status === "queued" || r.status === "running";
          return (
            <li key={r.id}>
              <button className="lib-main" disabled={(!done && !pending) || have} onClick={() => importServerRun(r.id)} data-testid="server-run">
                <b>{r.name}</b>
                <span><span className="engine-tag">OpenFOAM</span> {Math.round(r.settings.speed_kmh)} km/h · {r.settings.yaw_deg}° yaw · {r.settings.import_test ? "Quick import test" : String(r.settings.quality)} · {fmtDate(Date.parse(r.created))}</span>
                <span className="lib-nums">
                  {done && r.result ? `Cd ${Number(r.result.cd).toFixed(3)} · Cl ${Number(r.result.cl).toFixed(3)}` : `${r.status}${r.stage ? ` · ${r.stage}` : ""}`}
                  {have ? " · already in this browser" : pending ? " · click to view progress" : done ? " · click to open" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function Library() {
  const open = useStore(app, (s) => s.library);
  const designs = useStore(app, (s) => s.designs);
  const runs = useStore(app, (s) => s.runs);
  const current = useStore(app, (s) => s.design?.id);
  const server = useStore(app, (s) => s.server.status);
  const [tab, setTab] = useState<"designs" | "runs" | "server">("runs");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && app.set({ library: false });
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  if (!open) return null;
  const toggle = (id: string) => setPick((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));

  return (
    <>
      <div className="scrim" onClick={() => app.set({ library: false })} />
      <aside className="drawer glass" aria-label="Designs and runs">
        <div className="drawer-head">
          <div className="segmented md" role="tablist">
            <button role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? "on" : ""} onClick={() => setTab("runs")}>Runs <span className="count">{runs.length}</span></button>
            <button role="tab" aria-selected={tab === "designs"} className={tab === "designs" ? "on" : ""} onClick={() => setTab("designs")}>Designs <span className="count">{designs.length}</span></button>
            {server !== "unavailable" && server !== "checking" && (
              <button role="tab" aria-selected={tab === "server"} className={tab === "server" ? "on" : ""} onClick={() => setTab("server")} data-testid="tab-server">OpenFOAM server</button>
            )}
          </div>
          <button className="icon-btn" aria-label="Close" onClick={() => app.set({ library: false })}><X size={18} /></button>
        </div>

        {tab === "designs" && (
          <>
            <button className="btn ghost block" onClick={newDesign}><FilePlus2 size={16} /> New design</button>
            {!designs.length && <p className="muted small center">No designs yet. Import a car or try the sample.</p>}
            <ul className="lib-list">
              {designs.map((d) => (
                <li key={d.id} className={d.id === current ? "current" : ""}>
                  {renaming === d.id ? (
                    <Rename value={d.name} onDone={(v) => { if (v) renameDesign(d.id, v); setRenaming(null); }} />
                  ) : (
                    <button className="lib-main" onClick={() => openDesign(d.id)}>
                      <b>{d.name}</b>
                      <span>{d.source.kind === "sample" ? "Sample car" : `${d.source.files.length} file${d.source.files.length > 1 ? "s" : ""}`} · {fmtDate(d.updatedAt)}</span>
                    </button>
                  )}
                  <div className="lib-actions">
                    <button className="icon-btn xs" aria-label={`Rename ${d.name}`} onClick={() => setRenaming(d.id)}><Pencil size={14} /></button>
                    <button className="icon-btn xs" aria-label={`Duplicate ${d.name}`} onClick={() => duplicateDesign(d.id)}><Copy size={14} /></button>
                    {confirmDelete === d.id ? (
                      <button className="btn tiny danger" onClick={() => { deleteDesign(d.id); setConfirmDelete(null); }}>Delete?</button>
                    ) : (
                      <button className="icon-btn xs" aria-label={`Delete ${d.name}`} onClick={() => setConfirmDelete(d.id)}><Trash2 size={14} /></button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {tab === "runs" && (
          <>
            <div className="compare-bar">
              <span className="muted small">{pick.length === 2 ? "Two runs selected" : "Tick two runs to compare them"}</span>
              <button className="btn primary sm" disabled={pick.length !== 2} onClick={() => startCompare(pick[0], pick[1])} data-testid="compare-selected">
                <Columns2 size={15} /> Compare
              </button>
            </div>
            {!runs.length && <p className="muted small center">No runs yet. Results are saved here automatically.</p>}
            <ul className="lib-list">
              {runs.map((r) => {
                const v = verticalLoad(r.result);
                return (
                  <li key={r.id}>
                    <button className={`pick ${pick.includes(r.id) ? "on" : ""}`} aria-pressed={pick.includes(r.id)} aria-label={`Select ${r.designName} for comparison`} onClick={() => toggle(r.id)}>
                      {pick.includes(r.id) && <Check size={13} strokeWidth={3} />}
                    </button>
                    <button className="lib-main" onClick={() => openRun(r.id)} data-testid="run-item">
                      <b>{r.designName}</b>
                      <span><span className="engine-tag">{r.result.engine === "openfoam" ? "OpenFOAM" : "WebGPU"}</span> {conditionsLine(r.settings)}{groupsLine(r.geometry) ? ` · ${groupsLine(r.geometry)}` : ""}</span>
                      <span className="lib-nums">Cd {r.result.cd.toFixed(3)} · Cl {r.result.cl.toFixed(3)} · {v.label} {v.kg.toFixed(1)} kg · {fmtDate(r.createdAt)}</span>
                    </button>
                    <div className="lib-actions">
                      {confirmDelete === r.id ? (
                        <button className="btn tiny danger" onClick={() => { deleteRun(r.id); setConfirmDelete(null); setPick((p) => p.filter((x) => x !== r.id)); }}>Delete?</button>
                      ) : (
                        <button className="icon-btn xs" aria-label={`Delete run of ${r.designName}`} onClick={() => setConfirmDelete(r.id)}><Trash2 size={14} /></button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {tab === "server" && <ServerRuns />}
        <p className="muted small drawer-foot">Stored in this browser only (IndexedDB). Clearing site data removes them.</p>
      </aside>
    </>
  );
}
