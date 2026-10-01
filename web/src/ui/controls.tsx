// Small form controls with a consistent look.

import { useEffect, useId, useState, type ReactNode } from "react";

export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label?: string;
  size?: "sm" | "md";
}) {
  return (
    <div className={`segmented ${props.size ?? "md"}`} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          className={o.value === props.value ? "on" : ""}
          title={o.title}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return (
    <label className={`toggle ${props.disabled ? "disabled" : ""}`} htmlFor={id}>
      <span className="toggle-text">
        <span>{props.label}</span>
        {props.hint && <small>{props.hint}</small>}
      </span>
      <input id={id} type="checkbox" role="switch" aria-label={typeof props.label === "string" ? props.label : undefined} checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
    </label>
  );
}

export function Checkbox(props: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  const id = useId();
  return (
    <label className="boundary-checkbox" htmlFor={id}>
      <input id={id} type="checkbox" aria-label={props.label} aria-describedby={`${id}-hint`} checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span><b>{props.label}</b><small id={`${id}-hint`}>{props.hint}</small></span>
    </label>
  );
}

/** Number input that only commits valid values (on blur / Enter), so typing never fights the state. */
export function NumberField(props: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  label?: string;
  digits?: number;
  width?: number;
  invalid?: boolean;
}) {
  const format = (v: number) => (props.digits !== undefined ? v.toFixed(props.digits) : String(v));
  const [text, setText] = useState(format(props.value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(format(props.value));
  }, [props.value, focused]);
  const commit = () => {
    const v = Number(text.replace(",", "."));
    if (Number.isFinite(v)) {
      const c = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v));
      props.onChange(c);
      setText(format(c));
    } else setText(format(props.value));
  };
  return (
    <span className={`number-field ${props.invalid ? "invalid" : ""}`} style={props.width ? { width: props.width } : undefined}>
      <input
        type="text"
        inputMode="decimal"
        aria-label={props.label}
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const step = (props.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
            const c = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, +(props.value + step).toFixed(6)));
            props.onChange(c);
            setText(format(c));
          }
        }}
      />
      {props.unit && <span className="unit">{props.unit}</span>}
    </span>
  );
}

export function Slider(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  label: string;
  display?: ReactNode;
}) {
  const t = (props.value - props.min) / (props.max - props.min);
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{props.label}</span>
        <output>{props.display ?? props.value}</output>
      </span>
      <input
        type="range"
        aria-label={props.label}
        aria-valuetext={typeof props.display === "string" ? props.display : undefined}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        style={{ ["--t" as string]: `${Math.min(1, Math.max(0, t)) * 100}%` }}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Field(props: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div className="field-body">{props.children}</div>
      {props.hint && <small className="field-hint">{props.hint}</small>}
    </div>
  );
}

export function Badge(props: { kind: "ok" | "warn" | "error" | "info" | "neutral"; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${props.kind}`} title={props.title}>
      {props.children}
    </span>
  );
}
