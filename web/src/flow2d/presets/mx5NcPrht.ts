import { mapNode, sampleCurve, type CurveNode } from "../curves";

// Exact car-body anchors and handles from mx5-nc-prht.svg. Its white background
// is excluded. This trace has no physical scale; 4 m is an editable starting
// length, with the original proportions retained and 150 mm ground clearance.
const outline: CurveNode[] = [
  { x: 24.8, y: 275.5, incoming: { x: 25, y: 293.2 }, outgoing: { x: 24.9, y: 269.3 } },
  { x: 34.4, y: 256.6, incoming: { x: 28.7, y: 262.5 }, outgoing: { x: 43, y: 248 } },
  { x: 69.7, y: 237.3, incoming: { x: 54.5, y: 241.9 }, outgoing: { x: 89.9, y: 231 } },
  { x: 133.8, y: 224.7, incoming: { x: 110.4, y: 227 }, outgoing: { x: 158.9, y: 222.5 } },
  { x: 226.6, y: 220, incoming: { x: 193.8, y: 221.1 } },
  { x: 232.5, y: 218.5, outgoing: { x: 252.4, y: 207.4 } },
  { x: 303.7, y: 175.5, incoming: { x: 278.2, y: 191.4 } },
  { x: 311.7, y: 170.6, outgoing: { x: 328.6, y: 167.4 } },
  { x: 367.5, y: 165.8, incoming: { x: 348.3, y: 165.6 }, outgoing: { x: 386, y: 165.6 } },
  { x: 415, y: 170.4, incoming: { x: 401.5, y: 166.6 }, outgoing: { x: 432.1, y: 175.1 } },
  { x: 460.1, y: 195.2, incoming: { x: 447.2, y: 185.5 } },
  { x: 477.7, y: 208.1, outgoing: { x: 500.6, y: 210.2 } },
  { x: 548.5, y: 214.6, incoming: { x: 523, y: 212.4 } },
  { x: 593.8, y: 218 },
  { x: 601, y: 217.8 },
  { x: 602.1, y: 221.8 },
  { x: 601.3, y: 225.1, outgoing: { x: 605.9, y: 232.8 } },
  { x: 609, y: 252.6, incoming: { x: 608.2, y: 243 }, outgoing: { x: 609.4, y: 256.7 } },
  { x: 617.5, y: 262.3, incoming: { x: 612.3, y: 259.4 } },
  { x: 622, y: 267.1 },
  { x: 623.4, y: 278.9, outgoing: { x: 624, y: 288.9 } },
  { x: 617, y: 305.1, incoming: { x: 621.6, y: 298.1 } },
  { x: 609.5, y: 315 },
  { x: 606.5, y: 319.6 },
  { x: 607, y: 322.1 },
  { x: 604.9, y: 324.1 },
  { x: 555.7, y: 325.7 },
  { x: 442.8, y: 330, outgoing: { x: 359.4, y: 331 } },
  { x: 186.5, y: 331, incoming: { x: 269, y: 331.3 } },
  { x: 67.4, y: 333 },
  { x: 59.6, y: 332.1 },
  { x: 38.6, y: 326.3, outgoing: { x: 34.4, y: 324.9 } },
  { x: 29.8, y: 318.2, incoming: { x: 31.4, y: 322.4 }, outgoing: { x: 26.3, y: 306.7 } },
];
const sourcePoints = sampleCurve(outline, true, .25);
const left = Math.min(...sourcePoints.map(p => p.x)), right = Math.max(...sourcePoints.map(p => p.x)), bottom = Math.max(...sourcePoints.map(p => p.y));
const scale = 4 / (right - left);
const curve = outline.map(node => mapNode(node, p => ({ x: 3 + (p.x - left) * scale, y: .15 + (bottom - p.y) * scale })));
export const MX5_NC_PRHT = { name: "MX-5 NC PRHT", vehicle: true, curve, points: sampleCurve(curve) };
