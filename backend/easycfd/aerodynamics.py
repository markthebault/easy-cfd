"""Wall integration conventions shared by extraction and manufactured verification."""

from pathlib import Path
import gzip
import re
import numpy as np


VERSION = "openfoam-wall-integrals-2"
GRAVITY = 9.80665


def tyre_loads(balance, settings):
    """Level-road steady support loads per tyre pair; preserve negative equilibrium demands."""
    mass = settings.get("vehicle_mass_kg")
    front_percent = settings.get("front_weight_percent")
    if not balance or mass is None or front_percent is None:
        return None
    if not np.isfinite([mass, front_percent, balance["frontLift"], balance["rearLift"]]).all():
        return None
    if not 0 < mass <= 10000 or not 0 <= front_percent <= 100:
        return None
    front_static = mass * GRAVITY * front_percent / 100
    rear_static = mass * GRAVITY - front_static
    front = dict(
        staticN=front_static, aerodynamicN=-balance["frontLift"], totalN=front_static - balance["frontLift"]
    )
    rear = dict(
        staticN=rear_static, aerodynamicN=-balance["rearLift"], totalN=rear_static - balance["rearLift"]
    )
    return dict(
        version="steady-axle-loads-1",
        massKg=mass,
        frontWeightPercent=front_percent,
        gravity=GRAVITY,
        front=front,
        rear=rear,
        contactFeasible=bool(front["totalN"] >= 0 and rear["totalN"] >= 0),
    )


def stress_factor(case: Path, iteration: float, density: float) -> float | None:
    """v2412 wallShearStress is wall-on-fluid; negate for fluid traction on car.

    Its dimensions follow devReff or devRhoReff. Convert kinematic stress exactly once.
    Source: src/functionObjects/field/wallShearStress/wallShearStress.C,
    calcShearStress: (-Sf/magSf) & Reff. forces.C uses +Sf & devRhoReff.
    """
    path = case / f"{iteration:g}" / "wallShearStress"
    if not path.exists() and path.with_suffix(".gz").exists():
        header = gzip.open(path.with_suffix(".gz"), "rb").read(4096)
    elif path.exists():
        with path.open("rb") as stream:
            header = stream.read(4096)
    else:
        return None
    dims = re.search(rb"dimensions\s*\[([^]]+)\]", header)
    if not dims:
        raise RuntimeError("Wall stress has no readable dimension declaration.")
    values = tuple(float(v) for v in dims.group(1).split())
    if values == (0, 2, -2, 0, 0, 0, 0):
        return -density
    if values == (1, -1, -2, 0, 0, 0, 0):
        return -1.0
    raise RuntimeError(f"Unsupported wall stress dimensions: {values}.")


def output_rows(case, name, kind):
    rows = {}
    for file in sorted((case / f"postProcessing/{name}").glob(f"*/{kind}.dat")):
        lines = file.read_text().splitlines()
        header = " ".join(line for line in lines if line.startswith("#"))
        if not all(k in header for k in ("total_x", "pressure_x", "viscous_x")):
            raise RuntimeError(f"Unrecognized {kind} vector format for {name}.")
        for line in lines:
            if line and not line.startswith("#"):
                row = np.fromstring(line, sep=" ")
                if len(row) != 10 or not np.isfinite(row).all():
                    raise RuntimeError(f"Invalid {kind} vector row for {name}.")
                rows[float(row[0])] = row
    return rows


def integrals(case, run, times):
    """Exactly the same iteration rows, uniform weights, for every force and moment."""
    total_force = output_rows(case, "forcesTotal", "force")
    total_moment = output_rows(case, "forcesTotal", "moment")
    if not total_force:
        return {}  # old runs remain readable, without invented moments

    def read(name):
        f, m = output_rows(case, name, "force"), output_rows(case, name, "moment")
        if any(t not in f or t not in m for t in times):
            raise RuntimeError(f"{name} is missing samples from the whole-car averaging window.")
        af, am = np.mean([f[t] for t in times], axis=0), np.mean([m[t] for t in times], axis=0)
        return dict(
            pressure=af[4:7].tolist(),
            friction=af[7:10].tolist(),
            pressureMoment=am[4:7].tolist(),
            frictionMoment=am[7:10].tolist(),
        )

    total = read("forcesTotal")
    origin = run["settings"].get("moment_origin")
    a = run["settings"].get("axles")
    if origin is None:
        origin = [a["frontX"], a["centrelineY"], 0] if a and a["confirmed"] else [0, 0, 0]
    force = np.array(total["pressure"]) + total["friction"]
    moment = np.array(total["pressureMoment"]) + total["frictionMoment"]
    parts = []
    for part in run["geometry"]["parts"]:
        label = run["settings"].get("part_labels", {}).get(part["id"], {})
        parts.append(
            dict(
                id=label.get("id", part["id"]),
                name=label.get("name", part["name"]),
                group=label.get("group"),
                patch=part["id"],
                **read("forces_" + part["id"]),
            )
        )

    def reconcile(key1, key2, reference):
        vectors = [np.array(p[key1]) + p[key2] for p in parts]
        return float(np.linalg.norm(sum(vectors) - reference)), max(
            1e-4, 0.005 * sum(np.linalg.norm(v) for v in vectors)
        )

    fe, ft = reconcile("pressure", "friction", force)
    me, mt = reconcile("pressureMoment", "frictionMoment", moment)
    histories = {
        t: dict(force=total_force[t][1:4].tolist(), moment=total_moment[t][1:4].tolist())
        for t in total_force
        if t in total_moment
    }
    return dict(
        aero=dict(
            force=force.tolist(),
            moment=moment.tolist(),
            origin=origin,
            pressureMoment=total["pressureMoment"],
            frictionMoment=total["frictionMoment"],
        ),
        part_forces=parts,
        reconciliation=dict(
            forceError=fe,
            momentError=me,
            forceTolerance=ft,
            momentTolerance=mt,
            complete=bool(fe <= ft and me <= mt),
        ),
        vector_history=histories,
        provenance=dict(
            version=VERSION,
            averaging=dict(start=times[0], end=times[-1], unit="iteration"),
            origin=origin,
            qualification="exploratory",
        ),
    )


def balance_diagnostics(history, times, axles):
    """Observed spread and drift on the identical force/moment averaging window.

    These are settling diagnostics, not estimates of physical prediction error.
    """
    window = [h for h in history if h["iteration"] in set(times) and "moment" in h]
    if len(window) != len(times) or len(window) < 4:
        return {"balance_settled": None, "balance_bands": {}}
    quantities = {"pitch": np.array([h["moment"][1] for h in window])}
    if axles and axles.get("confirmed"):
        length = axles["rearX"] - axles["frontX"]
        quantities["rearLift"] = -quantities["pitch"] / length
        quantities["frontLift"] = np.array([h["force"][2] for h in window]) - quantities["rearLift"]
    settled = True
    bands = {}
    for key, values in quantities.items():
        bands[key] = float(np.ptp(values) / 2)
        half = len(values) // 2
        drift = abs(float(values[:half].mean() - values[half:].mean()))
        floor = 0.05 if key == "pitch" else 0.1
        settled &= drift <= max(floor, 0.04 * abs(float(values.mean())))
    return {"balance_settled": bool(settled), "balance_bands": bands}


def equivalent_loads(force, moment, axles, q_area):
    """Equivalent aero forces at axles, including the road-plane pitching effect of drag."""
    if not axles or not axles.get("confirmed") or q_area <= 0:
        return None
    wheelbase = axles["rearX"] - axles["frontX"]
    rear = -moment[1] / wheelbase
    front = force[2] - rear
    values = dict(
        frontLift=front,
        rearLift=rear,
        frontCl=front / q_area,
        rearCl=rear / q_area,
        pitch=moment[1],
        wheelbase=wheelbase,
    )
    if force[2] < -1e-4 and front <= 0 and rear <= 0:
        values["frontDownforcePercent"] = 100 * front / force[2]
    else:
        values["percentageReason"] = (
            "Total lift is within 0.0001 N of zero; a balance percentage is undefined."
            if abs(force[2]) <= 1e-4
            else "Both axles must push downward to show a downforce percentage."
        )
    return values
