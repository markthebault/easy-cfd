// App shell: one full-screen wind tunnel with floating panels on top.

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { domainFor } from "./solver/setup";
import type { Vec3 } from "./solver/types";
import { useStore } from "./store/store";
import { app, init, toast } from "./store/app";
import { gridBounds } from "./store/geometry";
import { assessedAxles, assessedResult } from "./store/axleAnalysis";
import { DropOverlay, Toasts, TopBar, ViewBar } from "./ui/Chrome";
import { CompareView } from "./ui/CompareView";
import { EmptyState } from "./ui/EmptyState";
import { Help } from "./ui/Help";
import { LegendStack } from "./ui/Legend";
import { Library } from "./ui/Library";
import { LivePanel } from "./ui/LivePanel";
import { ResultsPanel } from "./ui/ResultsPanel";
import { SetupPanel } from "./ui/SetupPanel";
import { StageView, stages } from "./ui/StageView";
import { VizDock } from "./ui/VizDock";
import { DrivingDock } from "./ui/DrivingDock";

const NONE: never[] = [];

function useViewport() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

export function App() {
  const dark = useStore(app, (s) => s.dark);
  const view = useStore(app, (s) => s.view);
  const design = useStore(app, (s) => s.design);
  const parts = useStore(app, (s) => s.parts);
  const partsVersion = useStore(app, (s) => s.partsVersion);
  const report = useStore(app, (s) => s.report);
  const live = useStore(app, (s) => s.live);
  const run = useStore(app, (s) => s.run);
  const viz = useStore(app, (s) => s.viz);
  const showBox = useStore(app, (s) => s.showBox);
  const step = useStore(app, (s) => s.step);
  const busy = useStore(app, (s) => s.busy);
  const [particles, setParticles] = useState(true);
  const [sceneFocus, setSceneFocus] = useState(false);
  const vp = useViewport();
  useEffect(() => setSceneFocus(false), [view, design?.id]);

  useEffect(() => {
    void init().then(async () => {
      const url = new URL(window.location.href);
      if (url.searchParams.get('courseLab') !== 'teaching-car') return;
      try {
        const { launchCourseLab } = await import('./course/launcher');
        await launchCourseLab();
        url.searchParams.delete('courseLab');
        window.history.replaceState(null, '', url);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'error');
      }
    });
    // Test hook (dev server only): lets the e2e scripts reach the stages and the store.
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__easycfd = { stages, app };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  }, [dark]);

  useEffect(() => {
    if (stages.main) setParticles(stages.main.particlesAvailable);
  }, [view]);

  const box = useMemo(() => {
    if (view !== "setup" || !design || !report || !(showBox || (step === "conditions" && design.settings.simulation_box))) return null;
    const b = gridBounds(parts) ?? { low: report.low as Vec3, high: report.high as Vec3 };
    return domainFor(design.settings, b.low, b.high) as number[];
  }, [view, design?.settings, report, showBox, step, parts]);

  const detailOutlines = useMemo(() => {
    const list = design?.settings.detail_boxes ?? [];
    if (view !== "setup" || step === "car" || !list.length) return null;
    return list.map((b) => [b.x_min, b.x_max, b.y_min, b.y_max, b.z_min, b.z_max]);
  }, [view, step, design?.settings.detail_boxes]);

  const content =
    view === "live" && live
      ? { parts: live.parts, key: `live:${live.designName}:${live.parts.length}:${live.settings.speed_kmh}`, surface: null, field: live.field, ranges: live.ranges, helpers: false }
      : view === "results" && run
        ? { parts: run.parts, key: `run:${run.doc.id}`, surface: run.surface, field: run.field, ranges: run.ranges, helpers: false }
        : { parts: design ? parts : NONE, key: `setup:${partsVersion}`, surface: null, field: null, ranges: null, helpers: !!design };

  const driving = view === "live" ? live?.settings : view === "results" ? run?.doc.settings : design?.settings;
  const hasPanel = view === "live" || view === "results" || (view === "setup" && !!design);
  const showPanel = hasPanel && !sceneFocus;
  // Keep the car centred in the part of the screen the panels leave free.
  const narrow = vp.w <= 760;
  const insets = useMemo(
    () => (!showPanel ? { left: 0, bottom: narrow ? content.field ? 0 : 175 : 0, top: narrow ? content.field ? 156 : 64 : 0 } : narrow ? { left: 0, bottom: Math.round(vp.h * 0.5), top: content.field ? 156 : 64 } : { left: 408, bottom: 0, top: 0 }),
    [showPanel, narrow, vp.h, !!content.field],
  );
  const gizmo = useMemo(() => (narrow ? { right: 8, bottom: insets.bottom + 8, size: 76 } : { right: 16, bottom: 16, size: 104 }), [narrow, insets.bottom]);

  return (
    <div className={`app view-${view} ${sceneFocus ? "scene-focus" : ""}`}>
      {view !== "compare" && (
        <StageView
          id="main"
          axles={view === "results" && run ? assessedAxles(run.doc) : driving?.axles}
          parts={content.parts}
          partsKey={content.key}
          surface={content.surface}
          field={content.field}
          ranges={content.ranges}
          viz={viz}
          driving={driving}
          forces={view === "results" && run ? assessedResult(run.doc) : null}
          dark={dark}
          box={box}
          fitBox={!!box && showBox}
          detailBoxes={detailOutlines}
          helpers={content.helpers && !box && step === "car"}
          insets={insets}
          gizmo={gizmo}
        />
      )}
      <TopBar />
      {view === "compare" ? (
        <CompareView />
      ) : (
        <>
          {view === "setup" && !design && <EmptyState />}
          {showPanel && (
            <aside className="panel glass" data-testid="panel">
              {view === "setup" ? <SetupPanel /> : view === "live" ? <LivePanel /> : <ResultsPanel />}
            </aside>
          )}
          {hasPanel && <ViewBar />}
          {hasPanel && driving && !content.field && <DrivingDock conditions={driving} focused={sceneFocus} onFocus={() => setSceneFocus(v => !v)} />}
          {content.field && <VizDock friction={!!content.surface?.some(s=>s?.stressValid?.some(v=>v===1))} field={content.field} particles={particles} surface={!!content.surface?.some(Boolean)} forces={view === "results" && run ? assessedResult(run.doc) : null} driving={driving} focused={sceneFocus} onFocus={() => setSceneFocus(v => !v)} />}
          {content.field && (
            <LegendStack viz={viz} ranges={content.ranges} hasSurface={!!content.surface?.some(Boolean)} hasField={!!content.field} />
          )}
        </>
      )}
      {busy && (
        <div className="busy glass" role="status">
          <Loader2 size={16} className="spin" /> {busy}
        </div>
      )}
      <DropOverlay />
      <Library />
      <Help />
      <Toasts />
    </div>
  );
}
