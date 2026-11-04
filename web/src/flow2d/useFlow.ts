import { useEffect, useRef, useState } from "react";
import { FlowRenderer, viewport, type Camera, type Layer, type AnimationMode } from "./render";
import { SCENE_KEY, enabledShapes, referenceLengthFor, sceneGrid, simulationKey, type Scene } from "./scene";
import type { ForceReport } from "./metrics";
import type { FlowReply, FlowRequest } from "./flow.worker";

export function useFlow(scene: Scene, restart: number, playing: boolean, dragging: boolean, playback: number, layer: Layer, animation: AnimationMode, dark: boolean, camera: Camera) {
  const canvas = useRef<HTMLCanvasElement>(null), worker = useRef<Worker | null>(null);
  const renderer = useRef<FlowRenderer | null>(null), current = useRef(scene); current.current = scene;
  const view = useRef(camera); view.current = camera;
  const version = useRef(0), inflight = useRef(false), paused = useRef(!playing), speed = useRef(playback), backend = useRef(""); speed.current = playback;
  const tickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState({ steps: 0, backend: "", ready: false, error: false });
  const [message, setMessage] = useState("");
  const [metrics, setMetrics] = useState<ForceReport | null>(null);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  if (!renderer.current) renderer.current = new FlowRenderer(sceneGrid(scene));
  Object.assign(renderer.current, { shapes: scene.shapes, dark, playing: playing && !dragging, playback });
  const requestTick = () => {
    if (paused.current || inflight.current || !worker.current) return;
    inflight.current = true;
    worker.current.postMessage({ type: "tick", count: Math.round((backend.current === "webgpu" ? 128 : 16) * speed.current), version: version.current } satisfies FlowRequest);
  };
  useEffect(() => {
    // Treat an explicit example link as a one-time load; reload then restores edits.
    const url = new URL(location.href);
    if (url.searchParams.has("profile") || url.searchParams.has("tunnel")) { url.searchParams.delete("profile"); url.searchParams.delete("tunnel"); window.history.replaceState(null, "", url); }
    const w = new Worker(new URL("./flow.worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    let lastStatus = 0;
    w.onmessage = (e: MessageEvent<FlowReply>) => {
      const reply = e.data;
      if (reply.version !== version.current) return;
      inflight.current = false;
      if (reply.type === "error") {
        paused.current = true;  setMessage(reply.message);
        setStatus(s => ({ ...s, error: true, ready: false })); return;
      }
      backend.current = reply.backend;
      if (!paused.current || reply.steps <= 8 || !renderer.current!.field) renderer.current!.update(reply.values, reply.steps);
      if (performance.now() - lastStatus > 250 || reply.steps <= 8) {
        if (!paused.current || reply.steps <= 8) setMetrics(reply.metrics);
        setStatus({ steps: reply.steps, backend: reply.backend, ready: true, error: false }); lastStatus = performance.now();
      }
      tickTimer.current = setTimeout(requestTick, Math.max(0, 40 - reply.elapsed));
    };
    w.onerror = () => { inflight.current = false; paused.current = true;  setMessage("The browser flow engine could not start. Try reloading this page."); setStatus(s => ({ ...s, error: true, ready: false })); };
    return () => { clearTimeout(tickTimer.current); w.terminate(); worker.current = null; };
  }, []);

  useEffect(() => {
    version.current++; clearTimeout(tickTimer.current); inflight.current = true;
    const grid = sceneGrid(current.current);
    renderer.current!.clear(current.current.shapes, grid); setStatus({ steps: 0, backend: "", ready: false, error: false }); setMetrics(null);
    worker.current?.postMessage({ type: "start", outlines: enabledShapes(current.current).map(s => s.points), referenceLength: referenceLengthFor(current.current), signature: simulationKey(current.current), tunnel: grid.id, version: version.current, forceWasm: new URLSearchParams(location.search).has("flow-wasm") } satisfies FlowRequest);
    try { localStorage.setItem(SCENE_KEY, JSON.stringify(current.current)); } catch { /* Storage is optional */ }
  // Edits restart only after pointer release, represented by restart.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restart]);
  useEffect(() => { paused.current = !playing || dragging; if (!paused.current) requestTick(); }, [playing, dragging]);
  useEffect(() => { renderer.current!.setLayer(layer); }, [layer]);
  useEffect(() => { renderer.current!.setAnimation(animation); }, [animation]);
  useEffect(() => {
    const c = canvas.current!;
    const resize = () => {
      const rect = c.getBoundingClientRect(), ratio = Math.min(devicePixelRatio, 2);
      c.width = Math.round(rect.width * ratio); c.height = Math.round(rect.height * ratio);
      setSize({ width: rect.width, height: rect.height });
    };
    const observer = new ResizeObserver(resize); observer.observe(c); resize();
    const ctx = c.getContext("2d")!;
    let raf = 0, last = performance.now();
    const draw = (now: number) => {
      const ratio = Math.min(devicePixelRatio, 2), width = c.width / ratio, height = c.height / ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      renderer.current!.draw(ctx, viewport(width, height, view.current, renderer.current!.grid), Math.min(.04, (now - last) / 1000));
      last = now; raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); renderer.current?.dispose(); };
  }, []);

  return { canvas, size, status, metrics, message, setMessage };
}
