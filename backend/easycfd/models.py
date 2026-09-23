from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class Settings(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    speed_kmh: float = Field(default=100, ge=5, le=300)
    yaw_deg: float = Field(default=0, ge=-20, le=20)
    quality: Literal["fast", "medium", "precise"] = "medium"
    reference_area: float = Field(default=2.2, gt=0.001, le=100)
    density: float = Field(default=1.225, ge=0.8, le=1.5)
    moving_ground: bool = True
    wheels: bool = True
    geometry_confirmed: bool = False


class NewProject(BaseModel):
    name: str = Field(default="My wind tunnel", min_length=1, max_length=100)
    sample: bool = True
    wing: bool = False


class ImportOptions(BaseModel):
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
