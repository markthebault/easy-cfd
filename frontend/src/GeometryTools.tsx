import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Box,
  FlipVertical2,
  RotateCw,
  Repeat,
  MoveUpRight,
  Trash2,
  Lightbulb,
} from "lucide-react";
import type { Geometry, ImportOptions, Part } from "./types";
import { hints, rotations, UNIT_NAMES } from "./orientation";

// Hints and orientation controls. Every change rebuilds the geometry from the
// stored originals and clears the geometry confirmation, like any other edit.
export function OrientationTools({
  geometry,
  apply,
}: {
  geometry: Geometry;
  apply: (options: ImportOptions) => void;
}) {
  const options = geometry.import_options;
  const [clearance, setClearance] = useState(options?.clearance ?? 0.01);
  useEffect(
    () => setClearance(options?.clearance ?? 0.01),
    [options?.clearance],
  );
  const found = hints(geometry);
  const hasStl = geometry.sources?.some((s) => /\.stl$/i.test(s.name));
  return (
    <>
      {found.map((hint, i) => (
        <div className="geometry-hint" key={i} role="status">
          <Lightbulb size={13} />
          <span>{hint.text}</span>
          {hint.fix && (
            <button className="text-button" onClick={() => apply(hint.fix!)}>
              {hint.action}
            </button>
          )}
        </div>
      ))}
      {options ? (
        <div className="orientation-tools">
          <div
            className="orientation-buttons"
            role="group"
            aria-label="Orientation"
          >
            <button
              title="Turn 90° clockwise, seen from above"
              onClick={() => apply(rotations.turn(options))}
            >
              <RotateCw size={13} /> Turn 90°
            </button>
            <button
              title="Swap nose and tail"
              onClick={() => apply(rotations.reverse(options))}
            >
              <Repeat size={13} /> Nose ↔ tail
            </button>
            <button
              title="Tip the nose up by 90°"
              onClick={() => apply(rotations.pitch(options))}
            >
              <MoveUpRight size={13} /> Pitch 90°
            </button>
            <button
              title="Swap roof and floor"
              onClick={() => apply(rotations.flip(options))}
            >
              <FlipVertical2 size={13} /> Flip
            </button>
          </div>
          <div className="input-pair">
            {hasStl && (
              <label className="input-label">
                STL units
                <select
                  aria-label="STL units"
                  value={options.units}
                  onChange={(e) =>
                    apply({
                      ...options,
                      units: e.target.value as ImportOptions["units"],
                    })
                  }
                >
                  {(Object.keys(UNIT_NAMES) as (keyof typeof UNIT_NAMES)[]).map(
                    (u) => (
                      <option key={u} value={u}>
                        {UNIT_NAMES[u][0].toUpperCase() +
                          UNIT_NAMES[u].slice(1)}
                      </option>
                    ),
                  )}
                </select>
              </label>
            )}
            <label className="input-label">
              Road clearance · m
              <input
                aria-label="Lowest point above road"
                title="Height of the base model's lowest point above the road"
                type="number"
                step=".005"
                min=".005"
                max="2"
                value={clearance}
                onChange={(e) => setClearance(+e.target.value)}
                onBlur={() => {
                  if (clearance !== options.clearance)
                    apply({ ...options, clearance });
                }}
              />
            </label>
          </div>
          <p className="micro">
            Nose {options.forward} · up {options.up} in the exported file.
            Changes re-read the original files.
          </p>
        </div>
      ) : (
        <p className="micro">
          Import the model again to adjust its orientation or add parts.
        </p>
      )}
    </>
  );
}

export function PartList({
  geometry,
  highlight,
  onHighlight,
  onRole,
  onEnabled,
  onRemove,
}: {
  geometry: Geometry;
  highlight: string;
  onHighlight: (id: string) => void;
  onRole: (part: Part, role: string, radius: number) => void;
  onEnabled: (ids: string[], enabled: boolean) => void;
  onRemove: (file: string) => void;
}) {
  const row = (part: Part, toggle: boolean) => (
    <PartRow
      key={geometry.fingerprint + part.id}
      part={part}
      toggle={toggle}
      highlighted={highlight === part.id}
      onHighlight={() => onHighlight(highlight === part.id ? "" : part.id)}
      onChange={(role, radius) => onRole(part, role, radius)}
      onEnabled={(enabled) => onEnabled([part.id], enabled)}
    />
  );
  if (!geometry.sources)
    return (
      <div className="part-list">{geometry.parts.map((p) => row(p, true))}</div>
    );
  return (
    <div className="part-list">
      {geometry.sources.map((source, i) => {
        const parts = geometry.parts.filter((p) => p.source === i);
        const on = parts.filter((p) => p.enabled !== false).length;
        return (
          <div className="part-group" key={source.file}>
            <div className="part-group-head">
              <GroupCheckbox
                label={`${source.name} enabled`}
                checked={on === parts.length}
                mixed={on > 0 && on < parts.length}
                onChange={(enabled) =>
                  onEnabled(
                    parts.map((p) => p.id),
                    enabled,
                  )
                }
              />
              <span className="part-group-name" title={source.name}>
                {source.name}
              </span>
              <span className="part-tag">
                {source.base ? "Base" : "Added"} · {parts.length}
              </span>
              {!source.base && (
                <button
                  className="icon-button small"
                  title={`Remove ${source.name}`}
                  onClick={() => onRemove(source.file)}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
            {parts.map((p) => row(p, parts.length > 1))}
          </div>
        );
      })}
    </div>
  );
}

function GroupCheckbox({
  label,
  checked,
  mixed,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      title="Include in simulation"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

function PartRow({
  part,
  toggle,
  highlighted,
  onHighlight,
  onChange,
  onEnabled,
}: {
  part: Part;
  toggle: boolean;
  highlighted: boolean;
  onHighlight: () => void;
  onChange: (role: string, radius: number) => void;
  onEnabled: (enabled: boolean) => void;
}) {
  const [radius, setRadius] = useState(
    part.wheel?.radius ||
      Math.max(0.01, (part.bounds[1][2] - part.bounds[0][2]) / 2),
  );
  const enabled = part.enabled !== false;
  return (
    <div
      className={`part-row ${highlighted ? "highlighted" : ""} ${enabled ? "" : "disabled"}`}
    >
      {toggle && (
        <input
          type="checkbox"
          aria-label={`${part.name} enabled`}
          title="Include in simulation"
          checked={enabled}
          onChange={(e) => onEnabled(e.target.checked)}
        />
      )}
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
