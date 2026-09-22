import { useEffect, useRef, useState } from "react";
import "@kitware/vtk.js/Rendering/Profiles/Geometry";
import vtkGenericRenderWindow from "@kitware/vtk.js/Rendering/Misc/GenericRenderWindow";
import vtkActor from "@kitware/vtk.js/Rendering/Core/Actor";
import vtkMapper from "@kitware/vtk.js/Rendering/Core/Mapper";
import vtkXMLPolyDataReader from "@kitware/vtk.js/IO/XML/XMLPolyDataReader";
import vtkColorTransferFunction from "@kitware/vtk.js/Rendering/Core/ColorTransferFunction";
import vtkPlaneSource from "@kitware/vtk.js/Filters/Sources/PlaneSource";
import type { Geometry } from "./types";
import { Maximize2, Move3D } from "lucide-react";

type Props = {
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
};
export default function Viewer({
  geometry,
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
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const context = useRef<ReturnType<
    typeof vtkGenericRenderWindow.newInstance
  > | null>(null);
  const cameraReady = useRef(false);
  const cameraState = useRef<{
    position: number[];
    focalPoint: number[];
    viewUp: number[];
  } | null>(null);
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
    ctx.getRenderer().resetCameraClippingRange();
    ctx.getRenderWindow().render();
  };
  useEffect(() => {
    if (!container.current) return;
    const ctx = vtkGenericRenderWindow.newInstance({
      background: [0.91, 0.935, 0.94],
    });
    ctx.setContainer(container.current);
    ctx.resize();
    context.current = ctx;
    const observer = new ResizeObserver(() => ctx.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
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
    setLoading(true);
    setError("");
    const camera = renderer.getActiveCamera();
    const add = async (
      url: string,
      color: number[],
      colored: boolean,
      opacity = 1,
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
    const render = async () => {
      const tasks: Promise<void>[] = [];
      if (resultBase && mode === "surface")
        tasks.push(
          add(resultBase + "/assets/surface.vtp", [0.6, 0.65, 0.7], true),
        );
      else
        for (const part of geometry.parts)
          tasks.push(
            add(
              `${geometryBase}/${part.id}.vtp`,
              part.id === highlight || part.issues.length
                ? [0.92, 0.32, 0.12]
                : part.role === "wheel"
                  ? [0.15, 0.19, 0.23]
                  : [0.64, 0.71, 0.74],
              false,
              resultBase && mode === "slice" ? 0.4 : 1,
            ),
          );
      if (resultBase && mode === "streamlines")
        tasks.push(
          add(resultBase + "/assets/streamlines.vtp", [0.1, 0.6, 0.7], true),
        );
      if (resultBase && mode === "slice")
        tasks.push(
          add(
            `${resultBase}/slice?axis=${axis}&position=${position}`,
            [0.5, 0.6, 0.7],
            true,
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
      actor.getProperty().setColor(0.67, 0.72, 0.74);
      actor.getProperty().setOpacity(0.35);
      renderer.addActor(actor);
      await Promise.all(tasks);
      if (abort.signal.aborted) return;
      if (cameraState.current) {
        camera.setPosition(
          ...(cameraState.current.position as [number, number, number]),
        );
        camera.setFocalPoint(
          ...(cameraState.current.focalPoint as [number, number, number]),
        );
        camera.setViewUp(
          ...(cameraState.current.viewUp as [number, number, number]),
        );
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
      if (cameraReady.current) cameraState.current = {
        position: [...camera.getPosition()],
        focalPoint: [...camera.getFocalPoint()],
        viewUp: [...camera.getViewUp()],
      };
      renderer.removeAllViewProps();
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
  ]);
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
    <div className="viewer">
      <div ref={container} className="vtk-canvas" data-testid="vtk-viewer" />
      <div className="viewport-label">
        <span className="dot" />
        {label || "Geometry preview"}
      </div>
      <button className="view-reset" title="Reset camera" onClick={reset}>
        <Maximize2 size={16} />
      </button>
      <div className="viewport-hint">
        <Move3D size={14} /> Drag to rotate · Scroll to zoom · Shift + drag to
        pan
      </div>
      <div className="flow-direction">
        AIRFLOW <span>→</span> +X <small>Up +Z</small>
      </div>
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
