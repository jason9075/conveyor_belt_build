import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arcTangentMagnitude,
  arcSegments,
  bendStraightBend,
  routeBelt,
  oneBendHeading,
} from '../src/core/routing.js';
import { Path, hermitePoint, hermiteDeriv } from '../src/core/path.js';
import { snapToGuidelines } from '../src/core/guidelines.js';
import { validatePath, DEFAULT_RULES } from '../src/core/validate.js';
import { dist, norm, dot, DEG } from '../src/core/vec.js';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

function assertContinuous(path) {
  const segs = path.segments;
  for (let i = 1; i < segs.length; i++) {
    assert.ok(dist(segs[i - 1].p1, segs[i].p0) < 1e-6, `gap at ${i}`);
    const d0 = norm(hermiteDeriv(segs[i - 1], 1));
    const d1 = norm(hermiteDeriv(segs[i], 0));
    assert.ok(dot(d0, d1) > 0.9999, `kink at ${i}`);
  }
}

test('arc tangent magnitude matches 4·tan(θ/4)·r and the arc stays on the circle', () => {
  assert.ok(near(arcTangentMagnitude(Math.PI / 2, 2), 2 * 4 * Math.tan(Math.PI / 8)));
  const segs = arcSegments([0, 0], 2, [2, 0], [0, 1], Math.PI / 2, true);
  let worst = 0;
  for (let k = 0; k <= 100; k++) worst = Math.max(worst, Math.abs(Math.hypot(...hermitePoint(segs[0], k / 100)) - 2));
  assert.ok(worst / 2 < 3e-4, `radius error ${worst}`);
});

test('bend-straight-bend: analytic length equals sampled length', () => {
  const cases = [
    [[0, 0], [1, 0], [12, 3], [1, 0]],
    [[0, 0], [1, 0], [8, 8], [0, 1]],
    [[0, 0], [1, 0], [0, 8], [-1, 0]],
    [[0, 0], [1, 0], [-6, 5], [0, -1]],
  ];
  for (const [P0, N0, P1, N1] of cases) {
    const r = bendStraightBend(P0, N0, P1, N1, 2);
    assert.ok(r, `no solution for ${P1}`);
    const path = new Path(r.segments, 0, 0);
    assert.ok(near(path.length2, r.total, 0.01), `${path.length2} vs ${r.total}`);
    assert.ok(dist(path.endPos, P1) < 1e-6);
    assert.ok(dot(path.endDir, N1) > 0.9999);
    assertContinuous(path);
    assert.ok(path.minRadius() > 2 * DEFAULT_RULES.curvatureTolerance, `minR ${path.minRadius()}`);
  }
});

test('S-bend uses an inner tangent (LSR or RSL)', () => {
  const r = bendStraightBend([0, 0], [1, 0], [12, 3], [1, 0], 2);
  assert.match(r.kind, /LSR|RSL/);
});

test('free end in default mode → one bend then straight', () => {
  const h = oneBendHeading([0, 0], [1, 0], [10, 6], 2);
  const res = routeBelt({ pos: [0, 0], h: 1, dir: [1, 0] }, { pos: [10, 6], h: 1, dir: null }, { bendRadius: 2 });
  assert.ok(!res.error);
  assert.ok(dot(res.endDir, h) > 0.9999);
  assertContinuous(res.path);
});

test('clearance leads are straight and exact', () => {
  const res = routeBelt(
    { pos: [0, 0], h: 1, dir: [1, 0], clearance: 0.5 },
    { pos: [10, 4], h: 1, dir: [0, 1], clearance: 0.5 },
    { bendRadius: 2 },
  );
  assert.ok(!res.error, res.error);
  assert.ok(dist(res.path.startPos, [0, 0]) < 1e-9);
  assert.ok(dist(res.path.endPos, [10, 4]) < 1e-9);
  assertContinuous(res.path);
});

test('straight/orthogonal mode builds L, Z and U shapes with valid radius', () => {
  const opts = { mode: 'straight', bendRadius: 2 };
  const L = routeBelt({ pos: [0, 0], h: 1, dir: [1, 0] }, { pos: [10, 6], h: 1, dir: null }, opts);
  assert.equal(L.kind, 'L');
  const Z = routeBelt({ pos: [0, 0], h: 1, dir: [1, 0] }, { pos: [10, 6], h: 1, dir: [1, 0] }, opts);
  assert.equal(Z.kind, 'Z');
  const U = routeBelt({ pos: [0, 0], h: 1, dir: [1, 0] }, { pos: [0, 6], h: 1, dir: [-1, 0] }, opts);
  assert.equal(U.kind, 'U');
  for (const r of [L, Z, U]) {
    assert.ok(!r.error, r.error);
    assertContinuous(r.path);
    assert.deepEqual(validatePath(r.path), []);
  }
});

test('curve mode: single arc through the target', () => {
  const res = routeBelt({ pos: [0, 0], h: 1, dir: [1, 0] }, { pos: [8, 4], h: 1, dir: null }, { mode: 'curve' });
  assert.ok(!res.error, res.error);
  assert.ok(dist(res.path.endPos, [8, 4]) < 1e-6);
  const tight = routeBelt({ pos: [0, 0], h: 1, dir: [1, 0] }, { pos: [1, 1.5], h: 1, dir: null }, { mode: 'curve' });
  assert.ok(tight.error);
});

test('reverse problem: free start, fixed end', () => {
  const res = routeBelt({ pos: [0, 0], h: 1, dir: null }, { pos: [10, 5], h: 1, dir: [0, 1] }, {});
  assert.ok(!res.error, res.error);
  assert.ok(dot(res.path.endDir, [0, 1]) > 0.9999);
  assertContinuous(res.path);
});

test('validation: length and incline', () => {
  const long = routeBelt({ pos: [0, 0], h: 1, dir: null }, { pos: [60, 0], h: 1, dir: null }, {});
  assert.match(validatePath(long.path).join(), /太長/);
  const steep = routeBelt({ pos: [0, 0], h: 1, dir: null }, { pos: [10, 0], h: 10, dir: null }, {});
  assert.match(validatePath(steep.path).join(), /太陡/);
});

test('guidelines: projection and intersection', () => {
  const lines = [
    { origin: [0, 0], dir: [1, 0] },
    { origin: [10, -10], dir: [0, 1] },
  ];
  const one = snapToGuidelines([5, 0.4], lines, 1);
  assert.deepEqual(one.point.map((v) => +v.toFixed(6)), [5, 0]);
  const both = snapToGuidelines([10.3, 0.5], lines, 1);
  assert.ok(dist(both.point, [10, 0]) < 1e-9);
  assert.equal(snapToGuidelines([5, 3], lines, 1), null);
});
