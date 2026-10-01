from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class SimulationBox(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    x_min: float = Field(ge=-1000, le=1000)
    x_max: float = Field(ge=-1000, le=1000)
    y_min: float = Field(ge=-1000, le=1000)
    y_max: float = Field(ge=-1000, le=1000)
    z_max: float = Field(gt=0, le=1000)

    @model_validator(mode="after")
    def ordered(self):
        if self.x_min >= self.x_max or self.y_min >= self.y_max:
            raise ValueError("Simulation box minimum coordinates must be below maximum coordinates.")
        return self


class Axles(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    frontX: float
    rearX: float
    centrelineY: float = 0
    confirmed: bool = False

    @model_validator(mode="after")
    def ordered(self):
        if self.rearX <= self.frontX:
            raise ValueError("Front axle X must be smaller than rear axle X.")
        return self


class Settings(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    profile: Literal["basic", "regular", "advanced1", "advanced2"] | None = None
    axles: Axles | None = None
    # Postprocessing inputs, independent of the airflow boundary conditions.
    vehicle_mass_kg: float | None = Field(default=None, gt=0, le=10000)
    front_weight_percent: float | None = Field(default=None, ge=0, le=100)
    moment_origin: tuple[float, float, float] | None = None
    part_labels: dict[str, dict[str, str]] = Field(default_factory=dict)
    refine_groups: list[str] | None = None
    refine_underfloor: bool = True
    max_seconds: int | None = Field(default=None, ge=30, le=43200)
    speed_kmh: float = Field(default=100, ge=5, le=300)
    yaw_deg: float = Field(default=0, ge=-20, le=20)
    quality: Literal["fast", "medium", "precise", "custom"] = "medium"
    simulation_box: SimulationBox | None = None
    custom_mesh: Literal["fast", "medium", "precise"] = "medium"
    custom_iterations: int = Field(default=1000, ge=50, le=20000, strict=True)
    reference_area: float = Field(default=2.2, gt=0.001, le=100)
    density: float = Field(default=1.225, ge=0.8, le=1.5)
    moving_ground: bool = True
    wheels: bool = True
    geometry_confirmed: bool = False

    @model_validator(mode="after")
    def profile_deadline(self):
        ceiling = {"basic": 300, "regular": 600, "advanced1": 10800, "advanced2": 43200}.get(self.profile)
        if ceiling and self.max_seconds and self.max_seconds > ceiling:
            raise ValueError(f"This profile permits at most {ceiling} seconds for the whole job.")
        return self


class NewProject(BaseModel):
    name: str = Field(default="My wind tunnel", min_length=1, max_length=100)
    sample: bool = True
    wing: bool = False


class ImportOptions(BaseModel):
    components: Literal["split", "group"] = "split"
    units: Literal["m", "mm", "cm", "in"] = "m"
    forward: Literal["+X", "-X", "+Y", "-Y", "+Z", "-Z"] = "-X"
    up: Literal["+X", "-X", "+Y", "-Y", "+Z", "-Z"] = "+Z"
    clearance: float = Field(default=0.01, ge=0.005, le=2)

    @model_validator(mode="after")
    def independent_axes(self):
        if self.forward[-1] == self.up[-1]:
            raise ValueError("Forward and up must use different axes.")
        return self


# Conservative initial budgets, not accuracy or runtime promises. Calibrate against measured runs.
PRESETS = {
    "fast": dict(
        cell=0.65,
        surface=2,
        wake=1,
        layers=0,
        max_cells=350000,
        iterations=300,
        residual=1e-3,
        label="Exploratory",
        memory_gb=3,
    ),
    "medium": dict(
        cell=0.5,
        surface=3,
        wake=2,
        layers=6,
        max_cells=1400000,
        iterations=1000,
        residual=1e-4,
        label="Design comparison",
        memory_gb=5,
    ),
    "precise": dict(
        cell=0.4,
        surface=3,
        wake=2,
        layers=8,
        max_cells=2400000,
        iterations=1800,
        residual=1e-5,
        label="Refinement check",
        memory_gb=6,
    ),
}


ADVANCED = {
    "advanced1": dict(
        cell=0.4,
        surface=3,
        wake=2,
        layers=8,
        max_cells=1_000_000,
        iterations=6000,
        residual=1e-5,
        label="Advanced level 1",
        memory_gb=5,
    ),
    "advanced2_1": dict(
        cell=0.63,
        surface=3,
        wake=2,
        layers=8,
        max_cells=500_000,
        iterations=10000,
        residual=1e-5,
        label="Advanced 2 · coarse",
        memory_gb=6,
    ),
    "advanced2_2": dict(
        cell=0.5,
        surface=3,
        wake=2,
        layers=8,
        max_cells=1_000_000,
        iterations=10000,
        residual=1e-5,
        label="Advanced 2 · medium",
        memory_gb=6,
    ),
    "advanced2_3": dict(
        cell=0.4,
        surface=3,
        wake=2,
        layers=8,
        max_cells=2_000_000,
        iterations=10000,
        residual=1e-5,
        label="Advanced 2 · fine",
        memory_gb=6,
    ),
}


def resolved_preset(settings: Settings, quality=None):
    if quality in ADVANCED:
        return dict(ADVANCED[quality])
    if settings.profile == "advanced1":
        return dict(ADVANCED["advanced1"])
    if settings.profile == "advanced2":
        return dict(ADVANCED["advanced2_3"])

    tier = quality or settings.quality
    if tier == "custom":
        return {**PRESETS[settings.custom_mesh], "iterations": settings.custom_iterations}
    return dict(PRESETS[tier])
