// 2D vector helpers on the horizontal plane.
// A 2D vector [x, z] maps to three.js world (x, ?, z); height is handled separately.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul = (a, s) => [a[0] * s, a[1] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const neg = (a) => [-a[0], -a[1]];

export function norm(a) {
  const l = Math.hypot(a[0], a[1]);
  return l < 1e-12 ? [0, 0] : [a[0] / l, a[1] / l];
}

/** Rotate by +90° in math orientation: (x, z) → (−z, x). Used as "left" of a heading. */
export const left = (a) => [-a[1], a[0]];

/** Rotate by angle (radians) in math orientation (same sense as `left`). */
export function rot(a, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [a[0] * c - a[1] * s, a[0] * s + a[1] * c];
}

/**
 * Rotate a local building vector by a three.js `rotation.y` of `ang`.
 * Matches Object3D.rotation.y: x' = x·cos + z·sin, z' = −x·sin + z·cos.
 */
export function rotY(a, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [a[0] * c + a[1] * s, -a[0] * s + a[1] * c];
}

export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const DEG = Math.PI / 180;
