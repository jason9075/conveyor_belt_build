// Belt routing: given two endpoints (position + heading), produce Hermite segments.
//
// Endpoint spec:
//   { pos:[x,z], h, dir:[x,z]|null, clearance }
//   start.dir = heading when leaving the start; end.dir = heading when arriving at the end.
//   dir === null means "free" (auto-resolved by the router).

import { add, sub, mul, dot, cross, len, dist, norm, neg, left, rot, DEG } from './vec.js';
import { Path, reverseSegments } from './path.js';

export const MAX_ANGLE = 185 * DEG; // maximum routing turn angle
export const MODES = ['default', 'straight', 'curve'];
export const MODE_LABEL = { default: '預設', straight: '直線／正交', curve: '曲線' };

/** Hermite tangent length for a circular arc. */
export function arcTangentMagnitude(angle, radius) {
  const a = Math.min(Math.max(angle, 0), Math.PI * 1.1);
  return radius * 4 * Math.tan(a / 4);
}

export function straightSeg(a, b) {
  const t = sub(b, a);
  return { p0: a, t0: t, p1: b, t1: t };
}

/**
 * Circular arc as Hermite segments, split so that no piece exceeds 90°.
 * @param center circle centre
 * @param r radius
 * @param from start point on the circle
 * @param fromDir heading at `from`
 * @param angle swept angle (radians, ≥ 0)
 * @param ccw true = turn toward `left(heading)`
 */
export function arcSegments(center, r, from, fromDir, angle, ccw) {
  if (angle < 1e-6) return [];
  const n = Math.max(1, Math.ceil(angle / (Math.PI / 2) - 1e-9));
  const step = angle / n;
  const sgn = ccw ? 1 : -1;
  const m = arcTangentMagnitude(step, r);
  const segs = [];
  let p = from;
  let d = fromDir;
  const rel0 = sub(from, center);
  for (let i = 1; i <= n; i++) {
    const q = add(center, rot(rel0, sgn * step * i));
    const dq = rot(fromDir, sgn * step * i);
    segs.push({ p0: p, t0: mul(d, m), p1: q, t1: mul(dq, m) });
    p = q;
    d = dq;
  }
  return segs;
}

function turnAngle(center, from, to, ccw) {
  const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
  const a1 = Math.atan2(to[1] - center[1], to[0] - center[0]);
  const twoPi = Math.PI * 2;
  let d = (((a1 - a0) % twoPi) + twoPi) % twoPi;
  if (!ccw) d = (twoPi - d) % twoPi;
  if (d > twoPi - 1e-7) d = 0;
  return d;
}

/**
 * Bend–Straight–Bend (Dubins CSC). Tries LSL / RSR / LSR / RSL and returns the shortest valid one.
 * @returns {{segments, kind, a1, a2, straight, total}|null}
 */
export function bendStraightBend(P0, N0, P1, N1, r) {
  N0 = norm(N0);
  N1 = norm(N1);
  let best = null;
  for (const sCcw of [true, false]) {
    for (const eCcw of [true, false]) {
      const c1 = add(P0, mul(left(N0), sCcw ? r : -r));
      const c2 = add(P1, mul(left(N1), eCcw ? r : -r));
      const D = sub(c2, c1);
      const d = len(D);
      let F;
      if (sCcw === eCcw) {
        if (d < 1e-9) continue;
        F = mul(D, 1 / d); // outer tangent: parallel to the centre line
      } else {
        if (d < 2 * r - 1e-9) continue;
        const beta = Math.asin(Math.min(1, (2 * r) / d));
        // LSR: D = s·F − 2r·left(F) → F is β to the left of D̂; RSL mirrored.
        F = rot(mul(D, 1 / d), sCcw ? beta : -beta);
      }
      const exit1 = add(c1, mul(left(F), sCcw ? -r : r));
      const enter2 = add(c2, mul(left(F), eCcw ? -r : r));
      const sv = sub(enter2, exit1);
      if (dot(sv, F) < -1e-6) continue;
      const straight = len(sv);
      const a1 = turnAngle(c1, P0, exit1, sCcw);
      const a2 = turnAngle(c2, enter2, P1, eCcw);
      if (a1 > MAX_ANGLE || a2 > MAX_ANGLE) continue;
      const total = r * a1 + straight + r * a2;
      if (!best || total < best.total - 1e-9) {
        const segments = [
          ...arcSegments(c1, r, P0, N0, a1, sCcw),
          ...(straight > 1e-6 ? [straightSeg(exit1, enter2)] : []),
          ...arcSegments(c2, r, enter2, F, a2, eCcw),
        ];
        best = {
          segments,
          kind: (sCcw ? 'L' : 'R') + 'S' + (eCcw ? 'L' : 'R'),
          a1,
          a2,
          straight,
          total,
        };
      }
    }
  }
  return best;
}

/**
 * Heading at P1 for a "bend then straight" path from (P0, N0) to the point P1.
 * This is how a free end resolves its direction in default mode.
 */
export function oneBendHeading(P0, N0, P1, r) {
  const rel = sub(P1, P0);
  const side = cross(N0, rel);
  if (Math.abs(side) < 1e-6) return dot(rel, N0) > 0 ? N0 : null;
  const sgn = side > 0 ? 1 : -1;
  const C = add(P0, mul(left(N0), r * sgn));
  const v = sub(P1, C);
  const dc = len(v);
  if (dc < r + 1e-6) return null;
  const alpha = Math.asin(r / dc);
  return rot(mul(v, 1 / dc), sgn * alpha);
}

export function isStraight(P0, N0, P1, N1, threshold = 0.9995) {
  const d = norm(sub(P1, P0));
  return dot(N0, d) > threshold && dot(N1, d) > threshold;
}

/** Fillet every interior corner of a polyline with radius r. Returns segments or an error string. */
export function filletPolyline(points, r) {
  const n = points.length;
  if (n < 2) return 'too few points';
  const segs = [];
  let cur = points[0];
  let prevTrim = 0;
  for (let i = 1; i < n - 1; i++) {
    const dIn = norm(sub(points[i], points[i - 1]));
    const dOut = norm(sub(points[i + 1], points[i]));
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(dIn, dOut))));
    if (theta < 1e-5) continue;
    if (theta > Math.PI - 1e-3) return '折返角度過大';
    const t = r * Math.tan(theta / 2);
    const lenIn = dist(points[i], points[i - 1]);
    if (prevTrim + t > lenIn + 1e-6) return '距離不足以轉彎';
    prevTrim = t;
    const a = sub(points[i], mul(dIn, t));
    const ccw = cross(dIn, dOut) > 0;
    if (dist(cur, a) > 1e-6) segs.push(straightSeg(cur, a));
    const center = add(a, mul(left(dIn), ccw ? r : -r));
    segs.push(...arcSegments(center, r, a, dIn, theta, ccw));
    cur = add(points[i], mul(dOut, t));
  }
  const last = points[n - 1];
  if (prevTrim > dist(points[n - 1], points[n - 2]) + 1e-6) return '距離不足以轉彎';
  if (dist(cur, last) > 1e-6) segs.push(straightSeg(cur, last));
  return segs;
}

// ------------------------------------------------------------------ mode routers
// Each takes (a, sDir, b, eDir, r) on the horizontal plane (leads already stripped)
// and returns { segments, startDir, endDir, kind } or { error }.

function reverseProblem(fn, a, sDir, b, eDir, r) {
  const res = fn(b, eDir ? neg(eDir) : null, a, sDir ? neg(sDir) : null, r);
  if (res.error) return res;
  return {
    segments: reverseSegments(res.segments),
    startDir: neg(res.endDir),
    endDir: neg(res.startDir),
    kind: res.kind,
  };
}

function straightOnly(a, b) {
  const d = norm(sub(b, a));
  return { segments: [straightSeg(a, b)], startDir: d, endDir: d, kind: 'S' };
}

function routeDefault(a, sDir, b, eDir, r) {
  if (!sDir && !eDir) return straightOnly(a, b);
  if (!sDir) return reverseProblem(routeDefault, a, sDir, b, eDir, r);
  if (!eDir) eDir = oneBendHeading(a, sDir, b, r) ?? norm(sub(b, a));
  if (isStraight(a, sDir, b, eDir)) {
    return { segments: [straightSeg(a, b)], startDir: sDir, endDir: eDir, kind: 'S' };
  }
  const bsb = bendStraightBend(a, sDir, b, eDir, r);
  if (!bsb) return { error: '兩端太近，無法在最小彎曲半徑內連接' };
  return { segments: bsb.segments, startDir: sDir, endDir: eDir, kind: bsb.kind };
}

function routeStraight(a, sDir, b, eDir, r) {
  if (!sDir && !eDir) return straightOnly(a, b);
  if (!sDir) return reverseProblem(routeStraight, a, sDir, b, eDir, r);
  const u = norm(sDir);
  const v = left(u);
  const rel = sub(b, a);
  const A = dot(rel, u);
  const B = dot(rel, v);
  const EPS = 0.02;
  const fillet = (pts, endDir, kind) => {
    const segs = filletPolyline(pts, r);
    if (typeof segs === 'string') return { error: `正交模式：${segs}` };
    return { segments: segs, startDir: u, endDir, kind };
  };
  if (!eDir) {
    if (Math.abs(B) < EPS) {
      if (A <= EPS) return { error: '正交模式：終點在起點後方' };
      return { segments: [straightSeg(a, b)], startDir: u, endDir: u, kind: 'S' };
    }
    if (A < r) return { error: '正交模式：轉角前的距離不足' };
    return fillet([a, add(a, mul(u, A)), b], mul(v, Math.sign(B)), 'L');
  }
  const eu = dot(eDir, u);
  const ev = dot(eDir, v);
  if (eu > 0.999) {
    if (Math.abs(B) < EPS && A > EPS) {
      return { segments: [straightSeg(a, b)], startDir: u, endDir: eDir, kind: 'S' };
    }
    const m = A / 2;
    const w1 = add(a, mul(u, m));
    return fillet([a, w1, add(w1, mul(v, B)), b], eDir, 'Z');
  }
  if (eu < -0.999) {
    const d = Math.max(A, 0) + r;
    const w1 = add(a, mul(u, d));
    return fillet([a, w1, add(w1, mul(v, B)), b], eDir, 'U');
  }
  if (Math.abs(ev) > 0.999) {
    if (ev * B <= 0) return { error: '正交模式：終點方向與側向相反，請改用預設模式' };
    return fillet([a, add(a, mul(u, A)), b], eDir, 'L');
  }
  return { error: '正交模式：兩端方向不是互相垂直或平行' };
}

function routeCurve(a, sDir, b, eDir, r) {
  if (!sDir && !eDir) return straightOnly(a, b);
  if (!sDir) return reverseProblem(routeCurve, a, sDir, b, eDir, r);
  const u = norm(sDir);
  const rel = sub(b, a);
  if (!eDir) {
    const c = cross(u, rel);
    const d2 = dot(rel, rel);
    if (Math.abs(c) < 1e-4 * Math.sqrt(d2)) {
      if (dot(rel, u) <= 0) return { error: '曲線模式：終點在起點後方' };
      return { segments: [straightSeg(a, b)], startDir: u, endDir: u, kind: 'S' };
    }
    const R = d2 / (2 * Math.abs(c));
    if (R < r * 0.999) {
      return { error: `曲線半徑 ${R.toFixed(2)} m 小於最小彎曲半徑 ${r.toFixed(2)} m` };
    }
    const phi = Math.atan2(Math.abs(c), dot(u, rel));
    const theta = 2 * phi;
    if (theta > MAX_ANGLE) return { error: '曲線模式：彎角超過 185°' };
    const ccw = c > 0;
    const center = add(a, mul(left(u), ccw ? R : -R));
    const segs = arcSegments(center, R, a, u, theta, ccw);
    return { segments: segs, startDir: u, endDir: rot(u, ccw ? theta : -theta), kind: 'C' };
  }
  if (isStraight(a, u, b, eDir)) {
    return { segments: [straightSeg(a, b)], startDir: u, endDir: eDir, kind: 'S' };
  }
  // Both headings fixed: tangent-based Hermite (BuildTangentBasedSpline3D); curvature validated later.
  const k = len(rel);
  return {
    segments: [{ p0: a, t0: mul(u, k), p1: b, t1: mul(norm(eDir), k) }],
    startDir: u,
    endDir: norm(eDir),
    kind: 'T',
  };
}

const ROUTERS = { default: routeDefault, straight: routeStraight, curve: routeCurve };

/**
 * Route a belt between two endpoint specs.
 * @returns {{path: Path, startDir, endDir, kind}|{error: string}}
 */
export function routeBelt(start, end, { mode = 'default', bendRadius = 2 } = {}) {
  const r = bendRadius;
  const sDir = start.dir ? norm(start.dir) : null;
  const eDir = end.dir ? norm(end.dir) : null;
  const c0 = sDir ? start.clearance || 0 : 0;
  const c1 = eDir ? end.clearance || 0 : 0;
  const a = sDir ? add(start.pos, mul(sDir, c0)) : start.pos;
  const b = eDir ? sub(end.pos, mul(eDir, c1)) : end.pos;
  if (dist(start.pos, end.pos) < 0.05) return { error: '起點與終點重疊' };
  if (dist(a, b) < 0.05 && !(sDir && eDir && dot(sDir, eDir) > 0.999)) {
    return { error: '兩端太近' };
  }

  let res;
  if (dist(a, b) < 0.05) {
    res = { segments: [], startDir: sDir, endDir: eDir, kind: 'S' };
  } else {
    res = (ROUTERS[mode] || routeDefault)(a, sDir, b, eDir, r);
  }
  if (res.error) return res;

  const segs = [];
  if (c0 > 1e-6) segs.push(straightSeg(start.pos, a));
  segs.push(...res.segments);
  if (c1 > 1e-6) segs.push(straightSeg(b, end.pos));
  if (!segs.length) return { error: '兩端太近' };
  return {
    path: new Path(segs, start.h, end.h),
    startDir: res.startDir,
    endDir: res.endDir,
    kind: res.kind,
  };
}
