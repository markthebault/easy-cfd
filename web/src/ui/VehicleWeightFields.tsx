import type { VehicleWeight } from "../solver/types";
import { weightInputError } from "../solver/tyreLoads";
import { Field } from "./controls";

export function VehicleWeightFields({value, onChange}: {value: VehicleWeight; onChange: (patch: Partial<VehicleWeight>) => void}) {
  const error = weightInputError(value);
  const input = (key: keyof VehicleWeight, label: string, unit: string, min: number, max: number) => (
    <Field label={label}>
      <span className="number-field">
        <input type="number" inputMode="decimal" aria-label={label} min={min} max={max} step="any"
          value={value[key] ?? ""} aria-invalid={!!error}
          onChange={e => onChange({[key]: Number.isFinite(e.currentTarget.valueAsNumber) ? e.currentTarget.valueAsNumber : undefined})} />
        <span className="unit">{unit}</span>
      </span>
    </Field>
  );
  return <>
    <div className="box-grid">
      {input("vehicle_mass_kg", "Car mass", "kg", 1, 10000)}
      {input("front_weight_percent", "Front weight", "%", 0, 100)}
    </div>
    <p className="field-hint">Include driver and fuel. Front weight is the static percentage on the front tyres; the rear carries the remainder.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}
  </>;
}
