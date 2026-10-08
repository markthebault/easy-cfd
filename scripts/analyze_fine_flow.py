"""Check native field fidelity and decode the rendered movie before delivering it."""

import argparse
import gzip
import json
import re
import subprocess
from pathlib import Path

import numpy as np


def analyze(run, video=None):
    record = json.loads((run / "record.json").read_text())
    manifest = json.loads((run / "animation/manifest.json").read_text())
    if manifest["version"] != 2:
        raise ValueError("Expected native detailed sections.")
    times = np.array([f["time"] for f in manifest["frames"]])
    if len(times) < 189 or len(times) > 195 or times[0] != 0 or not np.all(np.diff(times) > 0):
        raise ValueError("Detailed physical timestamps are incomplete or unordered.")
    low, high = np.array(record["geometry"]["bounds"])
    freestream = manifest["freestream"]
    report = dict(
        run=record["id"],
        frames=len(times),
        physical_duration_s=float(times[-1]),
        warmup_s=manifest["warmupSeconds"],
        warmup_passes=manifest["warmupPasses"],
        frame_interval_s=dict(
            min=float(np.min(np.diff(times))),
            max=float(np.max(np.diff(times))),
            mean=float(np.mean(np.diff(times))),
        ),
        model=manifest["model"],
        source_sha256=manifest.get("source_sha256"),
        sections={},
    )
    report["cells"] = record.get("result", {}).get("cells")
    for plane in manifest["sections"]:
        dims = plane["dims"]
        n = int(np.prod(dims))
        x = plane["origin"][0] + np.tile(np.arange(dims[0]), dims[1] * dims[2]) * plane["spacing"][0]
        wake = (x >= high[0] - 0.05 * (high[0] - low[0])) & (x <= high[0] + (high[0] - low[0]))
        mask = first = previous = None
        maxima, minima, changes, accum, squares = [], [], [], None, None
        for i in range(len(times)):
            raw = gzip.decompress(
                (run / "animation/sections" / plane["id"] / f"frame-{i}.bin.gz").read_bytes()
            )
            if len(raw) != 21 * n:
                raise ValueError("Unexpected native frame size.")
            values = np.frombuffer(raw, dtype="<f4", count=5 * n).reshape(5, n)
            valid = np.frombuffer(raw, dtype="u1", offset=20 * n).astype(bool)
            if not np.isfinite(values[:, valid]).all() or np.any(values[:, ~valid] != 0):
                raise ValueError("Field values or solid-body masking are invalid.")
            if mask is None:
                mask = valid.copy()
                first = values[:3].copy()
                wake &= mask
                accum, squares = np.zeros((3, int(wake.sum()))), np.zeros((3, int(wake.sum())))
            elif not np.array_equal(mask, valid):
                raise ValueError("Fixed-mesh section masks changed across time.")
            speed = np.linalg.norm(values[:3, valid], axis=0)
            maxima.append(float(speed.max()))
            minima.append(float(speed.min()))
            if maxima[-1] > 4 * freestream or np.min(values[4, valid]) < -1e-5:
                raise ValueError("Unbounded velocity or negative turbulence energy requires investigation.")
            v = values[:3, wake].astype(np.float64)
            accum += v
            squares += v * v
            if previous is not None:
                changes.append(float(np.sqrt(np.mean(np.sum((v - previous) ** 2, axis=0)))))
            previous = v
        variance = np.maximum(0, squares / len(times) - (accum / len(times)) ** 2)
        first_last = np.linalg.norm(values[:3] - first, axis=0)
        report["sections"][plane["id"]] = dict(
            dims=dims,
            in_plane_spacing_m=[s for a, s in enumerate(plane["spacing"]) if a != plane["axis"]],
            fluid_points=int(mask.sum()),
            sampled_points=n,
            wake_points=int(wake.sum()),
            speed_min_ms=min(minima),
            speed_max_ms=max(maxima),
            first_last_change_fraction=float(np.mean(first_last[mask] > 0.1)),
            wake_temporal_rms_ms=float(np.sqrt(np.mean(np.sum(variance, axis=0)))),
            adjacent_wake_rms_ms=dict(mean=float(np.mean(changes)), max=float(np.max(changes))),
        )
    case = run / "animation-case"
    if (case / "log.pimpleFoam").exists():
        log = (case / "log.pimpleFoam").read_text(errors="replace")
        courants = [
            float(v)
            for v in re.findall(r"Courant Number mean: [\d.eE+-]+ max: ([\d.eE+-]+)", log)
        ]
        report["solver"] = dict(
            ended="End\n" in log,
            max_courant=max(courants, default=0),
            # OpenFOAM reports the initial candidate before adjusting the first dt.
            startup_courant=courants[0] if courants else None,
            max_courant_after_startup=max(courants[1:], default=0),
            maximum_global_continuity_error=float(
                max((abs(float(v)) for v in re.findall(r"global = ([\d.eE+-]+)", log)), default=0)
            ),
            steps=len(re.findall(r"^Time = ", log, re.MULTILINE)),
        )
    if video:
        probe = json.loads(
            subprocess.check_output(
                ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(video)]
            )
        )
        stream = next(s for s in probe["streams"] if s["codec_type"] == "video")
        frames = int(stream["nb_frames"])
        process = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(video),
                "-vf",
                "crop=iw*0.58:ih*0.6:iw*0.37:ih*0.18,scale=240:144",
                "-pix_fmt",
                "gray",
                "-f",
                "rawvideo",
                "-",
            ],
            capture_output=True,
            check=True,
        )
        if process.stderr:
            raise ValueError("The encoded movie contains decoding errors.")
        decoded = np.frombuffer(process.stdout, dtype="u1").reshape(-1, 144, 240)
        if len(decoded) != frames:
            raise ValueError("The complete video did not decode.")
        delta = np.mean(np.abs(np.diff(decoded.astype(np.float32), axis=0)), axis=(1, 2))
        chapters = [
            delta[a : b - 1]
            for a, b in [(0, frames // 3), (frames // 3, 2 * frames // 3), (2 * frames // 3, frames)]
        ]
        report["video"] = dict(
            path=str(video),
            width=stream["width"],
            height=stream["height"],
            codec=stream["codec_name"],
            fps=stream["avg_frame_rate"],
            duration_s=float(probe["format"]["duration"]),
            decoded_frames=len(decoded),
            chapter_motion=[
                dict(mean_pixel_change=float(d.mean()), changed_frame_fraction=float(np.mean(d > 0.05)))
                for d in chapters
            ],
        )
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--video", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = analyze(args.run, args.video)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
