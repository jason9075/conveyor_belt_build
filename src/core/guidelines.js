// Ctrl "Snap to Guidelines": snap a free endpoint onto lines extended from nearby connectors.

import { add, sub, mul, dot, cross, norm, len } from './vec.js';

/**
 * @param {number[]} target cursor point [x, z]
 * @param {{origin:number[], dir:number[], label?:string}[]} lines candidate guidelines (dir unit)
 * @param {number} threshold max perpendicular distance (m)
 * @returns {{point:number[], dir:number[]|null, used:object[]}|null}
 */
export function snapToGuidelines(target, lines, threshold = 1.0) {
  const hits = [];
  for (const line of lines) {
    const n = norm(line.dir);
    const rel = sub(target, line.origin);
    const along = dot(rel, n);
    if (along <= 0.05) continue;
    const perp = Math.abs(cross(n, rel));
    if (perp > threshold) continue;
    hits.push({ line: { ...line, dir: n }, perp, along, point: add(line.origin, mul(n, along)) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.perp - b.perp);

  // Two non-parallel guidelines both within reach → snap to their intersection.
  const a = hits[0];
  for (let i = 1; i < hits.length; i++) {
    const b = hits[i];
    const den = cross(a.line.dir, b.line.dir);
    if (Math.abs(den) < 0.2) continue;
    const t = cross(sub(b.line.origin, a.line.origin), b.line.dir) / den;
    const p = add(a.line.origin, mul(a.line.dir, t));
    if (t > 0.05 && len(sub(p, target)) <= threshold * 1.5) {
      return { point: p, dir: null, used: [a.line, b.line] };
    }
  }
  return { point: a.point, dir: a.line.dir, used: [a.line] };
}

/** Round a point to a grid. */
export function snapToGrid(p, step) {
  if (!step) return p;
  return [Math.round(p[0] / step) * step, Math.round(p[1] / step) * step];
}
