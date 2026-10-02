import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/core/world.js';
import { Simulation } from '../src/core/sim.js';
import { analyze, waterfill } from '../src/core/analysis.js';
import { buildDemo, buildCapacityDemo } from '../src/core/examples.js';

const near = (a, b, eps) => Math.abs(a - b) <= eps;

function run(sim, seconds) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) sim.step(dt);
}

test('waterfill is max-min fair', () => {
  assert.deepEqual(waterfill(60, [10, 100, 100]), [10, 25, 25]);
  assert.deepEqual(waterfill(30, [0, 100]), [0, 30]);
});

test('flow direction: dragging from an input port builds a reversed belt', () => {
  const w = new World();
  const src = w.addBuilding({ type: 'source', x: 0, z: 0 });
  const sink = w.addBuilding({ type: 'sink', x: 0, z: 12, rot: Math.PI });
  const plan = w.planBelt({ key: `p:${sink.id}:0` }, { key: `p:${src.id}:0` });
  assert.ok(!plan.error, plan.error);
  assert.equal(plan.reversed, true);
  assert.equal(plan.from, `p:${src.id}:0`);
  assert.equal(plan.to, `p:${sink.id}:0`);
  assert.deepEqual(plan.errors, []);
  const bad = w.planBelt({ key: `p:${src.id}:0` }, { key: `p:${src.id}:0` });
  assert.ok(bad.error);
});

test('capacity demo: a belt caps a 120/min source at 60/min (analysis + simulation)', () => {
  const w = new World();
  buildCapacityDemo(w, { rate: 120 });
  const a = analyze(w);
  const [b1, b2] = [...w.belts.keys()];
  assert.ok(near(a.belts.get(b1).flow, 60, 1e-6));
  assert.ok(a.belts.get(b1).overCapacity);
  assert.ok(near(a.delivered, 60, 1e-6));

  const sim = new Simulation(w);
  run(sim, 90);
  const measured = sim.beltRate(b2);
  assert.ok(near(measured, 60, 2.5), `measured ${measured}`);
});

test('demo warehouse: every belt routes cleanly', () => {
  const w = new World();
  buildDemo(w);
  assert.equal(w.belts.size, 6);
  for (const belt of w.belts.values()) {
    const plan = w.replanBelt(belt);
    assert.ok(!plan.error, plan.error);
    assert.deepEqual(plan.errors.filter((e) => !e.startsWith('碰撞')), [], `belt ${belt.id}`);
  }
});

test('demo warehouse: belt cap, slow packing station and splitter redistribution', () => {
  const w = new World();
  buildDemo(w);
  const a = analyze(w);
  assert.ok(near(a.delivered, 100, 1e-6), `delivered ${a.delivered}`);
  const packing = [...w.buildings.values()].find((b) => b.type === 'sink' && b.config.rate === 15);
  assert.ok(near(a.nodes.get(packing.id).input, 15, 1e-6));
  const recv = [...w.buildings.values()].find((b) => b.type === 'wall');
  const holes = a.nodes.get(recv.id).holes;
  assert.ok(near(holes[0].flow, 40, 1e-6) && near(holes[1].flow, 60, 1e-6), JSON.stringify(holes));
  assert.ok(a.issues.some((i) => i.text.includes('容量不足')));
});

test('demo warehouse: simulation converges toward the analytic rate', () => {
  const w = new World();
  buildDemo(w);
  const sim = new Simulation(w);
  run(sim, 300);
  let got = 0;
  for (const b of w.buildings.values()) {
    const st = sim.nodeStats(b.id);
    if (b.type === 'sink' || b.type === 'wall') got += st.consumed;
  }
  assert.ok(near(got, 100, 6), `received ${got}`);
});

test('split a belt with a splitter, then move a building', () => {
  const w = new World();
  buildCapacityDemo(w, { rate: 60 });
  const [b1] = [...w.belts.values()];
  const res = w.splitBeltWith(b1.id, 'splitter', b1.path.length / 2);
  assert.ok(res.ok, res.error);
  assert.equal(w.belts.size, 3);
  const a = analyze(w);
  assert.ok(near(a.delivered, 60, 1e-6));

  const sink = [...w.buildings.values()].find((b) => b.type === 'sink');
  const mv = w.moveBuilding(sink.id, sink.x + 2, sink.z + 1, sink.rot);
  assert.ok(mv.ok, mv.error);

  const json = JSON.parse(JSON.stringify(w.toJSON()));
  const w2 = new World();
  w2.load(json);
  assert.equal(w2.belts.size, 3);
  assert.ok(near(analyze(w2).delivered, 60, 1e-6));
});

test('removing a building leaves belt ends open', () => {
  const w = new World();
  buildCapacityDemo(w, { rate: 60 });
  const sink = [...w.buildings.values()].find((b) => b.type === 'sink');
  w.removeBuilding(sink.id);
  const open = w.connectors().filter((c) => !c.connected && c.owner.type === 'belt');
  assert.equal(open.length, 1);
  const a = analyze(w);
  assert.ok(a.issues.some((i) => i.text.includes('末端沒有連接')));
});

// ------------------------------------------------------------------ walls

function wallWorld() {
  const w = new World();
  const wall = w.addBuilding({ type: 'wall', x: 0, z: 0, config: { length: 10 } });
  w.addWallHole(wall.id, 'out', -3);
  w.addWallHole(wall.id, 'in', 3);
  w.updateWallHole(wall.id, 0, { rate: 30 });
  return { w, wall };
}

test('wall holes act as source and sink', () => {
  const { w, wall } = wallWorld();
  const ports = w.buildingPorts(wall);
  assert.equal(ports.length, 2);
  assert.deepEqual(ports.map((p) => p.dir), ['out', 'in']);
  // Out hole → splitter → back into the in hole (the splitter's side outputs stay open).
  const sp = w.addBuilding({ type: 'splitter', x: 0, z: 10, rot: Math.PI / 2 });
  for (const [a, b] of [
    [{ key: `p:${wall.id}:0` }, { key: `p:${sp.id}:0` }],
    [{ key: `p:${sp.id}:1` }, { key: `p:${wall.id}:1` }],
  ]) {
    const plan = w.planBelt(a, b);
    assert.ok(!plan.error, plan.error);
    w.commitPlan(plan);
  }
  const a = analyze(w);
  assert.ok(near(a.delivered, 30, 1e-6), `delivered ${a.delivered}`);
  const rep = a.nodes.get(wall.id);
  assert.ok(near(rep.output, 30, 1e-6) && near(rep.input, 30, 1e-6));

  const sim = new Simulation(w);
  run(sim, 120);
  const st = sim.nodeStats(wall.id);
  assert.ok(near(st.holes[1], 30, 2), `measured in-hole ${st.holes[1]}`);
});

test('wall holes: spacing, removal re-indexes links, moving re-routes', () => {
  const { w, wall } = wallWorld();
  assert.ok(w.addWallHole(wall.id, 'out', -2.5).error, 'too close to hole 0');
  assert.ok(w.updateWallHole(wall.id, 0, { offset: -6 }).error, 'outside the wall');

  const sink = w.addBuilding({ type: 'sink', x: 3, z: 10, rot: Math.PI });
  const belt = w.commitPlan(w.planBelt({ key: `p:${wall.id}:0` }, { key: `p:${sink.id}:0` }));
  assert.equal(belt.from, `p:${wall.id}:0`);
  w.removeWallHole(wall.id, 1); // unconnected, after the linked one
  w.addWallHole(wall.id, 'in', 3);
  w.removeWallHole(wall.id, 1);
  assert.equal(belt.from, `p:${wall.id}:0`);

  // Put a hole before the linked one, then remove it: the link must follow to index 0.
  w.addWallHole(wall.id, 'in', 2);
  w.updateWallHole(wall.id, 0, { offset: 0 });
  assert.equal(w.portLinks.get(`p:${wall.id}:0`), belt.id);
  const before = belt.path;
  assert.ok(w.updateWallHole(wall.id, 0, { offset: -1 }).ok);
  assert.notEqual(belt.path, before, 'belt re-routed');

  // Flip direction → belt is disconnected.
  w.updateWallHole(wall.id, 0, { dir: 'in' });
  assert.equal(belt.from, null);
  assert.equal(w.portLinks.has(`p:${wall.id}:0`), false);
});

test('wall size: shrinking clamps holes, overlaps are rejected, save/load keeps holes', () => {
  const { w, wall } = wallWorld();
  assert.ok(w.setWallSize(wall.id, { length: 2 }).error, 'two holes do not fit in 2 m');
  assert.equal(wall.config.length, 10);
  assert.ok(w.setWallSize(wall.id, { length: 6 }).ok);
  assert.ok(wall.config.holes.every((h) => Math.abs(h.offset) <= 2.4 + 1e-9));

  assert.ok(w.buildingOverlaps({ type: 'splitter', x: 0, z: 1, rot: 0, config: {} }), 'splitter on the wall');
  assert.ok(!w.buildingOverlaps({ type: 'splitter', x: 0, z: 2, rot: 0, config: {} }));
  // Two walls crossing like a plus sign: no corner of either lies inside the other.
  w.addBuilding({ type: 'wall', x: 25, z: 0, rot: Math.PI / 2, config: { length: 6 } });
  assert.ok(w.buildingOverlaps({ type: 'wall', x: 20, z: 2, rot: 0, config: { length: 20 } }));
  assert.equal(w.buildingOverlaps({ type: 'wall', x: 20, z: 4, rot: 0, config: { length: 20 } }), null);

  const w2 = new World();
  w2.load(JSON.parse(JSON.stringify(w.toJSON())));
  assert.equal(w2.buildings.get(wall.id).config.holes.length, 2);
});

// ------------------------------------------------------------------ 3D

test('wall holes stack vertically; belts climb between heights', () => {
  const w = new World();
  const wall = w.addBuilding({ type: 'wall', x: 0, z: 0, config: { length: 2, height: 6 } });
  // 2 m wall: one hole per row, so additional holes go up a row.
  assert.ok(w.addWallHole(wall.id, 'out').ok);
  assert.ok(w.addWallHole(wall.id, 'out').ok);
  assert.deepEqual(wall.config.holes.map((h) => h.y), [1, 2.2]);
  assert.ok(w.updateWallHole(wall.id, 1, { y: 1.5 }).error, 'overlaps the hole below');
  assert.ok(w.setWallSize(wall.id, { height: 2.5 }).error, 'upper hole would stick out');
  assert.equal(w.buildingPorts(wall)[1].h, 2.2);

  // Upper hole feeds a receiver on a mezzanine.
  const sink = w.addBuilding({ type: 'sink', x: 0, y: 3, z: 12, rot: Math.PI });
  const plan = w.planBelt({ key: `p:${wall.id}:1` }, { key: `p:${sink.id}:0` });
  assert.ok(!plan.error, plan.error);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.path.h0, 2.2);
  assert.equal(plan.path.h1, 4);
  w.commitPlan(plan);
  assert.ok(near(analyze(w).delivered, 60, 1e-6));

  // Raising the receiver re-routes its belt.
  assert.ok(w.setElevation(sink.id, 5).ok);
  const belt = [...w.belts.values()][0];
  assert.equal(belt.path.h1, 6);
});

test('facilities at different heights may share a footprint', () => {
  const w = new World();
  w.addBuilding({ type: 'splitter', x: 0, z: 0 });
  assert.ok(w.buildingOverlaps({ type: 'splitter', x: 0, y: 1, z: 0, rot: 0, config: {} }));
  assert.equal(w.buildingOverlaps({ type: 'splitter', x: 0, y: 2, z: 0, rot: 0, config: {} }), null);
  const up = w.addBuilding({ type: 'sink', x: 0, y: 2, z: 0 });
  assert.ok(w.setElevation(up.id, 0.5).error);
});

test('holes on the back face point the other way; flipping the face disconnects', () => {
  const w = new World();
  const wall = w.addBuilding({ type: 'wall', x: 0, z: 0, config: { length: 6 } });
  assert.ok(w.canPlaceHole(wall, 0, 1));
  w.addWallHole(wall.id, 'out', 0, 1, -1);
  assert.equal(w.canPlaceHole(wall, 0.5, 1), false, 'same opening, other face');
  const [port] = w.buildingPorts(wall);
  assert.deepEqual(port.normal, [0, -1]);
  assert.ok(port.pos[1] < 0);
  const sink = w.addBuilding({ type: 'sink', x: 0, z: -10 });
  w.commitPlan(w.planBelt({ key: port.key }, { key: `p:${sink.id}:0` }));
  assert.ok(w.portLinks.has(port.key));
  w.updateWallHole(wall.id, 0, { side: 1 });
  assert.equal(w.portLinks.has(port.key), false);
});

test('merger: two docks into one belt, capped at belt capacity and shared fairly', () => {
  const w = new World();
  const a = w.addBuilding({ type: 'source', x: -8, z: 0, rot: Math.PI / 2, config: { rate: 20 } });
  const b = w.addBuilding({ type: 'source', x: 8, z: 0, rot: -Math.PI / 2, config: { rate: 50 } });
  const m = w.addBuilding({ type: 'merger', x: 0, z: 0 });
  const sink = w.addBuilding({ type: 'sink', x: 0, z: 12, rot: Math.PI });
  for (const [from, to] of [
    [`p:${a.id}:0`, `p:${m.id}:1`],
    [`p:${b.id}:0`, `p:${m.id}:2`],
    [`p:${m.id}:3`, `p:${sink.id}:0`],
  ]) {
    const plan = w.planBelt({ key: from }, { key: to });
    assert.ok(!plan.error, plan.error);
    w.commitPlan(plan);
  }
  const r = analyze(w);
  assert.ok(near(r.delivered, 60, 1e-6), `delivered ${r.delivered}`);
  assert.ok(near(r.nodes.get(a.id).output, 20, 1e-6), 'small dock gets all it offers');
  assert.ok(near(r.nodes.get(b.id).output, 40, 1e-6), 'big dock gets the rest');

  const sim = new Simulation(w);
  run(sim, 120);
  assert.ok(near(sim.nodeStats(sink.id).consumed, 60, 3), `measured ${sim.nodeStats(sink.id).consumed}`);
});

// ------------------------------------------------------------------ stacking

test('splitter and merger stack into a second layer; both layers carry boxes', () => {
  const w = new World();
  const low = w.addBuilding({ type: 'splitter', x: 0, z: 0 });
  const top = w.topOf(low);
  assert.equal(w.buildingOverlaps({ type: 'merger', x: 0, y: top, z: 0, rot: 0, config: {} }), null);
  const high = w.addBuilding({ type: 'merger', x: 0, y: top, z: 0 });
  assert.equal(w.supportHeight(high), top, 'stands on the splitter, no legs');
  assert.equal(w.supportHeight(low), 0);
  assert.ok(w.buildingOverlaps({ type: 'splitter', x: 0, y: 1, z: 0, rot: 0, config: {} }), 'no room between the layers');

  // Layer 1: dock → splitter → receiver. Layer 2: dock on a mezzanine → merger → receiver.
  const d1 = w.addBuilding({ type: 'source', x: 0, z: -10, config: { rate: 30 } });
  const r1 = w.addBuilding({ type: 'sink', x: 0, z: 12, rot: Math.PI });
  const d2 = w.addBuilding({ type: 'source', x: -12, y: top, z: 0, rot: Math.PI / 2, config: { rate: 20 } });
  const r2 = w.addBuilding({ type: 'sink', x: 10, y: top, z: 10, rot: Math.PI });
  for (const [f, t] of [
    [`p:${d1.id}:0`, `p:${low.id}:0`],
    [`p:${low.id}:1`, `p:${r1.id}:0`],
    [`p:${d2.id}:0`, `p:${high.id}:1`],
    [`p:${high.id}:3`, `p:${r2.id}:0`],
  ]) {
    const plan = w.planBelt({ key: f }, { key: t });
    assert.ok(!plan.error, plan.error);
    assert.deepEqual(plan.errors, [], `${f} → ${t}`);
    w.commitPlan(plan);
  }
  const a = analyze(w);
  assert.ok(near(a.nodes.get(r1.id).input, 30, 1e-6));
  assert.ok(near(a.nodes.get(r2.id).input, 20, 1e-6));
});

test('walls stack storey by storey; holes go on any storey', () => {
  const w = new World();
  const g = w.addBuilding({ type: 'wall', x: 0, z: 0, config: { length: 8 } });
  assert.equal(g.config.height, 4, 'one storey by default');
  const up = w.addBuilding({ type: 'wall', x: 0, y: w.topOf(g), z: 0, config: { length: 8, height: 4 } });
  assert.equal(up.y, 4);
  assert.equal(w.supportHeight(up), 4);
  assert.ok(w.addWallHole(up.id, 'in', 0, 1).ok);
  assert.equal(w.buildingPorts(up)[0].h, 5, 'belt height on the second storey');
});

// ------------------------------------------------------------------ conveyor poles (貨架)

test('pole lifts a line to the second floor; stacked pole adds another connector', () => {
  const w = new World();
  const dock = w.addBuilding({ type: 'source', x: 0, z: 0, config: { rate: 30 } });
  const pole = w.addBuilding({ type: 'pole', x: 0, z: 12, config: { height: 4 } });
  const up = w.addBuilding({ type: 'sink', x: 0, y: 4, z: 24, rot: Math.PI });
  assert.deepEqual(w.buildingPorts(pole).map((p) => [p.dir, p.h]), [['in', 4], ['out', 4]]);
  for (const [f, t] of [
    [`p:${dock.id}:0`, `p:${pole.id}:0`],
    [`p:${pole.id}:1`, `p:${up.id}:0`],
  ]) {
    const plan = w.planBelt({ key: f }, { key: t });
    assert.ok(!plan.error, plan.error);
    assert.deepEqual(plan.errors, [], `${f} → ${t}`);
    w.commitPlan(plan);
  }
  assert.ok(near(analyze(w).delivered, 30, 1e-6));
  const sim = new Simulation(w);
  run(sim, 120);
  assert.ok(near(sim.nodeStats(up.id).consumed, 30, 2), `measured ${sim.nodeStats(up.id).consumed}`);

  // Raising the pole re-routes both belts.
  assert.ok(w.setPoleHeight(pole.id, 5).ok);
  assert.equal([...w.belts.values()][0].path.h1, 5);

  // Stack a second pole on top: its connector sits 2 m above the first one's top.
  const top = w.addBuilding({ type: 'pole', x: 0, y: w.topOf(pole), z: 12, config: { height: 2 } });
  assert.equal(w.buildingPorts(top)[0].h, 7);
  assert.equal(w.supportHeight(top), 5);
  assert.ok(w.setPoleHeight(pole.id, 6).error, 'would push into the pole above');
});

test('walls meet at corners, T-junctions and in a straight run, but may not cross', () => {
  const w = new World();
  // Drawn like the wall tool does: from (0,0) to (10,0), then from (10,0) to (10,10).
  const a = w.addBuilding({ type: 'wall', x: 5, z: 0, rot: 0, config: { length: 10 } });
  const corner = { type: 'wall', x: 10, z: 5, rot: -Math.PI / 2, config: { length: 10 } };
  assert.equal(w.buildingOverlaps(corner), null, '90° corner');
  w.addBuilding(corner);
  assert.equal(w.buildingOverlaps({ type: 'wall', x: 5, z: 5, rot: -Math.PI / 2, config: { length: 10 } }), null, 'T-junction');
  assert.equal(w.buildingOverlaps({ type: 'wall', x: 15, z: 0, rot: 0, config: { length: 10 } }), null, 'straight run');
  assert.ok(w.buildingOverlaps({ type: 'wall', x: 5, z: 0, rot: -Math.PI / 2, config: { length: 10 } }), 'crossing');
  assert.ok(w.buildingOverlaps({ type: 'wall', x: 6, z: 0, rot: 0, config: { length: 10 } }), 'lying on top of another');
  // The slab reaches past its end points, so the outer corner is closed.
  assert.ok(w.insideFootprint(a, [10.2, -0.2]));
});
