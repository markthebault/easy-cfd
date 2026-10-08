// Keep dense recordings below browser database limits by persisting one frame per value.
// The small metadata record is committed last, so an interrupted save preserves the old clip.
import type { FlowAnimation } from "../solver/animation";
import type { FieldDoc } from "./types";
import { decodeAnimation, decodeField, encodeAnimation, encodeField } from "./codec";
import { get, newId, put, removeAnimationFrames } from "./db";

type RecordingCache = Pick<FieldDoc, "animation" | "animationFrameKeys">;

export async function cacheAnimation(runId:string, animation?:FlowAnimation):Promise<RecordingCache> {
  if (!animation) return {};
  if (animation.version !== 2) return {animation:encodeAnimation(animation)};
  const generation = newId("clip");
  const keys:string[] = [];
  for (let i=0;i<animation.frames.length;i++) {
    const frame = animation.frames[i], id = `${runId}:${generation}:${i}`;
    await put("animationFrames", {id,runId,time:frame.time,field:encodeField(frame.field)});
    keys.push(id);
  }
  return {animation:{...animation,frames:[]},animationFrameKeys:keys};
}

export async function restoreAnimation(doc:FieldDoc):Promise<FlowAnimation|undefined> {
  if (!doc.animation) return undefined;
  if (!doc.animationFrameKeys) return decodeAnimation(doc.animation);
  if (doc.animationFrameKeys.length < 2 || doc.animationFrameKeys.length > 195) throw new Error("Invalid saved recording.");
  const frames:FlowAnimation["frames"] = [];
  for (const id of doc.animationFrameKeys) {
    const saved = await get("animationFrames",id);
    if (!saved || saved.runId !== doc.id) throw new Error("A saved airflow frame is missing.");
    frames.push({time:saved.time,field:decodeField(saved.field)});
  }
  return {...doc.animation,frames};
}

export async function replaceCachedAnimation(doc:FieldDoc, animation:FlowAnimation) {
  const cached = await cacheAnimation(doc.id,animation);
  await put("fields", {...doc,animation:cached.animation,animationFrameKeys:cached.animationFrameKeys});
  await removeAnimationFrames(doc.id,cached.animationFrameKeys);
}
