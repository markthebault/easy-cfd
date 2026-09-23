import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { fmt } from "./ui";

// Standard gravity: 1 kgf = 9.80665 N. Saved downforce is positive downward.
const STANDARD_GRAVITY = 9.80665;

export default function VerticalLoad({
  downforce,
  speed,
}: {
  downforce: number;
  speed: number;
}) {
  const direction =
    downforce > 0 ? "downforce" : downforce < 0 ? "lift" : "neutral";
  const label =
    direction === "neutral"
      ? "No net vertical force"
      : direction === "lift"
        ? "Lift"
        : "Downforce";
  const Icon =
    direction === "downforce"
      ? ArrowDown
      : direction === "lift"
        ? ArrowUp
        : Minus;
  const kg = Math.abs(downforce) / STANDARD_GRAVITY;
  return (
    <article
      className={`metric vertical-load ${direction}`}
      aria-label="Vertical aerodynamic load"
    >
      <span>
        <Icon size={16} aria-hidden="true" /> {label}
      </span>
      <strong>
        {kg > 0 && kg < 0.1 ? "<0.1" : fmt(kg, 1)} <small>kg</small>
      </strong>
      <p>
        At {speed} km/h · {fmt(Math.abs(downforce))} N
      </p>
      <p>
        {direction === "downforce"
          ? "Pushes the car onto the road"
          : direction === "lift"
            ? "Lifts the car away from the road"
            : "No upward or downward load"}
      </p>
      <p className="micro">Equivalent weight · force in N ÷ 9.80665</p>
    </article>
  );
}
