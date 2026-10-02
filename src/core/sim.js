// Discrete box simulation.
// Each item on a belt is represented by an arc-length offset; items keep
// ITEM_SPACING apart, so a belt's throughput is bounded by speed / spacing = BELT.rate.

import { BUILDINGS, ITEM_SPACING, BELT_SPEED, holesOf } from './catalog.js';

const WINDOW = 120; // seconds of history used for measured rates

class RateMeter {
  constructor() {
    this.times = [];
    this.head = 0;
  }
  hit(t) {
    this.times.push(t);
  }
  rate(now, since) {
    const from = now - WINDOW;
    while (this.head < this.times.length && this.times[this.head] < from) this.head++;
    if (this.head > 4096) {
      this.times = this.times.slice(this.head);
      this.head = 0;
    }
    const count = this.times.length - this.head;
    if (count >= 3) {
      // Mean inter-arrival time; decays if the flow stalls (time since last hit dominates).
      const first = this.times[this.head];
      const last = this.times[this.times.length - 1];
      const interval = (last - first) / (count - 1);
      return 60 / Math.max(interval, now - last);
    }
    const span = Math.min(WINDOW, now - since);
    if (span < 1) return 0;
    return (count * 60) / span;
  }
}

class BeltRT {
  constructor(belt) {
    this.id = belt.id;
    this.items = []; // sorted by s descending; items[0] is the front
    this.meter = new RateMeter();
    this.since = 0;
    this.sync(belt);
  }
  sync(belt) {
    this.belt = belt;
    this.length = belt.path.length;
    this.speed = BELT_SPEED;
    for (const it of this.items) it.s = Math.min(it.s, this.length);
  }
  canAccept(dt) {
    if (!this.items.length) return true;
    return this.items[this.items.length - 1].s >= ITEM_SPACING - this.speed * dt - 1e-9;
  }
  accept(excess = 0) {
    const last = this.items[this.items.length - 1];
    const s = last ? Math.min(excess, last.s - ITEM_SPACING) : excess;
    this.items.push({ s: Math.min(s, this.length) });
  }
  front() {
    const f = this.items[0];
    return f && f.s >= this.length - 1e-6 ? f : null;
  }
  take(now) {
    this.meter.hit(now);
    return this.items.shift();
  }
}

class NodeRT {
  constructor(b) {
    this.id = b.id;
    this.holeAcc = []; // per hole: source credit / sink allowance
    this.holeMeters = [];
    this.buf = 0; // splitter / merger: boxes waiting to go out
    this.rr = 0;
    this.status = 'idle';
    this.produced = new RateMeter();
    this.consumed = new RateMeter();
    this.since = 0;
    this.sync(b);
  }
  sync(b) {
    this.b = b;
    this.def = BUILDINGS[b.type];
    this.holes = holesOf(b);
    if (this.holes) {
      const n = this.holes.length;
      while (this.holeAcc.length < n) this.holeAcc.push(0);
      while (this.holeMeters.length < n) this.holeMeters.push(new RateMeter());
      this.holeAcc.length = n;
      this.holeMeters.length = n;
    }
  }
}

export class Simulation {
  constructor(world) {
    this.world = world;
    this.time = 0;
    this.belts = new Map();
    this.nodes = new Map();
    this.rebuild();
  }

  /** Sync runtime state with the world (keeps items on belts that still exist). */
  rebuild() {
    const w = this.world;
    for (const id of [...this.belts.keys()]) if (!w.belts.has(id)) this.belts.delete(id);
    for (const id of [...this.nodes.keys()]) if (!w.buildings.has(id)) this.nodes.delete(id);
    for (const belt of w.belts.values()) {
      const rt = this.belts.get(belt.id);
      if (rt) rt.sync(belt);
      else {
        const n = new BeltRT(belt);
        n.since = this.time;
        this.belts.set(belt.id, n);
      }
    }
    for (const b of w.buildings.values()) {
      const rt = this.nodes.get(b.id);
      if (rt && rt.b.type === b.type) rt.sync(b);
      else {
        const n = new NodeRT(b);
        n.since = this.time;
        this.nodes.set(b.id, n);
      }
    }
    // Wiring
    for (const rt of this.belts.values()) {
      const to = rt.belt.to;
      rt.next = to && to.startsWith('b:') ? this.belts.get(Number(to.split(':')[1])) ?? null : null;
    }
    for (const n of this.nodes.values()) {
      const ports = w.buildingPorts(n.b);
      n.inputs = ports.filter((p) => p.dir === 'in').map((p) => this.belts.get(w.portLinks.get(p.key)) ?? null);
      n.outputs = ports.filter((p) => p.dir === 'out').map((p) => this.belts.get(w.portLinks.get(p.key)) ?? null);
      n.portBelts = ports.map((p) => this.belts.get(w.portLinks.get(p.key)) ?? null);
    }
  }

  reset() {
    this.time = 0;
    this.belts.clear();
    this.nodes.clear();
    this.rebuild();
  }

  step(dt) {
    this.time += dt;
    const now = this.time;
    for (const rt of this.belts.values()) this._moveBelt(rt, dt, now);
    for (const n of this.nodes.values()) this._updateNode(n, dt, now);
  }

  _moveBelt(rt, dt, now) {
    const items = rt.items;
    const L = rt.length;
    const v = rt.speed;
    // Front item: may hand off to a chained belt.
    while (items.length) {
      const f = items[0];
      const target = f.s + v * dt;
      if (target >= L && rt.next && rt.next.canAccept(dt)) {
        rt.take(now);
        rt.next.accept(target - L);
        continue;
      }
      f.s = Math.min(target, L);
      break;
    }
    for (let i = 1; i < items.length; i++) {
      const it = items[i];
      const limit = items[i - 1].s - ITEM_SPACING;
      if (it.s < limit) it.s = Math.min(it.s + v * dt, limit);
    }
  }

  _updateNode(n, dt, now) {
    const kind = n.def.kind;
    if (n.holes) {
      this._updateHoles(n, dt, now);
    } else if (kind === 'splitter') {
      const inp = n.inputs[0];
      while (n.buf < 2 && inp && inp.front()) {
        inp.take(now);
        n.buf++;
      }
      const outs = n.outputs;
      let moved = true;
      while (n.buf && moved) {
        moved = false;
        for (let k = 0; k < outs.length; k++) {
          const idx = (n.rr + k) % outs.length;
          const o = outs[idx];
          if (o && o.canAccept(dt)) {
            o.accept(0);
            n.buf--;
            n.rr = idx + 1;
            moved = true;
            break;
          }
        }
      }
      n.status = n.buf >= 2 ? 'blocked' : 'running';
    } else if (kind === 'merger' || kind === 'pole') {
      // Take from the inputs in turn, one box at a time (a pole has just one: boxes pass straight through).
      const ins = n.inputs;
      let pulled = true;
      while (n.buf < 2 && pulled) {
        pulled = false;
        for (let k = 0; k < ins.length; k++) {
          const idx = (n.rr + k) % ins.length;
          const inp = ins[idx];
          if (inp && inp.front()) {
            inp.take(now);
            n.buf++;
            n.rr = idx + 1;
            pulled = true;
            break;
          }
        }
      }
      const out = n.outputs[0];
      while (n.buf && out && out.canAccept(dt)) {
        out.accept(0);
        n.buf--;
      }
      n.status = n.buf >= 2 ? 'blocked' : 'running';
    }
  }

  /** Sources, sinks and walls: each hole spawns (out) or swallows (in) items on its own belt. */
  _updateHoles(n, dt, now) {
    let blocked = false;
    let linked = false;
    n.holes.forEach((h, i) => {
      const belt = n.portBelts[i];
      if (belt) linked = true;
      const meter = n.holeMeters[i];
      if (h.dir === 'out') {
        n.holeAcc[i] = Math.min(2, n.holeAcc[i] + (h.rate / 60) * dt);
        while (n.holeAcc[i] >= 1) {
          if (!belt || !belt.canAccept(dt)) {
            if (belt) blocked = true;
            n.holeAcc[i] = Math.min(n.holeAcc[i], 1);
            break;
          }
          belt.accept(0);
          n.holeAcc[i] -= 1;
          n.produced.hit(now);
          meter.hit(now);
        }
      } else {
        const limit = h.rate;
        if (limit > 0) n.holeAcc[i] = Math.min(2, n.holeAcc[i] + (limit / 60) * dt);
        while (belt && belt.front() && (limit <= 0 || n.holeAcc[i] >= 1)) {
          belt.take(now);
          if (limit > 0) n.holeAcc[i] -= 1;
          n.consumed.hit(now);
          meter.hit(now);
        }
      }
    });
    n.status = !linked ? 'unconnected' : blocked ? 'blocked' : 'running';
  }

  // ---------------------------------------------------------------- stats

  beltRate(id) {
    const rt = this.belts.get(id);
    return rt ? rt.meter.rate(this.time, rt.since) : 0;
  }

  nodeStats(id) {
    const n = this.nodes.get(id);
    if (!n) return null;
    return {
      status: n.status,
      produced: n.produced.rate(this.time, n.since),
      consumed: n.consumed.rate(this.time, n.since),
      holes: n.holeMeters.map((m) => m.rate(this.time, n.since)),
    };
  }

  itemCount() {
    let c = 0;
    for (const rt of this.belts.values()) c += rt.items.length;
    return c;
  }
}
