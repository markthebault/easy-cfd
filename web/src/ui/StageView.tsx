// React binding for a Stage: creates it once, then forwards prop changes to its setters.

import { useEffect, useRef } from "react";
import type { Axles } from "../solver/types";
import type { Part } from "../geometry/model";
import type { SurfaceSample, VizField } from "../solver/extract";
import type { Ranges } from "../store/types";
import { dragHandle } from "../store/app";
import { Stage, type CameraState, type StagePart, type VizSettings, type ForceValues } from "../viz/stage";
import type { DrivingConditions } from "../viz/driving";

export const stages: Record<string, Stage | undefined> = {};

interface Props {
  id: string;
  axles?: Axles;
  parts: Part[];
  partsKey: string;
  surface?: (SurfaceSample | null)[] | null;
  field: VizField | null;
  animation?: import("../solver/animation").FlowAnimation;
  animationRanges?: Ranges;
  ranges: Ranges | null;
  viz: VizSettings;
  driving?: DrivingConditions | null;
  forces?: ForceValues | null;
  forceScale?: number;
  forceLength?: number;
  dark: boolean;
  box: number[] | null;
  fitBox?: boolean;
  /** Detail boxes to outline ([x0, x1, y0, y1, z0, z1] each). */
  detailBoxes?: number[][] | null;
  helpers: boolean;
  gizmo?: { right: number; bottom: number; size: number };
  insets?: { left: number; bottom: number; top?: number };
  onCamera?: (s: CameraState) => void;
  className?: string;
}

export function StageView(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const onCamera = useRef(props.onCamera);
  onCamera.current = props.onCamera;

  useEffect(() => {
    const s = new Stage(host.current!);
    stage.current = s;
    stages[props.id] = s;
    s.onHandleDrag = (name, pos) => dragHandle(name, pos);
    s.onCamera = (c) => onCamera.current?.(c);
    return () => {
      s.dispose();
      stage.current = null;
      delete stages[props.id];
    };
  }, [props.id]);

  useEffect(() => stage.current?.setTheme(props.dark), [props.dark]);
  useEffect(() => stage.current?.setInsets(props.insets?.left ?? 0, props.insets?.bottom ?? 0, props.insets?.top ?? 0), [props.insets?.left, props.insets?.bottom, props.insets?.top]);

  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    const parts: StagePart[] = props.parts.map((p, i) => ({
      id: p.id, role: p.role, enabled: p.enabled, positions: p.positions, wheel: p.wheel, wallStress: props.surface?.[i]?.wallStress, stressValid: props.surface?.[i]?.stressValid, stressQ: props.surface?.[i]?.snapshot?.dynamicPressure, cp: props.surface?.[i]?.cp ?? null, shear: props.surface?.[i]?.shear ?? null,
    }));
    const first = !s.renderer.domElement.dataset.hasParts && parts.length > 0;
    s.setParts(parts, props.partsKey, props.ranges?.cp);
    if (first) {
      s.renderer.domElement.dataset.hasParts = "1";
      s.setView("iso", false);
    }
  }, [props.parts, props.partsKey, props.surface, props.ranges]);

  useEffect(() => stage.current?.setField(props.field, props.ranges), [props.field, props.ranges]);
  useEffect(() => stage.current?.setAnimation(props.animation ?? null, props.animationRanges ?? null), [props.animation, props.animationRanges]);
  useEffect(() => stage.current?.setViz(props.viz), [props.viz]);
  useEffect(() => stage.current?.setAxles(props.axles), [props.axles,props.partsKey]);
  useEffect(() => stage.current?.setDriving(props.driving ?? null), [props.driving]);
  useEffect(() => stage.current?.setForces(props.forces ?? null, props.forceScale, props.forceLength), [props.forces, props.forceScale, props.forceLength, props.partsKey]);
  useEffect(() => stage.current?.setBox(props.box, props.fitBox), [props.box, props.fitBox]);
  useEffect(() => stage.current?.setDetailBoxes(props.detailBoxes ?? null), [props.detailBoxes]);
  useEffect(() => stage.current?.setHelpers(props.helpers), [props.helpers]);
  useEffect(() => {
    if (stage.current && props.gizmo) {
      stage.current.gizmoInset = props.gizmo;
      stage.current.requestRender();
    }
  }, [props.gizmo?.right, props.gizmo?.bottom, props.gizmo?.size]);

  return <div ref={host} className={props.className ?? "stage-host"} data-stage={props.id} />;
}
