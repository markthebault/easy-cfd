// Parts and groups: parts are organised in named groups (body, wheels, rear-wing versions…)
// that are switched on and off together, so variants can be run and compared without re-importing.

import { useState } from "react";
import { ChevronDown, ChevronRight, Disc3, FolderPlus, Target, Trash2 } from "lucide-react";
import { useStore } from "../store/store";
import { app, createGroup, deleteGroup, moveToGroup, partKey, renameGroup, setGroupEnabled, setOverride, soloGroup } from "../store/app";
import type { GroupView } from "../store/geometry";
import { NumberField } from "./controls";
import { fmtInt } from "./format";

const CORE = new Set(["g:body", "g:wheels"]);
const NEW = "__new__";

function GroupName({ group, autoEdit }: { group: GroupView; autoEdit: boolean }) {
  const [editing, setEditing] = useState(autoEdit);
  const [text, setText] = useState(group.name);
  if (!editing)
    return (
      <button className="group-name" title="Rename" onClick={() => { setText(group.name); setEditing(true); }}>
        {group.name}
      </button>
    );
  const done = () => {
    setEditing(false);
    if (text.trim() && text.trim() !== group.name) renameGroup(group.id, text);
  };
  return (
    <input
      className="group-name-input"
      aria-label={`Name of group ${group.name}`}
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
}

export function GroupsPanel() {
  const groups = useStore(app, (s) => s.groups);
  const parts = useStore(app, (s) => s.parts);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [created, setCreated] = useState<string | null>(null);
  const nextName = () => {
    let n = 1;
    while (groups.some((g) => g.name === `Group ${n}`)) n++;
    return `Group ${n}`;
  };
  const add = (keys: string[] = []) => setCreated(createGroup(nextName(), keys) ?? null);
  const optional = groups.filter((g) => !CORE.has(g.id)).map((g) => g.id);
  const simulated = parts.filter((p) => p.enabled).length;

  const move = (key: string, target: string) => {
    if (target === NEW) add([key]);
    else moveToGroup(key, target);
  };

  return (
    <div className="group">
      <div className="group-title">
        Parts and groups
        <span className="muted">{groups.filter((g) => g.enabled).length} of {groups.length} groups on · {simulated} parts simulated</span>
      </div>
      <ul className="group-list">
        {groups.map((g) => {
          const open = !(collapsed[g.id] ?? g.parts.length > 6);
          return (
            <li key={g.id} className={`part-group ${g.enabled ? "" : "off"}`} data-testid={`group-${g.name}`}>
              <div className="part-group-head">
                <button className="icon-btn xs" aria-label={open ? `Collapse ${g.name}` : `Expand ${g.name}`} aria-expanded={open} onClick={() => setCollapsed({ ...collapsed, [g.id]: open })}>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <label className="toggle compact" title={g.enabled ? "Included in the simulation" : "Left out of the simulation"}>
                  <input type="checkbox" role="switch" checked={g.enabled} aria-label={`Simulate group ${g.name}`} onChange={(e) => setGroupEnabled(g.id, e.target.checked)} />
                  <span className="switch" aria-hidden />
                </label>
                <GroupName key={g.id + (created === g.id ? ":new" : "")} group={g} autoEdit={created === g.id} />
                <span className="muted small">{g.parts.length} part{g.parts.length === 1 ? "" : "s"}</span>
                {!CORE.has(g.id) && optional.length > 1 && (
                  <button className="btn tiny" title="Switch this group on and the other optional groups off" onClick={() => soloGroup(g.id, optional)}>
                    <Target size={12} /> Only this
                  </button>
                )}
                {!g.auto && (
                  <button className="icon-btn xs" aria-label={`Delete group ${g.name}`} title="Delete group (its parts return to their automatic groups)" onClick={() => deleteGroup(g.id)}>
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              {open && (
                <ul className="part-list">
                  {g.parts.map((p) => {
                    const key = partKey(p);
                    return (
                      <li key={key} className={p.selfEnabled === false ? "off" : ""}>
                        <input type="checkbox" checked={p.selfEnabled !== false} aria-label={`Include ${p.name}`} onChange={(e) => setOverride(key, { enabled: e.target.checked })} />
                        <span className="part-name" title={`${p.name} · ${fmtInt(p.positions.length / 9)} triangles`}>{p.name}</span>
                        <button
                          className={`role-chip ${p.role === "wheel" ? "on" : ""}`}
                          aria-pressed={p.role === "wheel"}
                          title={p.role === "wheel" ? "Marked as a wheel. Click to make it bodywork." : "Bodywork. Click to mark as a wheel."}
                          onClick={() => setOverride(key, { role: p.role === "wheel" ? "body" : "wheel" })}
                        >
                          <Disc3 size={13} /> Wheel
                        </button>
                        {p.role === "wheel" && p.wheel ? (
                          <NumberField value={Math.round(p.wheel.radius * 1000)} min={20} max={1000} unit="mm" label={`Wheel radius of ${p.name}`} width={86} onChange={(v) => setOverride(key, { radius: v / 1000 })} />
                        ) : (
                          <span className="part-tri">{fmtInt(p.positions.length / 9)}</span>
                        )}
                        <select className="part-move" value={g.id} aria-label={`Group of ${p.name}`} onChange={(e) => move(key, e.target.value)}>
                          {groups.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                          <option value={NEW}>New group…</option>
                        </select>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className="row gap-s">
        <button className="btn ghost sm" onClick={() => add()}>
          <FolderPlus size={15} /> New group
        </button>
        <small className="field-hint">Move parts into a group with the menu on each row. Switch groups off to leave them out of the next run.</small>
      </div>
    </div>
  );
}
