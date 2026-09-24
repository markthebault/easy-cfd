import { useEffect, useRef, useState } from "react";
import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkXMLPolyDataReader from "@kitware/vtk.js/IO/XML/XMLPolyDataReader";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkCubeSource from "@kitware/vtk.js/Filters/Sources/CubeSource";
import vtkPlaneSource from "@kitware/vtk.js/Filters/Sources/PlaneSource";
import vtkArrowSource from "@kitware/vtk.js/Filters/Sources/ArrowSource";
import vtkAnnotatedCubeActor from "@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor";
import vtkOrientationMarkerWidget from "@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget";
import vtkPolyData from "@kitware/vtk.js/Common/DataModel/PolyData";
import vtkTexture from "@kitware/vtk.js/Rendering/Core/Texture";
import type { Geometry } from "./types";
import {
  flowSeconds,
  load,
  NOTE,
  paint,
  Tracers,
  type PlaneSettings,
} from "./planeFlow";
import { Maximize2, Move3D } from "lucide-react";

type CameraState = {
  position: number[];
  focalPoint: number[];
  viewUp: number[];
  parallel: boolean;
  scale: number;
  size: number;
};
const size = (g: Geometry) => Math.max(...g.dimensions);
// Scene colours per theme; the page chrome uses CSS variables, but vtk.js needs RGB.
const PALETTE = {
  light: {
    background: [0.91, 0.935, 0.94],
    ground: [1, 1, 1],
    groundOpacity: 0.9,
    body: [0.64, 0.71, 0.74],
    wheel: [0.15, 0.19, 0.23],
    attention: [0.92, 0.32, 0.12],
    slice: [0.5, 0.6, 0.7],
    streamlines: [0.1, 0.6, 0.7],
    airflow: [0.02, 0.55, 0.49],
  },
  dark: {
    background: [0.07, 0.1, 0.12],
    ground: [1, 1, 1],
    groundOpacity: 0.9,
    body: [0.6, 0.66, 0.7],
    wheel: [0.25, 0.29, 0.33],
    attention: [0.96, 0.45, 0.22],
    slice: [0.5, 0.6, 0.7],
    streamlines: [0.3, 0.75, 0.8],
    airflow: [0.25, 0.95, 0.8],
  },
};
// Orthographic views looking along a world axis, with +X (airflow) to the right
// where the axis allows it: direction of view and camera up.
const VIEWS = {
  Front: { direction: [1, 0, 0], up: [0, 0, 1] },
  Side: { direction: [0, 1, 0], up: [0, 0, 1] },
  Top: { direction: [0, 0, -1], up: [0, 1, 0] },
} as const;

export type RepairOverlay = {
  edges: number[][][];
  patches: number[][][];
  selectedEdges: number[][][];
};

type Props = {
  boxBounds?: number[];
  modelTransforms?: Record<string, number[]>;
  repairOverlay?: RepairOverlay;
  geometry: Geometry | null;
  geometryBase: string;
  resultBase?: string;
  field: string;
  mode: string;
  axis: string;
  position: number;
  range?: number[];
  sync?: string;
  label?: string;
  highlight?: string;
  theme?: string;
  // Animation settings for the "plane" mode.
  flow?: PlaneSettings;
  windYaw?: number;
};
export default function Viewer({
  boxBounds,
  geometry,
  repairOverlay,
  modelTransforms,
  geometryBase,
  resultBase,
  field,
  mode,
  axis,
  position,
  range,
  sync,
  label,
  highlight,
  theme = "light",
  flow,
  windYaw,
}: Props) {
  const actors = useRef(
    new Map<string, ReturnType<typeof vtkActor.newInstance>>(),
  );
  const transforms = useRef(modelTransforms);
  transforms.current = modelTransforms;
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const flowSettings = useRef(flow);
  flowSettings.current = flow;
  const windYawValue = useRef(windYaw);
  windYawValue.current = windYaw;
  const wind = useRef<{
    source: ReturnType<typeof vtkArrowSource.newInstance>;
    actor: ReturnType<typeof vtkActor.newInstance>;
    widget: ReturnType<typeof vtkOrientationMarkerWidget.newInstance>;
  } | null>(null);
  const cut = mode === "slice" || mode === "plane";
  const colors = theme === "dark" ? PALETTE.dark : PALETTE.light;
  const container = useRef<HTMLDivElement>(null);
  const context = useRef<ReturnType<
    typeof vtkGenericRenderWindow.newInstance
  > | null>(null);
  const cameraReady = useRef(false);
  const cameraState = useRef<CameraState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const reset = () => {
    const ctx = context.current;
    if (!ctx || !geometry) return;
    const camera = ctx.getRenderer().getActiveCamera();
    const [lo, hi] = geometry.bounds;
    const l = hi[0] - lo[0];
    camera.setPosition(-l * 0.9, -l * 1.3, l * 0.8);
    camera.setFocalPoint((lo[0] + hi[0]) / 2, 0, (lo[2] + hi[2]) / 2);
    camera.setViewUp(0, 0, 1);
    camera.setParallelProjection(false);
    if (modelTransforms && actors.current.size) {
      const all = [...actors.current.values()].map((a) => a.getBounds());
      const b = [0, 1, 2, 3, 4, 5].map((i) =>
        i % 2
          ? Math.max(...all.map((v) => v[i]))
          : Math.min(...all.map((v) => v[i])),
      );
      ctx
        .getRenderer()
        .resetCamera(b as [number, number, number, number, number, number]);
    }
    ctx.getRenderer().resetCameraClippingRange();
    ctx.getRenderWindow().render();
    // A scene still loading would otherwise restore the camera saved before
    // this choice; without one it resets as well.
    cameraState.current = null;
  };
  const look = (name: keyof typeof VIEWS) => {
    const ctx = context.current;
    if (!ctx || !geometry) return;
    const { direction, up } = VIEWS[name];
    const [lo, hi] = geometry.bounds;
    const center = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2);
    const camera = ctx.getRenderer().getActiveCamera();
    camera.setParallelProjection(true);
    camera.setFocalPoint(center[0], center[1], center[2]);
    camera.setPosition(
      center[0] - direction[0],
      center[1] - direction[1],
      center[2] - direction[2],
    );
    camera.setViewUp(up[0], up[1], up[2]);
    // Fit the model and the road under it, not the whole ground grid.
    ctx.getRenderer().resetCamera((boxBounds ?? [lo[0], hi[0], lo[1], hi[1], 0, hi[2]]) as [number, number, number, number, number, number]);
    ctx.getRenderWindow().render();
    // Kept as the saved camera, so a scene still loading keeps this view.
    cameraState.current = {
      position: [...camera.getPosition()],
      focalPoint: [...camera.getFocalPoint()],
      viewUp: [...camera.getViewUp()],
      parallel: true,
      scale: camera.getParallelScale(),
      size: size(geometry),
    };
  };
  useEffect(() => {
    if (!container.current) return;
    const ctx = vtkGenericRenderWindow.newInstance({
      background: colors.background as [number, number, number],
    });
    ctx.setContainer(container.current);
    ctx.resize();
    context.current = ctx;
    const cube = vtkAnnotatedCubeActor.newInstance();
    cube.setDefaultStyle({
      fontStyle: "bold",
      fontFamily: "Arial",
      fontColor: "#2d4650",
      faceColor: "#f4f7f7",
      edgeThickness: 0.06,
      edgeColor: "#9fb0b5",
      resolution: 200,
      // Six-letter words must fit a face; the default scale is sized for "X".
      fontSizeScale: (res: number) => res / 3.6,
    });
    // Nose toward −X and +Z up, so the car's right side faces +Y.
    cube.setXMinusFaceProperty({ text: "FRONT", faceColor: "#d9efe9" });
    cube.setXPlusFaceProperty({ text: "REAR" });
    cube.setYPlusFaceProperty({ text: "RIGHT" });
    cube.setYMinusFaceProperty({ text: "LEFT" });
    cube.setZPlusFaceProperty({ text: "TOP" });
    cube.setZMinusFaceProperty({ text: "BOTTOM" });
    const marker = vtkOrientationMarkerWidget.newInstance({
      actor: cube,
      interactor: ctx.getInteractor(),
    });
    marker.setParentRenderer(ctx.getRenderer());
    marker.setViewportCorner(vtkOrientationMarkerWidget.Corners.TOP_RIGHT);
    marker.setViewportSize(0.14);
    marker.setMinPixelSize(64);
    marker.setMaxPixelSize(92);
    marker.setEnabled(true);
    const observer = new ResizeObserver(() => ctx.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      marker.setEnabled(false);
      marker.delete();
      cube.delete();
      ctx.delete();
      context.current = null;
    };
  }, []);
  useEffect(() => {
    const ctx = context.current;
    if (!ctx || !geometry) return;
    const abort = new AbortController();
    const owned: { delete: () => void }[] = [];
    const renderer = ctx.getRenderer();
    renderer.removeAllViewProps();
    actors.current.clear();
    renderer.setBackground(...(colors.background as [number, number, number]));
    setLoading(true);
    setError("");
    const camera = renderer.getActiveCamera();
    const add = async (
      url: string,
      color: number[],
      colored: boolean,
      opacity = 1,
      partId?: string,
    ) => {
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error("Could not load visualization data.");
      const bytes = await response.arrayBuffer();
      if (abort.signal.aborted) return;
      const reader = vtkXMLPolyDataReader.newInstance();
      reader.parseAsArrayBuffer(bytes);
      owned.push(reader);
      const data = reader.getOutputData();
      const mapper = vtkMapper.newInstance();
      owned.push(mapper);
      mapper.setInputData(data);
      const actor = vtkActor.newInstance();
      owned.push(actor);
      actor.setMapper(mapper);
      if (partId) {
        actors.current.set(partId, actor);
        actor.setUserMatrix(
          (transforms.current?.[partId] || identity) as Parameters<
            typeof actor.setUserMatrix
          >[0],
        );
      }
      actor.getProperty().setColor(color[0], color[1], color[2]);
      actor.getProperty().setOpacity(opacity);
      actor.getProperty().setSpecular(0.25);
      actor.getProperty().setSpecularPower(24);
      actor.getProperty().setLineWidth(2);
      if (colored && data.getPointData().getArrayByName(field)) {
        const lut = vtkColorTransferFunction.newInstance();
        owned.push(lut);
        const values = range || [0, 1];
        const min = values[0],
          max = values[1] === values[0] ? values[0] + 1 : values[1];
        lut.addRGBPoint(min, 0.12, 0.29, 0.64);
        lut.addRGBPoint(min + (max - min) * 0.33, 0.15, 0.73, 0.75);
        lut.addRGBPoint(min + (max - min) * 0.66, 0.98, 0.83, 0.34);
        lut.addRGBPoint(max, 0.88, 0.22, 0.12);
        mapper.setLookupTable(lut);
        mapper.setScalarRange(min, max);
        mapper.setColorByArrayName(field);
        mapper.setScalarModeToUsePointFieldData();
        mapper.setScalarVisibility(true);
      } else mapper.setScalarVisibility(false);
      renderer.addActor(actor);
    };
    // The animated plane: the resampled field and moving tracers drawn into a
    // canvas that textures a quad at the plane's position in the scene, like
    // the slice. Points without fluid data (the car) stay transparent.
    let stopAnimation = () => {};
    const animate = (data: Awaited<ReturnType<typeof load>>) => {
      const h = data.header;
      const at = (a: number, b: number) => {
        const p: [number, number, number] = [0, 0, 0];
        p["xyz".indexOf(h.axis)] = h.position;
        p["XYZ".indexOf(h.horizontal)] = a;
        p["XYZ".indexOf(h.vertical)] = b;
        return p;
      };
      const quad = vtkPlaneSource.newInstance();
      quad.setOrigin(...at(h.left, h.bottom));
      quad.setPoint1(...at(h.right, h.bottom));
      quad.setPoint2(...at(h.left, h.top));
      const quadMapper = vtkMapper.newInstance();
      quadMapper.setInputConnection(quad.getOutputPort());
      const quadActor = vtkActor.newInstance();
      quadActor.setMapper(quadMapper);
      quadActor.setForceTranslucent(true);
      const look = quadActor.getProperty();
      look.setAmbient(1);
      look.setDiffuse(0);
      look.setSpecular(0);
      // High-resolution trails stay crisp on Retina screens and close views.
      const scale = 4096 / Math.max(h.nx, h.ny);
      const surface = document.createElement("canvas"),
        trails = document.createElement("canvas");
      surface.width = trails.width = Math.round(h.nx * scale);
      surface.height = trails.height = Math.round(h.ny * scale);
      const own = h.fields.find((f) => f.name === field);
      const [low, high] = range ?? (own ? [own.min, own.max] : [0, 1]);
      const tile = paint(data, data.fields[field], low, high);
      const texture = vtkTexture.newInstance() as ReturnType<
        typeof vtkTexture.newInstance
      > & { delete: () => void; modified: () => void };
      texture.setInterpolate(true);
      texture.setCanvas(surface);
      quadActor.addTexture(texture);
      owned.push(quad, quadMapper, quadActor, texture);
      renderer.addActor(quadActor);
      const draw = surface.getContext("2d")!,
        pen = trails.getContext("2d")!;
      pen.lineCap = "round";
      pen.lineWidth = 1.8;
      pen.strokeStyle = "rgba(255,255,255,0.65)";
      const W = surface.width,
        H = surface.height;
      // Resample the static field once, rather than on every animation frame.
      const background = document.createElement("canvas");
      background.width = W;
      background.height = H;
      const backgroundDraw = background.getContext("2d")!;
      backgroundDraw.imageSmoothingEnabled = true;
      backgroundDraw.imageSmoothingQuality = "high";
      backgroundDraw.drawImage(tile, 0, 0, W, H);
      const tracers = new Tracers(data, flowSettings.current?.tracers ?? 3500);
      const compose = () => {
        draw.clearRect(0, 0, W, H);
        draw.imageSmoothingEnabled = true;
        draw.drawImage(background, 0, 0);
        draw.drawImage(trails, 0, 0);
        texture.modified();
        ctx.getRenderWindow().render();
      };
      compose();
      let last = performance.now(),
        frame = 0;
      const tick = (now: number) => {
        frame = requestAnimationFrame(tick);
        const elapsed = Math.min(now - last, 50);
        last = now;
        const settings = flowSettings.current;
        if (!settings?.playing) return;
        pen.globalCompositeOperation = "destination-out";
        pen.fillStyle = `rgba(0,0,0,${1 - Math.exp(-elapsed / 180)})`;
        pen.fillRect(0, 0, W, H);
        pen.globalCompositeOperation = "source-over";
        pen.beginPath();
        tracers.step(
          flowSeconds(h.width, h, settings, elapsed),
          (a, b, c, d) => {
            pen.moveTo((a / (h.nx - 1)) * W, H - (b / (h.ny - 1)) * H);
            pen.lineTo((c / (h.nx - 1)) * W, H - (d / (h.ny - 1)) * H);
          },
        );
        pen.stroke();
        compose();
      };
      frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    };
    const render = async () => {
      const tasks: Promise<void>[] = [];
      if (resultBase && (mode === "surface" || mode === "wake"))
        tasks.push(add(resultBase + "/assets/surface.vtp", colors.body, true));
      else
        for (const part of geometry.parts)
          tasks.push(
            add(
              `${geometryBase}/${part.id}.vtp`,
              part.id === highlight ||
                (!repairOverlay && part.issues.length && part.enabled !== false)
                ? colors.attention
                : part.role === "wheel"
                  ? colors.wheel
                  : colors.body,
              false,
              // Switched-off parts stay faintly visible so their position is clear.
              part.enabled === false
                ? part.id === highlight
                  ? 0.45
                  : 0.12
                : resultBase && cut
                  ? 0.4
                  : 1,
              part.id,
            ),
          );
      if (resultBase && mode === "streamlines")
        tasks.push(
          add(resultBase + "/assets/streamlines.vtp", colors.streamlines, true),
        );
      if (resultBase && mode === "wake")
        tasks.push(add(resultBase + "/wake", colors.streamlines, true));
      if (resultBase && mode === "slice")
        tasks.push(
          add(
            `${resultBase}/slice?axis=${axis}&position=${position}`,
            colors.slice,
            true,
          ),
        );
      if (resultBase && mode === "plane")
        tasks.push(
          load(`${resultBase}/plane?axis=${axis}&position=${position}`).then(
            (data) => {
              if (!abort.signal.aborted) stopAnimation = animate(data);
            },
          ),
        );
      const plane = vtkPlaneSource.newInstance();
      owned.push(plane);
      const [lo, hi] = geometry.bounds;
      const l = hi[0] - lo[0];
      plane.setOrigin(lo[0] - l * 0.4, lo[1] - l * 0.5, 0);
      plane.setPoint1(hi[0] + l * 0.7, lo[1] - l * 0.5, 0);
      plane.setPoint2(lo[0] - l * 0.4, hi[1] + l * 0.5, 0);
      plane.setXResolution(24);
      plane.setYResolution(20);
      const mapper = vtkMapper.newInstance();
      owned.push(mapper);
      mapper.setInputConnection(plane.getOutputPort());
      const actor = vtkActor.newInstance();
      owned.push(actor);
      actor.setMapper(mapper);
      actor.getProperty().setRepresentationToWireframe();
      actor
        .getProperty()
        .setColor(...(colors.ground as [number, number, number]));
      // Keep the grid pure white from every camera angle. Lighting would
      // otherwise shade lines as the view rotates.
      actor.getProperty().setLighting(false);
      actor.getProperty().setLineWidth(1.25);
      actor.getProperty().setOpacity(colors.groundOpacity);
      renderer.addActor(actor);
      if (windYawValue.current !== undefined) {
        const yaw = (windYawValue.current * Math.PI) / 180,
          direction: [number, number, number] = [
            Math.cos(yaw),
            Math.sin(yaw),
            0,
          ],
          arrowLength = 1;
        const source = vtkArrowSource.newInstance({
          direction,
          shaftRadius: 0.035,
          shaftResolution: 24,
          tipLength: 0.28,
          tipRadius: 0.11,
          tipResolution: 24,
        });
        const arrowMapper = vtkMapper.newInstance();
        arrowMapper.setInputConnection(source.getOutputPort());
        const arrowActor = vtkActor.newInstance();
        arrowActor.setMapper(arrowMapper);
        arrowActor.setScale(arrowLength, arrowLength, arrowLength);
        arrowActor.setPosition(
          -direction[0] * 0.5,
          -direction[1] * 0.5,
          0,
        );
        arrowActor
          .getProperty()
          .setColor(...(colors.airflow as [number, number, number]));
        arrowActor.getProperty().setLighting(false);
        const widget = vtkOrientationMarkerWidget.newInstance({
          actor: arrowActor,
          interactor: ctx.getInteractor(),
        });
        widget.setParentRenderer(renderer);
        widget.setViewportCorner(vtkOrientationMarkerWidget.Corners.BOTTOM_LEFT);
        widget.setViewportSize(0.16);
        widget.setMinPixelSize(80);
        widget.setMaxPixelSize(110);
        widget.setEnabled(true);
        widget.getRenderer().setBackground(...(colors.background as [number, number, number]));
        widget.getRenderer().setPreserveColorBuffer(false);
        owned.push({ delete: () => { widget.setEnabled(false); widget.delete(); } });
        owned.push(source, arrowMapper, arrowActor);
        wind.current = { source, actor: arrowActor, widget };
      }
      await Promise.all(tasks);
      if (repairOverlay && !abort.signal.aborted) {
        const overlay = (
          cells: number[][][],
          triangles: boolean,
          color: number[],
        ) => {
          if (!cells.length) return;
          const poly = vtkPolyData.newInstance();
          poly.getPoints().setData(new Float32Array(cells.flat(2)), 3);
          const indices = cells.flatMap((cell, i) => [
            cell.length,
            ...cell.map((_, j) => i * cell.length + j),
          ]);
          if (triangles) poly.getPolys().setData(new Uint32Array(indices));
          else poly.getLines().setData(new Uint32Array(indices));
          const mapper = vtkMapper.newInstance();
          mapper.setInputData(poly);
          mapper.setScalarVisibility(false);
          const actor = vtkActor.newInstance();
          actor.setMapper(mapper);
          actor.getProperty().setColor(color[0], color[1], color[2]);
          actor.getProperty().setLighting(false);
          actor.getProperty().setLineWidth(triangles ? 1 : 5);
          renderer.addActor(actor);
          owned.push(poly, mapper, actor);
        };
        overlay(repairOverlay.edges, false, [1, 0.27, 0.12]);
        overlay(repairOverlay.patches, true, [0.12, 0.78, 0.64]);
        overlay(repairOverlay.selectedEdges, false, [1, 0.75, 0.08]);
      }
      if (abort.signal.aborted) return;
      // Keep the view across part toggles, but not across a units change that
      // would leave the model far outside it.
      const ratio = cameraState.current
        ? size(geometry) / cameraState.current.size
        : 0;
      if (cameraState.current && ratio > 0.5 && ratio < 2) {
        camera.setPosition(
          ...(cameraState.current.position as [number, number, number]),
        );
        camera.setFocalPoint(
          ...(cameraState.current.focalPoint as [number, number, number]),
        );
        camera.setViewUp(
          ...(cameraState.current.viewUp as [number, number, number]),
        );
        camera.setParallelProjection(cameraState.current.parallel);
        camera.setParallelScale(cameraState.current.scale);
        renderer.resetCameraClippingRange();
        ctx.getRenderWindow().render();
      } else reset();
      cameraReady.current = true;
      setLoading(false);
    };
    render().catch((e) => {
      if (e.name !== "AbortError") {
        setError(e.message);
        setLoading(false);
      }
    });
    return () => {
      abort.abort();
      stopAnimation();
      if (cameraReady.current)
        cameraState.current = {
          position: [...camera.getPosition()],
          focalPoint: [...camera.getFocalPoint()],
          viewUp: [...camera.getViewUp()],
          parallel: camera.getParallelProjection(),
          scale: camera.getParallelScale(),
          size: size(geometry),
        };
      renderer.removeAllViewProps();
      actors.current.clear();
      wind.current = null;
      owned.forEach((o) => o.delete());
    };
  }, [
    geometry,
    geometryBase,
    resultBase,
    field,
    mode,
    axis,
    position,
    range?.[0],
    range?.[1],
    highlight,
    theme,
    flow?.tracers,
    repairOverlay,
  ]);
  const boxKey = boxBounds?.join(",");
  const boxShown = useRef(false);
  useEffect(() => {
    const ctx = context.current;
    if (!boxBounds) {boxShown.current = false; return;}
    if (!ctx || loading) return;
    const [xmin, xmax, ymin, ymax, zmin, zmax] = boxBounds;
    const source = vtkCubeSource.newInstance({
      xLength: xmax-xmin, yLength: ymax-ymin, zLength: zmax-zmin,
      center: [(xmin+xmax)/2, (ymin+ymax)/2, (zmin+zmax)/2],
    });
    const mapper = vtkMapper.newInstance();
    mapper.setInputConnection(source.getOutputPort());
    const actor = vtkActor.newInstance();
    actor.setMapper(mapper);
    actor.getProperty().setRepresentationToWireframe();
    actor.getProperty().setLighting(false);
    actor.getProperty().setColor(0.9, 0.4, 0.08);
    actor.getProperty().setLineWidth(2);
    ctx.getRenderer().addActor(actor);
    if (!boxShown.current) {
      ctx.getRenderer().resetCamera(boxBounds as [number, number, number, number, number, number]);
      boxShown.current = true;
    }
    ctx.getRenderer().resetCameraClippingRange();
    ctx.getRenderWindow().render();
    return () => {
      ctx.getRenderer()?.removeActor(actor);
      actor.delete(); mapper.delete(); source.delete();
    };
  }, [boxKey, loading, geometry, theme, mode]);
  const fitBox = () => {
    if (!boxBounds || !context.current) return;
    context.current.getRenderer().resetCamera(boxBounds as [number, number, number, number, number, number]);
    context.current.getRenderWindow().render();
  };
  useEffect(() => {
    const ctx = context.current,
      marker = wind.current;
    if (!ctx || !marker || !geometry || windYaw === undefined) return;
    const yaw = (windYaw * Math.PI) / 180,
      direction: [number, number, number] = [
        Math.cos(yaw),
        Math.sin(yaw),
        0,
      ];
    marker.source.setDirection(direction);
    marker.actor.setPosition(
      -direction[0] * 0.5,
      -direction[1] * 0.5,
      0,
    );
    marker.widget.updateMarkerOrientation();
    ctx.getRenderer().resetCameraClippingRange();
    ctx.getRenderWindow().render();
  }, [windYaw, geometry]);
  useEffect(() => {
    const ctx = context.current;
    if (!ctx) return;
    actors.current.forEach((actor, id) => {
      actor.setUserMatrix(
        (modelTransforms?.[id] || identity) as Parameters<
          typeof actor.setUserMatrix
        >[0],
      );
    });
    ctx.getRenderer().resetCameraClippingRange();
    ctx.getRenderWindow().render();
  }, [modelTransforms, loading]);
  useEffect(() => {
    const ctx = context.current;
    if (!ctx || !sync) return;
    let applying = false;
    const camera = ctx.getRenderer().getActiveCamera();
    const eventName = "easycfd-camera-" + sync;
    const subscription = camera.onModified(() => {
      if (!applying)
        window.dispatchEvent(
          new CustomEvent(eventName, {
            detail: {
              source: container.current,
              position: camera.getPosition(),
              focal: camera.getFocalPoint(),
              up: camera.getViewUp(),
              parallel: camera.getParallelProjection(),
              scale: camera.getParallelScale(),
            },
          }),
        );
    });
    const listener = (event: Event) => {
      const d = (event as CustomEvent).detail;
      if (d.source === container.current) return;
      applying = true;
      camera.setPosition(...(d.position as [number, number, number]));
      camera.setFocalPoint(...(d.focal as [number, number, number]));
      camera.setViewUp(...(d.up as [number, number, number]));
      camera.setParallelProjection(d.parallel);
      camera.setParallelScale(d.scale);
      ctx.getRenderer().resetCameraClippingRange();
      ctx.getRenderWindow().render();
      applying = false;
    };
    window.addEventListener(eventName, listener);
    return () => {
      subscription.unsubscribe();
      window.removeEventListener(eventName, listener);
    };
  }, [sync]);
  return (
    <div className={`viewer${windYaw !== undefined ? " has-wind-indicator" : ""}`}>
      <div ref={container} className="vtk-canvas" data-testid="vtk-viewer" />
      <div className="viewport-label">
        <span className="dot" />
        {label || "Geometry preview"}
      </div>
      <div className="view-buttons" role="group" aria-label="Camera view">
        {(Object.keys(VIEWS) as (keyof typeof VIEWS)[]).map((name) => (
          <button
            key={name}
            title={`${name} view, without perspective`}
            onClick={() => look(name)}
            disabled={!geometry}
          >
            {name}
          </button>
        ))}
        {boxBounds && <button onClick={fitBox}>Fit box</button>}
        <button title="Reset camera" onClick={reset} disabled={!geometry}>
          <Maximize2 size={14} /> 3D
        </button>
      </div>
      <div
        className={`viewport-hint ${resultBase && mode === "plane" ? "plane-note" : ""}`}
      >
        <Move3D size={14} />{" "}
        {resultBase && mode === "plane"
          ? NOTE
          : mode === "wake"
            ? "3D paths through the saved mean flow · Coloured by the selected field"
            : "Drag to rotate · Scroll to zoom · Shift + drag to pan"}
      </div>
      <div
        className="flow-direction"
        data-testid="wind-direction"
        aria-label={
          windYaw === undefined
            ? "Airflow travels toward positive X"
            : `Wind travels toward positive X at ${windYaw} degrees yaw`
        }
      >
        {windYaw === undefined ? "AIRFLOW" : "WIND"} <span>→</span> +X
        <small>
          {windYaw === undefined
            ? "Up +Z"
            : `${windYaw > 0 ? "+" : ""}${windYaw}° yaw`}
        </small>
      </div>
      {boxBounds && <div className="box-caption" data-testid="simulation-box" data-bounds={boxKey}>Simulation box · floor Z = 0</div>}
      {loading && <div className="viewport-message">Loading geometry…</div>}
      {error && <div className="viewport-message error">{error}</div>}
      {!geometry && (
        <div className="viewport-message">
          Import a model or open the sample car.
        </div>
      )}
      {resultBase && range && (
        <div className="legend">
          <b>
            {field}{" "}
            <small>
              {field === "Pressure"
                ? "Pa relative to ambient"
                : field === "Speed"
                  ? "m/s"
                  : "m²/s² · modeled k"}
            </small>
          </b>
          <div className="color-ramp" />
          <div>
            <span>{range[0].toPrecision(3)}</span>
            <span>{range[1].toPrecision(3)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
