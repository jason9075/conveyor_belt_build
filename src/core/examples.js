// Example layouts. Belts are routed with the same planner the player uses.

const port = (b, i) => ({ key: `p:${b.id}:${i}` });

function belt(world, from, to, opts = {}) {
  const plan = world.planBelt(from, to, opts);
  if (plan.error) throw new Error(`example belt failed: ${plan.error}`);
  return world.commitPlan(plan);
}

/**
 * Small warehouse, flowing from the receiving wall (z = 0) to the shipping wall (z = 30):
 *   dock A 40 boxes/min → splitter → storage inlet + shipping hole
 *   dock B 90 boxes/min → splitter → packing station on a mezzanine (15/min) + shipping hole
 * Deliberate bottlenecks: dock B outruns its belt (60/min), and the packing station is slow,
 * so its splitter pushes the rest toward shipping.
 */
export function buildDemo(world) {
  world.batch(() => {
    world.clear();
    // Receiving wall: holes face +z (into the warehouse).
    const recv = world.addBuilding({ type: 'wall', x: 0, z: 0, config: { length: 24, height: 5 } });
    world.addWallHole(recv.id, 'out', -6);
    world.addWallHole(recv.id, 'out', 6);
    world.updateWallHole(recv.id, 0, { rate: 40 });
    world.updateWallHole(recv.id, 1, { rate: 90 });
    // Shipping wall: rotated 180°, so holes face -z and local offset o sits at world x = −o.
    const ship = world.addBuilding({ type: 'wall', x: 0, z: 30, rot: Math.PI, config: { length: 24, height: 5 } });
    world.addWallHole(ship.id, 'in', 6); // world x = −6
    world.addWallHole(ship.id, 'in', -6); // world x = +6

    const spA = world.addBuilding({ type: 'splitter', x: -6, z: 10 });
    const spB = world.addBuilding({ type: 'splitter', x: 6, z: 10 });
    const storage = world.addBuilding({ type: 'sink', x: -16, z: 10, rot: Math.PI / 2 });
    // Packing station up on a 2.5 m mezzanine: its belt climbs.
    const packing = world.addBuilding({ type: 'sink', x: 17, y: 2.5, z: 10, rot: -Math.PI / 2, config: { rate: 15 } });

    belt(world, port(recv, 0), port(spA, 0));
    belt(world, port(recv, 1), port(spB, 0));
    belt(world, port(spA, 2), port(storage, 0)); // left
    belt(world, port(spA, 1), port(ship, 0)); // forward
    belt(world, port(spB, 3), port(packing, 0)); // right
    belt(world, port(spB, 1), port(ship, 1)); // forward
  });
}

/** A single dock feeding a receiver through a free-standing chain of belts. */
export function buildCapacityDemo(world, { rate = 120 } = {}) {
  world.batch(() => {
    world.clear();
    const src = world.addBuilding({ type: 'source', x: 0, z: 0, config: { rate } });
    const sink = world.addBuilding({ type: 'sink', x: 20, z: 12, rot: -Math.PI / 2 });
    const b1 = belt(world, port(src, 0), { pos: [6, 8], h: 1, dir: null });
    belt(world, { key: `b:${b1.id}:out` }, port(sink, 0));
  });
}
