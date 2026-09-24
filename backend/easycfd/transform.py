"""Rigid rotations, uniform scaling, and translation of current geometry."""

from typing import Annotated
import copy
import shutil
import numpy as np
import trimesh
from pydantic import BaseModel, ConfigDict, Field
from . import geometry


class TransformOptions(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="forbid")
    revision: str
    part_ids: list[str] = Field(min_length=1, max_length=100)
    rotation: tuple[
        Annotated[float, Field(ge=-36000, le=36000)],
        Annotated[float, Field(ge=-36000, le=36000)],
        Annotated[float, Field(ge=-36000, le=36000)],
    ] = (0, 0, 0)
    translation: tuple[
        Annotated[float, Field(ge=-1000, le=1000)],
        Annotated[float, Field(ge=-1000, le=1000)],
        Annotated[float, Field(ge=-1000, le=1000)],
    ] = (0, 0, 0)
    scale: float = Field(default=1, ge=0.0001, le=10000)
    keep_clearance: bool = True


def prepare(folder, target, current, options):
    parts = current["parts"]
    selected = set(options.part_ids)
    if not selected <= {p["id"] for p in parts}:
        raise ValueError("Unknown object selected.")
    meshes = [trimesh.load_mesh(folder / f"{p['id']}.stl") for p in parts]
    indices = [i for i, p in enumerate(parts) if p["id"] in selected]
    low = np.min([meshes[i].bounds[0] for i in indices], axis=0)
    high = np.max([meshes[i].bounds[1] for i in indices], axis=0)
    center = (low + high) / 2
    # Column-vector convention: scale, then world X, Y, Z rotations.
    angles = np.deg2rad(np.remainder(options.rotation, 360))
    rotation = trimesh.transformations.euler_matrix(*angles, axes="sxyz")[:3, :3]
    matrix = np.eye(4)
    matrix[:3, :3] = rotation * options.scale
    matrix[:3, 3] = center - matrix[:3, :3] @ center
    for i in indices:
        meshes[i].apply_transform(matrix)
    lift = low[2] - min(meshes[i].bounds[0, 2] for i in indices) if options.keep_clearance else 0
    offset = np.array(options.translation) + [0, 0, lift]
    matrix[:3, 3] += offset
    for i in indices:
        meshes[i].apply_translation(offset)
    pieces = []
    for i, (part, mesh) in enumerate(zip(parts, meshes)):
        wheel = part.get("wheel")
        if wheel and i in indices:
            wheel = dict(
                wheel,
                center=trimesh.transform_points([wheel["center"]], matrix)[0].tolist(),
                radius=wheel["radius"] * options.scale,
                axis=(rotation @ np.array(wheel.get("axis", [0, 1, 0]))).tolist(),
            )
        extra = {k: part[k] for k in ("source", "component", "enabled", "grouped_components") if k in part}
        pieces.append((part["name"], mesh, part["role"], wheel, extra))
    data = geometry.persist_parts(target, pieces)
    # Unselected objects retain both their exact asset bytes and metadata.
    for i, part in enumerate(parts):
        if part["id"] not in selected:
            for suffix in ("stl", "vtp"):
                shutil.copy2(folder / f"{part['id']}.{suffix}", target / f"{part['id']}.{suffix}")
            data["parts"][i] = copy.deepcopy(part)
    data.update(geometry.summarize(target, data["parts"]))
    for name in ("sources", "import_options", "repaired", "repair_summary", "seal_summary"):
        if name in current:
            data[name] = current[name]
    data["transformed"] = True
    data["transform_summary"] = dict(
        rotation=list(options.rotation),
        scale=options.scale,
        translation=list(options.translation),
        clearance_adjustment=float(lift),
        pivot=center.tolist(),
        selected_parts=len(indices),
    )
    return data
