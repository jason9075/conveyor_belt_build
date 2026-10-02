// Belt path: a chain of 2D cubic Hermite segments on the horizontal plane,
// plus a height that varies linearly with horizontal arc length.
// Each segment stores endpoint positions and tangents.

import { cross, len, norm } from './vec.js';

/** Evaluate a Hermite segment at u ∈ [0, 1]. */
export function hermitePoint(seg, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return [
    h00 * seg.p0[0] + h10 * seg.t0[0] + h01 * seg.p1[0] + h11 * seg.t1[0],
    h00 * seg.p0[1] + h10 * seg.t0[1] + h01 * seg.p1[1] + h11 * seg.t1[1],
  ];
}

/** First derivative dp/du. */
export function hermiteDeriv(seg, u) {
  const u2 = u * u;
  const d00 = 6 * u2 - 6 * u;
  const d10 = 3 * u2 - 4 * u + 1;
  const d01 = -6 * u2 + 6 * u;
  const d11 = 3 * u2 - 2 * u;
  return [
    d00 * seg.p0[0] + d10 * seg.t0[0] + d01 * seg.p1[0] + d11 * seg.t1[0],
    d00 * seg.p0[1] + d10 * seg.t0[1] + d01 * seg.p1[1] + d11 * seg.t1[1],
  ];
}

/** Second derivative d²p/du². */
export function hermiteDeriv2(seg, u) {
  const e00 = 12 * u - 6;
  const e10 = 6 * u - 4;
  const e01 = -12 * u + 6;
  const e11 = 6 * u - 2;
  return [
    e00 * seg.p0[0] + e10 * seg.t0[0] + e01 * seg.p1[0] + e11 * seg.t1[0],
    e00 * seg.p0[1] + e10 * seg.t0[1] + e01 * seg.p1[1] + e11 * seg.t1[1],
  ];
}

export function reverseSegments(segs) {
  return segs
    .slice()
    .reverse()
    .map((s) => ({ p0: s.p1, t0: [-s.t1[0], -s.t1[1]], p1: s.p0, t1: [-s.t0[0], -s.t0[1]] }));
}

export class Path {
  /**
   * @param {{p0:number[],t0:number[],p1:number[],t1:number[]}[]} segments
   * @param {number} h0 height at the start (m)
   * @param {number} h1 height at the end (m)
   */
  constructor(segments, h0, h1) {
    this.segments = segments;
    this.h0 = h0;
    this.h1 = h1;
    this._buildTable();
  }

  _buildTable() {
    // Arc-length table: S[k] is the horizontal length at global parameter G[k] (= segIdx + u).
    const S = [0];
    const G = [0];
    let acc = 0;
    this.segments.forEach((seg, i) => {
      const chord = len([seg.p1[0] - seg.p0[0], seg.p1[1] - seg.p0[1]]);
      const n = Math.min(400, Math.max(12, Math.ceil(chord / 0.1)));
      let prev = hermitePoint(seg, 0);
      for (let k = 1; k <= n; k++) {
        const u = k / n;
        const p = hermitePoint(seg, u);
        acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        S.push(acc);
        G.push(i + u);
        prev = p;
      }
    });
    this._S = S;
    this._G = G;
    this.length2 = acc;
    this.dh = this.h1 - this.h0;
    this.length = Math.hypot(acc, this.dh);
  }

  /** Global parameter for a horizontal arc length. */
  _paramAt2(s2) {
    const S = this._S;
    if (s2 <= 0) return 0;
    if (s2 >= this.length2) return this.segments.length;
    let lo = 0;
    let hi = S.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s2) lo = mid;
      else hi = mid;
    }
    const t = (s2 - S[lo]) / (S[hi] - S[lo] || 1);
    return this._G[lo] + (this._G[hi] - this._G[lo]) * t;
  }

  _segAt(g) {
    let i = Math.floor(g);
    if (i >= this.segments.length) i = this.segments.length - 1;
    return [this.segments[i], g - i];
  }

  /**
   * Sample by 3D arc length s ∈ [0, length].
   * Returns world-space position [x, y, z] and unit direction [x, y, z].
   */
  sample(s) {
    const L = this.length || 1;
    const t = Math.min(1, Math.max(0, s / L));
    const s2 = t * this.length2;
    const [seg, u] = this._segAt(this._paramAt2(s2));
    const p = hermitePoint(seg, u);
    const d = norm(hermiteDeriv(seg, u));
    const slope = this.length2 > 1e-9 ? this.dh / this.length2 : 0;
    const dir = [d[0], slope, d[1]];
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    return {
      pos: [p[0], this.h0 + this.dh * t, p[1]],
      dir: [dir[0] / dl, dir[1] / dl, dir[2] / dl],
      dir2: d,
    };
  }

  /** Evenly spaced samples (spacing in metres, 3D arc length). Always includes both ends. */
  samples(spacing = 0.5) {
    const n = Math.max(1, Math.ceil(this.length / spacing));
    const out = [];
    for (let i = 0; i <= n; i++) {
      const s = (i / n) * this.length;
      out.push({ s, ...this.sample(s) });
    }
    return out;
  }

  /** Smallest radius of curvature over the path (horizontal plane), in metres. */
  minRadius() {
    let minR = Infinity;
    for (const seg of this.segments) {
      for (let k = 0; k <= 24; k++) {
        const u = k / 24;
        const d1 = hermiteDeriv(seg, u);
        const d2 = hermiteDeriv2(seg, u);
        const sp = len(d1);
        if (sp < 1e-9) continue;
        const kappa = Math.abs(cross(d1, d2)) / (sp * sp * sp);
        if (kappa > 1e-9) minR = Math.min(minR, 1 / kappa);
      }
    }
    return minR;
  }

  /** Incline in radians (constant, height is linear in arc length). */
  incline() {
    return Math.atan2(Math.abs(this.dh), this.length2);
  }

  /** Closest arc length (3D) to a world point [x, y, z]; coarse search then refine. */
  closest(point) {
    const samples = this.samples(0.25);
    let best = samples[0];
    let bestD = Infinity;
    for (const smp of samples) {
      const d =
        (smp.pos[0] - point[0]) ** 2 + (smp.pos[1] - point[1]) ** 2 + (smp.pos[2] - point[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = smp;
      }
    }
    return { s: best.s, dist: Math.sqrt(bestD), pos: best.pos, dir: best.dir };
  }

  reversed() {
    return new Path(reverseSegments(this.segments), this.h1, this.h0);
  }

  get startPos() {
    return this.segments[0].p0;
  }
  get endPos() {
    return this.segments[this.segments.length - 1].p1;
  }
  get startDir() {
    return norm(hermiteDeriv(this.segments[0], 0));
  }
  get endDir() {
    return norm(hermiteDeriv(this.segments[this.segments.length - 1], 1));
  }

  toJSON() {
    return { segments: this.segments, h0: this.h0, h1: this.h1 };
  }

  static fromJSON(o) {
    return new Path(o.segments, o.h0, o.h1);
  }
}
