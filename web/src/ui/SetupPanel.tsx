// The ① Car → ② Conditions → ③ Run flow. Only the active step is open; the others collapse to a
// one-line summary that reopens them.

import { Check, ChevronRight } from "lucide-react";
import { useStore } from "../store/store";
import { app, goStep, type Step } from "../store/app";
import { CarStep } from "./CarStep";
import { ConditionsStep } from "./ConditionsStep";
import { RunStep } from "./RunStep";
import { fmt, qualityLabel } from "./format";

export function SetupPanel() {
  const step = useStore(app, (s) => s.step);
  const design = useStore(app, (s) => s.design);
  const report = useStore(app, (s) => s.report);
  const parts = useStore(app, (s) => s.parts);
  const confirmed = useStore(app, (s) => s.confirmed);
  if (!design) return null;
  const s = design.settings;
  const carDone = confirmed && !!report && report.errors.length === 0;
  const d = report?.dimensions ?? [0, 0, 0];
  const order: Step[] = ["car", "conditions", "run"];
  const idx = order.indexOf(step);
  const steps: { id: Step; title: string; summary: string; done: boolean; locked: boolean }[] = [
    {
      id: "car",
      title: "Car",
      summary: `${fmt(d[0], 2)} × ${fmt(d[1], 2)} × ${fmt(d[2], 2)} m · ${parts.filter((p) => p.enabled).length} parts${carDone ? "" : " · not checked"}`,
      done: carDone,
      locked: false,
    },
    {
      id: "conditions",
      title: "Conditions",
      summary: `${Math.round(s.speed_kmh)} km/h · ${s.yaw_deg}° yaw · ${fmt(s.reference_area, 2)} m²${s.simulation_box ? " · custom box" : ""}`,
      done: carDone && idx > 1,
      locked: !carDone,
    },
    { id: "run", title: "Run", summary: qualityLabel(s), done: false, locked: !carDone },
  ];

  return (
    <div className="steps">
      {steps.map((st, i) => {
        const open = st.id === step;
        return (
          <section key={st.id} className={`step ${open ? "open" : ""} ${st.done ? "done" : ""} ${st.locked ? "locked" : ""}`}>
            <button className="step-head" disabled={open || st.locked} onClick={() => goStep(st.id)} aria-expanded={open} data-testid={`step-${st.id}`}>
              <span className="step-num">{st.done && !open ? <Check size={14} strokeWidth={3} /> : i + 1}</span>
              <span className="step-title">{st.title}</span>
              {!open && <span className="step-summary">{st.locked ? "Check the car first" : st.summary}</span>}
              {!open && !st.locked && <ChevronRight size={16} className="step-chev" />}
            </button>
            {open && (st.id === "car" ? <CarStep /> : st.id === "conditions" ? <ConditionsStep /> : <RunStep />)}
          </section>
        );
      })}
    </div>
  );
}
