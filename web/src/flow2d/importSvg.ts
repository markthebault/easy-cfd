import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { DOMAIN, signedArea, validProfile, type Profile } from "./geometry";

/** Geometry only: never mount imported markup or fetch external SVG resources. */
export function importSvg(text: string, name: string, widthMm: number, domain = DOMAIN): Profile {
  if (text.length > 1_000_000) throw new Error("Choose an SVG smaller than 1 MB.");
  const maximum = Math.floor((domain.width - .2) * 1000);
  if (!Number.isFinite(widthMm) || widthMm < 30 || widthMm > maximum) throw new Error(`Set a width between 30 and ${maximum.toLocaleString()} mm for this box.`);
  const xml = new DOMParser().parseFromString(text, "image/svg+xml");
  if (xml.querySelector("parsererror") || xml.documentElement.localName !== "svg") throw new Error("This file is not a valid SVG.");
  if (xml.querySelector("script, foreignObject, image, use, text, clipPath, mask") || /(?:href\s*=|url\s*\(|<!DOCTYPE|<!ENTITY)/i.test(text)) throw new Error("Export a plain outline SVG without text, images, clipping or linked elements.");
  const paths = new SVGLoader().parse(text).paths.flatMap(path => path.subPaths);
  const contours = paths.map(path => {
    const p = path.getPoints(12);
    const start = p[0], end = p.at(-1);
    if (!start || !end || (!path.autoClose && start.distanceTo(end) > .001)) throw new Error("Close the outline in your drawing app before importing it.");
    if (start.distanceTo(end) < .001) p.pop();
    return p.map(q => ({ x: q.x, y: -q.y }));
  }).filter(points => Math.abs(signedArea(points)) > .00001);
  if (contours.length !== 1) throw new Error("For this prototype, export one closed outline without holes.");
  const points = contours[0];
  if (points.length > 512) throw new Error("Simplify the SVG to fewer than 512 outline points.");
  const minX = Math.min(...points.map(p => p.x)), maxX = Math.max(...points.map(p => p.x));
  const minY = Math.min(...points.map(p => p.y)), maxY = Math.max(...points.map(p => p.y));
  const scale = widthMm / 1000 / (maxX - minX);
  if ((maxY - minY) * scale > domain.height - .2) throw new Error("This outline is too tall for this simulation box. Choose a larger box or reduce its width.");
  const originX = Math.min(.65, (domain.width - widthMm / 1000) / 2);
  const transformed = points.map(p => ({ x: originX + (p.x - minX) * scale, y: .12 + (p.y - minY) * scale }));
  if (!validProfile(transformed)) throw new Error("The outline crosses itself or has no usable thickness.");
  return { name: name.replace(/\.svg$/i, ""), points: transformed };
}
