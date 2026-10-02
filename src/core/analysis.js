// Steady-state throughput estimate (boxes/min), independent of the item simulation.
//
// Fixed-point iteration over the factory graph:
//   forward  — offers flow downstream from output holes through splitters and mergers
//   backward — each belt gets a `limit`: how much its destination can actually absorb
//   flow(belt) = min(offer, capacity, limit)
// Repeating both passes propagates backpressure (a splitter hands a blocked output's share to the others;
// a merger whose output is full shares it fairly among its inputs).

import { BUILDINGS, BELT, holesOf } from './catalog.js';

/** Max-min fair allocation of `capacity` among demands. */
export function waterfill(capacity, demands) {
  const n = demands.length;
  const alloc = new Array(n).fill(0);
  let remaining = capacity;
  let active = demands.map((d, i) => i).filter((i) => demands[i] > 0);
  while (active.length && remaining > 1e-12) {
    const share = remaining / active.length;
    const next = [];
    let used = 0;
    for (const i of active) {
      const want = demands[i] - alloc[i];
      if (want <= share + 1e-12) {
        alloc[i] += want;
        used += want;
      } else next.push(i);
    }
    if (next.length === active.length) {
      for (const i of next) alloc[i] += share;
      break;
    }
    remaining -= used;
    active = next;
  }
  return alloc;
}

export function analyze(world, { iterations = 200 } = {}) {
  const belts = [...world.belts.values()];
  const st = new Map(); // beltId → { offer, flow, cap, limit }
  for (const b of belts) st.set(b.id, { offer: 0, flow: 0, cap: BELT.rate, limit: Infinity });

  const nodes = new Map();
  for (const b of world.buildings.values()) {
    const ports = world.buildingPorts(b);
    nodes.set(b.id, {
      b,
      def: BUILDINGS[b.type],
      inputs: ports.filter((p) => p.dir === 'in').map((p) => world.portLinks.get(p.key) ?? null),
      outputs: ports.filter((p) => p.dir === 'out').map((p) => world.portLinks.get(p.key) ?? null),
      ports: ports.map((p) => world.portLinks.get(p.key) ?? null),
      holes: holesOf(b),
      outOffer: [],
    });
  }

  const eff = (id) => (id == null ? 0 : Math.min(st.get(id).cap, st.get(id).limit));
  const flowOf = (id) => (id == null ? 0 : st.get(id).flow);

  function nodeForward(n) {
    if (n.holes) {
      n.outOffer = n.holes.filter((h) => h.dir === 'out').map((h) => h.rate);
    } else if (n.def.kind === 'splitter') {
      n.outOffer = waterfill(flowOf(n.inputs[0]), n.outputs.map((id) => eff(id)));
    } else if (n.def.kind === 'merger' || n.def.kind === 'pole') {
      n.outOffer = [n.inputs.reduce((s, id) => s + flowOf(id), 0)];
    }
  }

  function offerFor(belt) {
    const from = belt.from;
    if (!from) return 0;
    if (from.startsWith('b:')) {
      const up = Number(from.split(':')[1]);
      return st.has(up) ? st.get(up).flow : 0;
    }
    const [, bid, pidx] = from.split(':');
    const n = nodes.get(Number(bid));
    if (!n) return 0;
    const ord = world.buildingPorts(n.b)[Number(pidx)].ordinal;
    return n.outOffer[ord] ?? 0;
  }

  function limitFor(belt) {
    const to = belt.to;
    if (!to) return 0; // open end: the belt fills up and stops
    if (to.startsWith('b:')) {
      const down = Number(to.split(':')[1]);
      return st.has(down) ? eff(down) : 0;
    }
    const [, bid, pidx] = to.split(':');
    const n = nodes.get(Number(bid));
    if (!n) return 0;
    if (n.holes) {
      const rate = n.holes[Number(pidx)]?.rate ?? 0;
      return rate > 0 ? rate : Infinity;
    }
    if (n.def.kind === 'splitter') return n.outputs.reduce((s, id) => s + eff(id), 0);
    if (n.def.kind === 'pole') return eff(n.outputs[0]);
    if (n.def.kind === 'merger') {
      // Fair share of the output among the inputs that have something to offer.
      const ord = world.buildingPorts(n.b)[Number(pidx)].ordinal;
      const outCap = eff(n.outputs[0]);
      const demands = n.inputs.map((id, i) => (i === ord ? outCap : id == null ? 0 : st.get(id).offer));
      return waterfill(outCap, demands)[ord];
    }
    return 0;
  }

  // Forward pass to a fixed point under the current limits. The graph may be deep, so repeat
  // until offers stop changing before any limit is recomputed.
  function forward() {
    for (let pass = 0; pass < belts.length + 8; pass++) {
      let delta = 0;
      for (const n of nodes.values()) nodeForward(n);
      for (const belt of belts) {
        const s = st.get(belt.id);
        const offer = offerFor(belt);
        const flow = Math.min(offer, s.cap, s.limit);
        delta = Math.max(delta, Math.abs(flow - s.flow), Math.abs(offer - s.offer));
        s.offer = offer;
        s.flow = flow;
      }
      if (delta < 1e-9) break;
    }
  }

  const finite = (v) => (v === Infinity ? 1e12 : v);
  let iter = 0;
  for (; iter < iterations; iter++) {
    forward();
    let delta = 0;
    const next = belts.map((belt) => limitFor(belt));
    belts.forEach((belt, i) => {
      const s = st.get(belt.id);
      delta = Math.max(delta, Math.abs(finite(next[i]) - finite(s.limit)));
      s.limit = next[i];
    });
    if (delta < 1e-7) break;
  }
  forward();
  for (const n of nodes.values()) nodeForward(n);

  // ---------------------------------------------------------------- report
  const beltReport = new Map();
  const issues = [];
  for (const belt of belts) {
    const s = st.get(belt.id);
    const r = {
      offer: s.offer,
      flow: s.flow,
      cap: s.cap,
      util: s.cap ? s.flow / s.cap : 0,
      overCapacity: s.offer > s.cap + 1e-6,
      backedUp: s.offer > s.flow + 1e-6 && !(s.offer > s.cap + 1e-6),
      openEnd: !belt.to,
    };
    beltReport.set(belt.id, r);
    if (r.overCapacity) {
      issues.push({ type: 'belt', id: belt.id, level: 'error', text: `輸送帶 #${belt.id} 容量不足：需要 ${fmt(s.offer)} 箱/分，輸送帶只能 ${s.cap} 箱/分` });
    }
    if (r.openEnd) {
      issues.push({ type: 'belt', id: belt.id, level: 'warn', text: `輸送帶 #${belt.id} 末端沒有連接，物流箱會堆積` });
    }
  }

  const nodeReport = new Map();
  let delivered = 0;
  for (const n of nodes.values()) {
    const kind = n.def.kind;
    const rep = { kind };
    if (n.holes) {
      // Per hole: flow through it; outputs also report their nominal rate.
      rep.holes = n.holes.map((h, i) => ({ dir: h.dir, flow: flowOf(n.ports[i]), linked: n.ports[i] != null }));
      rep.output = 0;
      rep.nominal = 0;
      rep.input = 0;
      n.holes.forEach((h, i) => {
        const id = n.ports[i];
        const where = kind === 'wall' ? `${n.def.name} #${n.b.id} 的洞口 ${i + 1}` : `${n.def.name} #${n.b.id}`;
        if (h.dir === 'out') {
          rep.output += flowOf(id);
          rep.nominal += h.rate;
          if (id == null) issues.push({ type: 'building', id: n.b.id, level: 'warn', text: `${where} 沒有接輸送帶` });
          else if (flowOf(id) < h.rate - 1e-6) issues.push({ type: 'building', id: n.b.id, level: 'warn', text: `${where} 只送出 ${fmt(flowOf(id))}/${h.rate} 箱/分（輸送帶容量或下游瓶頸）` });
        } else {
          rep.input += flowOf(id);
        }
      });
      delivered += rep.input;
    } else {
      rep.throughput = n.inputs.reduce((s, id) => s + flowOf(id), 0);
    }
    nodeReport.set(n.b.id, rep);
  }

  return { belts: beltReport, nodes: nodeReport, issues, delivered, iterations: iter };
}

export const fmt = (v) => (Math.abs(v - Math.round(v)) < 0.05 ? String(Math.round(v)) : v.toFixed(1));
