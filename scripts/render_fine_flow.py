"""Render an inspectable CFD movie from recorded solver fields, without synthetic turbulence.

Usage: uv run python scripts/render_fine_flow.py --run PATH --output airflow.mp4
The simulation clock is interpolated within saved adjacent frames, never across a loop seam.
"""

import argparse
import gzip
import json
import subprocess
from pathlib import Path

import numpy as np
import vtk
from vtk.util.numpy_support import numpy_to_vtk, vtk_to_numpy

FLOW_COLORS = ["281c83", "285bea", "24bad1", "79dcb5", "efec59", "f39839", "c5263b"]


class Recording:
    def __init__(self, folder, section):
        self.folder = folder
        self.manifest = json.loads((folder / "manifest.json").read_text())
        self.plane = next(p for p in self.manifest["sections"] if p["id"] == section)
        self.times = np.array([f["time"] for f in self.manifest["frames"]])
        if len(self.times) < 2 or not np.all(np.diff(self.times) > 0):
            raise ValueError("Recording must contain increasing computed timestamps.")
        self.n = int(np.prod(self.plane["dims"]))
        self.cache = {}

    def frame(self, index):
        if index not in self.cache:
            path = self.folder / "sections" / self.plane["id"] / f"frame-{index}.bin.gz"
            raw = gzip.decompress(path.read_bytes())
            if len(raw) != 21 * self.n:
                raise ValueError("Recorded field has an unexpected size.")
            fields = np.frombuffer(raw, dtype="<f4", count=5 * self.n).reshape(5, self.n)
            valid = np.frombuffer(raw, dtype="u1", offset=20 * self.n).astype(bool)
            if not np.isfinite(fields[:, valid]).all():
                raise ValueError("Cannot render non-finite CFD data.")
            self.cache[index] = (fields, valid)
        return self.cache[index]

    def sample(self, time):
        time = np.clip(time, self.times[0], self.times[-1])
        i = min(len(self.times) - 2, max(0, int(np.searchsorted(self.times, time, side="right")) - 1))
        a, mask = self.frame(i)
        b, next_mask = self.frame(i + 1)
        if not np.array_equal(mask, next_mask):
            raise ValueError("Fixed-mesh recordings must retain the same fluid mask.")
        f = (time - self.times[i]) / (self.times[i + 1] - self.times[i])
        velocity = a[:3] * (1 - f) + b[:3] * f
        self.cache = {k: v for k, v in self.cache.items() if k in (i, i + 1)}
        return velocity, mask


def text(renderer, value, x, y, size, bold=False):
    actor = vtk.vtkTextActor()
    actor.SetInput(value)
    actor.GetPositionCoordinate().SetCoordinateSystemToNormalizedViewport()
    actor.SetPosition(x, y)
    prop = actor.GetTextProperty()
    prop.SetFontFamilyToArial()
    prop.SetFontSize(size)
    prop.SetBold(bold)
    prop.SetColor(0.93, 0.95, 0.98)
    renderer.AddViewProp(actor)
    return actor


def rectangle(renderer, y0, y1):
    points = vtk.vtkPoints()
    for point in [(0, y0, 0), (1, y0, 0), (1, y1, 0), (0, y1, 0)]:
        points.InsertNextPoint(point)
    cells = vtk.vtkCellArray()
    cells.InsertNextCell(4, (0, 1, 2, 3))
    data = vtk.vtkPolyData()
    data.SetPoints(points)
    data.SetPolys(cells)
    coordinate = vtk.vtkCoordinate()
    coordinate.SetCoordinateSystemToNormalizedViewport()
    mapper = vtk.vtkPolyDataMapper2D()
    mapper.SetInputData(data)
    mapper.SetTransformCoordinate(coordinate)
    actor = vtk.vtkActor2D()
    actor.SetMapper(mapper)
    actor.GetProperty().SetColor(0.025, 0.038, 0.055)
    actor.GetProperty().SetOpacity(1)
    renderer.AddViewProp(actor)


class Movie:
    def __init__(self, run, width, height, title="Computed airflow"):
        self.root = run
        self.record = json.loads((run / "record.json").read_text())
        manifest = run / "animation/manifest.json"
        freestream = (
            json.loads(manifest.read_text())["freestream"]
            if manifest.exists()
            else self.record["settings"]["speed_kmh"] / 3.6
        )
        self.width, self.height = width, height
        self.renderer = vtk.vtkRenderer()
        self.renderer.SetBackground(0.025, 0.038, 0.055)
        self.renderer.SetUseFXAA(True)
        self.window = vtk.vtkRenderWindow()
        self.window.SetOffScreenRendering(True)
        self.window.SetSize(width, height)
        self.window.SetMultiSamples(8)
        self.window.AddRenderer(self.renderer)
        for p in self.record["geometry"]["parts"]:
            reader = vtk.vtkSTLReader()
            reader.SetFileName(str(run / "geometry" / f"{p['id']}.stl"))
            normals = vtk.vtkPolyDataNormals()
            normals.SetInputConnection(reader.GetOutputPort())
            normals.SetFeatureAngle(45)
            normals.ConsistencyOn()
            normals.SplittingOff()
            mapper = vtk.vtkPolyDataMapper()
            mapper.SetInputConnection(normals.GetOutputPort())
            actor = vtk.vtkActor()
            actor.SetMapper(mapper)
            prop = actor.GetProperty()
            prop.SetColor(*((0.12, 0.14, 0.17) if p["role"] == "wheel" else (0.93, 0.95, 0.98)))
            prop.SetAmbient(0.75)
            prop.SetDiffuse(0.25)
            prop.SetSpecular(0.01)
            prop.SetSpecularPower(24)
            self.renderer.AddActor(actor)
        light = vtk.vtkLight()
        light.SetLightTypeToSceneLight()
        light.SetPosition(-6, -5, 14)
        light.SetFocalPoint(0, 0, 0.6)
        self.renderer.AddLight(light)
        self.colors = vtk.vtkLookupTable()
        self.colors.SetNumberOfTableValues(256)
        self.colors.SetRange(0, freestream * 1.4)
        stops = np.array([[int(c[i : i + 2], 16) / 255 for i in (0, 2, 4)] for c in FLOW_COLORS])
        for i in range(256):
            x = i / 255 * (len(stops) - 1)
            j = min(len(stops) - 2, int(x))
            self.colors.SetTableValue(i, *(stops[j] * (1 - x + j) + stops[j + 1] * (x - j)), 1)
        self.colors.Build()
        self.image_actor = vtk.vtkImageActor()
        self.image_actor.InterpolateOn()
        self.renderer.AddActor(self.image_actor)
        rectangle(self.renderer, 0.87, 1)
        rectangle(self.renderer, 0, 0.13)
        text(self.renderer, "EASYCFD", 0.035, 0.938, round(height * 0.023), True)
        text(self.renderer, title, 0.035, 0.889, round(height * 0.031), True)
        self.heading = text(self.renderer, "", 0.62, 0.914, round(height * 0.02))
        text(
            self.renderer,
            f"OpenFOAM 2412  /  DDES  /  {self.record['settings']['speed_kmh']:g} km/h"
            f"  /  Yaw {self.record['settings']['yaw_deg']:g}\N{DEGREE SIGN}",
            0.035,
            0.052,
            round(height * 0.018),
        )
        text(self.renderer, "Exploratory simulation", 0.035, 0.024, round(height * 0.014))
        self.clock = text(self.renderer, "", 0.785, 0.058, round(height * 0.019))
        self.slow = text(self.renderer, "", 0.785, 0.026, round(height * 0.014))
        bar = vtk.vtkScalarBarActor()
        bar.SetLookupTable(self.colors)
        bar.SetOrientationToHorizontal()
        bar.SetTitle("Air speed / m/s")
        bar.SetNumberOfLabels(5)
        bar.SetLabelFormat("%.0f")
        bar.SetPosition(0.36, 0.025)
        bar.SetWidth(0.35)
        bar.SetHeight(0.088)
        bar.GetTitleTextProperty().SetFontSize(round(height * 0.017))
        bar.GetLabelTextProperty().SetFontSize(round(height * 0.014))
        for prop in (bar.GetTitleTextProperty(), bar.GetLabelTextProperty()):
            prop.SetFontFamilyToArial()
            prop.SetItalic(False)
            prop.SetBold(False)
        self.renderer.AddViewProp(bar)
        self.capture = vtk.vtkWindowToImageFilter()
        self.capture.SetInput(self.window)
        self.capture.SetInputBufferTypeToRGB()
        self.capture.ReadFrontBufferOff()

    def view(self, recording, closeup=False):
        self.recording = recording
        p = recording.plane
        self.image = vtk.vtkImageData()
        self.image.SetDimensions(*p["dims"])
        self.image.SetOrigin(*p["origin"])
        self.image.SetSpacing(*p["spacing"])
        self.image_actor.GetMapper().SetInputData(self.image)
        self.image_actor.SetDisplayExtent(*self.image.GetExtent())
        lo = np.array(p["origin"])
        hi = lo + np.array(p["spacing"]) * (np.array(p["dims"]) - 1)
        center = (lo + hi) / 2
        normal = np.zeros(3)
        normal[p["axis"]] = -1 if p["axis"] == 1 else 1
        camera = self.renderer.GetActiveCamera()
        up = np.array([0, 1, 0]) if p["axis"] == 2 else np.array([0, 0, 1])
        car_low, car_high = np.array(self.record["geometry"]["bounds"])
        length = car_high[0] - car_low[0]
        if closeup:
            center[0] = car_high[0] + 0.43 * length
            span = length * 1.5
        else:
            center[0] = (car_low[0] + car_high[0]) / 2 + 0.375 * length
            span = length * 2.05
        camera.ParallelProjectionOn()
        camera.SetFocalPoint(*center)
        camera.SetPosition(*(center + normal * 40))
        camera.SetViewUp(*up)
        camera.SetParallelScale(span / (self.width / self.height) / 2 * 1.025)
        self.renderer.ResetCameraClippingRange()
        self.heading.SetInput("Wake close-up" if closeup else p["label"] + " section")

    def frame(self, time, seconds):
        velocity, mask = self.recording.sample(time)
        speed = np.linalg.norm(velocity, axis=0)
        scalar = numpy_to_vtk(speed.astype(np.float32), deep=True)
        scalar.SetName("Speed")
        self.image.GetPointData().SetScalars(scalar)
        mapped = self.colors.MapScalars(scalar, vtk.VTK_COLOR_MODE_MAP_SCALARS, 0, vtk.VTK_RGBA)
        rgba = vtk_to_numpy(mapped)
        rgba[~mask, 3] = 0
        mapped.Modified()
        self.image.GetPointData().SetScalars(mapped)
        self.image.Modified()
        self.clock.SetInput(f"Physical time  {time + self.recording.manifest.get('warmupSeconds', 0):.3f} s")
        duration = self.recording.times[-1] - self.recording.times[0]
        self.slow.SetInput(f"{seconds / duration:.0f}x slow motion")
        self.window.Render()
        self.capture.Modified()
        self.capture.Update()
        pixels = vtk_to_numpy(self.capture.GetOutput().GetPointData().GetScalars())
        return np.flipud(pixels.reshape(self.height, self.width, 3)).copy()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--seconds", type=float, default=24)
    parser.add_argument("--section", default="top")
    parser.add_argument("--title", default="Computed airflow")
    parser.add_argument("--still", type=float, help="Write one PNG at a fraction of the simulation clip")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    movie = Movie(args.run, args.width, args.height, args.title)
    recording = Recording(args.run / "animation", args.section)
    movie.view(recording)
    if args.still is not None:
        from PIL import Image

        time = np.interp(args.still, [0, 1], recording.times[[0, -1]])
        Image.fromarray(movie.frame(time, args.seconds)).save(args.output)
        return
    encoder = subprocess.Popen(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{args.width}x{args.height}",
            "-r",
            str(args.fps),
            "-i",
            "-",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "slow",
            "-crf",
            "17",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(args.output),
        ],
        stdin=subprocess.PIPE,
    )
    try:
        count = round(args.seconds * args.fps)
        for i in range(count):
            chapter = min(2, i * 3 // count)
            if i == 0 or chapter != (i - 1) * 3 // count:
                section = "side" if chapter == 2 else args.section
                recording = Recording(args.run / "animation", section)
                movie.view(recording, closeup=chapter == 1)
            fraction = (i - chapter * count / 3) / max(1, count / 3 - 1)
            time = np.interp(fraction, [0, 1], recording.times[[0, -1]])
            encoder.stdin.write(movie.frame(time, args.seconds / 3).tobytes())
            if i % args.fps == 0:
                print(f"Rendered {i}/{count} frames", flush=True)
    finally:
        encoder.stdin.close()
        result = encoder.wait()
        movie.window.Finalize()
    if result:
        raise RuntimeError("Video encoding failed.")
    print(args.output, flush=True)


if __name__ == "__main__":
    main()
