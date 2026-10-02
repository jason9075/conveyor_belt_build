// Factory model: buildings, belts, connectors and the links between them.
//
// Connector keys
//   p:<buildingId>:<portIndex>   building port
//   b:<beltId>:in                belt flow-start (an input connector)
//   b:<beltId>:out               belt flow-end   (an output connector)
// A belt is always stored in flow order: items enter at `start`, leave at `end`.

import {
  BUILDINGS,
  PORT_HEIGHT,
  BELT,
  HOLE_MARGIN,
  HOLE_WIDTH,
  HOLE_HEIGHT,
  HOLE_MIN_Y,
  HOLE_TOP,
  holeY,
  holeSide,
  WALL_MIN_LENGTH,
  WALL_MAX_LENGTH,
  buildingSize,
  portDefs,
  newHole,
  POLE_MIN,
  WALL_THICKNESS,
} from './catalog.js';
import { routeBelt } from './routing.js';
import { validatePath, DEFAULT_RULES } from './validate.js';
import { Path } from './path.js';
import { add, neg, rotY, norm, dot, clamp } from './vec.js';

/**
 * Separating-axis test on two footprint rectangles ({ type, x, z, rot, config }), shrunk 2% so touching
 * is allowed. `trim` shortens both along their local x axis (total, split over both ends).
 */
function footprintsOverlap(p, q, trim = 0) {
  const box = (b) => {
    const [w, d] = buildingSize(b);
    return { c: [b.x, b.z], ax: [rotY([1, 0], b.rot), rotY([0, 1], b.rot)], h: [((w - trim) / 2) * 0.98, (d / 2) * 0.98] };
  };
  const A = box(p);
  const B = box(q);
  const t = [B.c[0] - A.c[0], B.c[1] - A.c[1]];
  const r = (o, axis) => o.h[0] * Math.abs(dot(o.ax[0], axis)) + o.h[1] * Math.abs(dot(o.ax[1], axis));
  return ![...A.ax, ...B.ax].some((axis) => Math.abs(dot(t, axis)) > r(A, axis) + r(B, axis));
}

export class World {
  constructor() {
    this.buildings = new Map();
    this.belts = new Map();
    this.portLinks = new Map(); // building connector key → beltId
    this.nextId = 1;
    this.rules = { ...DEFAULT_RULES };
    this._listeners = new Set();
    this._batch = 0;
    this._dirty = false;
  }

  // ---------------------------------------------------------------- events

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  emit() {
    if (this._batch) {
      this._dirty = true;
      return;
    }
    for (const fn of this._listeners) fn(this);
  }

  batch(fn) {
    this._batch++;
    try {
      return fn();
    } finally {
      this._batch--;
      if (!this._batch && this._dirty) {
        this._dirty = false;
        this.emit();
      }
    }
  }

  // ---------------------------------------------------------------- buildings

  addBuilding({ type, x, z, y = 0, rot = 0, config = {}, id }) {
    const def = BUILDINGS[type];
    if (!def) throw new Error(`unknown building ${type}`);
    const cfg = structuredClone({ ...def.defaults, ...config });
    const b = { id: id ?? this.nextId++, type, x, z, y, rot, config: cfg };
    if (id && id >= this.nextId) this.nextId = id + 1;
    this.buildings.set(b.id, b);
    this.emit();
    return b;
  }

  /** World-space ports of a building. */
  buildingPorts(b) {
    let inIdx = 0;
    let outIdx = 0;
    return portDefs(b).map((p, i) => ({
      key: `p:${b.id}:${i}`,
      pos: add([b.x, b.z], rotY(p.local, b.rot)),
      h: b.y + (p.y ?? PORT_HEIGHT),
      normal: norm(rotY(p.normal, b.rot)),
      dir: p.dir,
      clearance: p.clearance,
      owner: { type: 'building', id: b.id },
      index: i,
      ordinal: p.dir === 'in' ? inIdx++ : outIdx++,
      connected: this.portLinks.has(`p:${b.id}:${i}`),
    }));
  }

  /** Oriented footprint test (with margin) in the horizontal plane. */
  insideFootprint(b, p, margin = 0) {
    const size = buildingSize(b);
    const local = rotY([p[0] - b.x, p[1] - b.z], -b.rot);
    return Math.abs(local[0]) < size[0] / 2 + margin && Math.abs(local[1]) < size[1] / 2 + margin;
  }

  /**
   * Does a building placed as `probe` ({ type, x, y, z, rot, config }) overlap another building?
   * Separating-axis test on the two footprint rectangles (shrunk 2% so touching is allowed),
   * plus their height ranges — a facility on a mezzanine may sit above another.
   */
  buildingOverlaps(probe, ignoreId = null) {
    const py = probe.y ?? 0;
    const ph = buildingSize(probe)[2];
    for (const b of this.buildings.values()) {
      if (b.id === ignoreId) continue;
      if (py >= this.topOf(b) - 0.01 || b.y >= py + ph - 0.01) continue;
      // Walls may share their ends (corners, T-junctions, continuing a run): compare only the part
      // more than half a thickness inside each end point. The slab already sticks out half a
      // thickness past each end, so that is one full thickness off each end of the footprint.
      const walls = probe.type === 'wall' && b.type === 'wall';
      if (footprintsOverlap(probe, b, walls ? 2 * WALL_THICKNESS : 0)) return b;
    }
    return null;
  }

  /** Height of a building's top surface. */
  topOf(b) {
    return b.y + buildingSize(b)[2];
  }

  /** Top of the highest building directly underneath `b` (0 = the floor). Legs only fill the gap below that. */
  supportHeight(b) {
    let h = 0;
    for (const o of this.buildings.values()) {
      if (o.id === b.id) continue;
      const top = this.topOf(o);
      if (top <= b.y + 0.01 && top > h && footprintsOverlap(b, o)) h = top;
    }
    return h;
  }

  removeBuilding(id) {
    const b = this.buildings.get(id);
    if (!b) return;
    this.batch(() => {
      for (const port of this.buildingPorts(b)) this._disconnectPort(port.key);
      this.buildings.delete(id);
      this.emit();
    });
  }

  // ---------------------------------------------------------------- connectors

  beltConnectors(belt) {
    return [
      {
        key: `b:${belt.id}:in`,
        pos: belt.start.pos,
        h: belt.start.h,
        normal: neg(belt.start.dir),
        dir: 'in',
        clearance: 0,
        owner: { type: 'belt', id: belt.id },
        connected: !!belt.from,
      },
      {
        key: `b:${belt.id}:out`,
        pos: belt.end.pos,
        h: belt.end.h,
        normal: belt.end.dir,
        dir: 'out',
        clearance: 0,
        owner: { type: 'belt', id: belt.id },
        connected: !!belt.to,
      },
    ];
  }

  connectors() {
    const out = [];
    for (const b of this.buildings.values()) out.push(...this.buildingPorts(b));
    for (const belt of this.belts.values()) out.push(...this.beltConnectors(belt));
    return out;
  }

  getConnector(key) {
    if (!key) return null;
    const [kind, idStr, sub] = key.split(':');
    const id = Number(idStr);
    if (kind === 'p') {
      const b = this.buildings.get(id);
      return b ? this.buildingPorts(b)[Number(sub)] ?? null : null;
    }
    const belt = this.belts.get(id);
    if (!belt) return null;
    return this.beltConnectors(belt)[sub === 'in' ? 0 : 1];
  }

  // ---------------------------------------------------------------- belts

  /**
   * Plan a belt between two selections (geometric order = order the player clicked).
   * sel = { key } for a connector, or { pos, h, dir|null } for a free point.
   */
  planBelt(startSel, endSel, { mode = 'default', ignoreBelts = [] } = {}) {
    const sc = startSel.key ? this.getConnector(startSel.key) : null;
    const ec = endSel.key ? this.getConnector(endSel.key) : null;
    if (sc && ec && sc.key === ec.key) return { error: '起點與終點是同一個接口' };
    if (sc && ec && sc.dir === ec.dir) {
      return { error: sc.dir === 'out' ? '方向不相容：輸出接到輸出' : '方向不相容：輸入接到輸入' };
    }
    const reversed = sc ? sc.dir === 'in' : ec ? ec.dir === 'out' : false;

    const sSpec = sc
      ? { pos: sc.pos, h: sc.h, dir: sc.normal, clearance: sc.clearance }
      : { pos: startSel.pos, h: startSel.h, dir: startSel.dir ?? null, clearance: 0 };
    const eSpec = ec
      ? { pos: ec.pos, h: ec.h, dir: neg(ec.normal), clearance: ec.clearance }
      : { pos: endSel.pos, h: endSel.h, dir: endSel.dir ?? null, clearance: 0 };

    const route = routeBelt(sSpec, eSpec, { mode, bendRadius: this.rules.bendRadius });
    if (route.error) return { error: route.error, sSpec, eSpec, reversed };

    let path = route.path;
    let from;
    let to;
    let start;
    let end;
    if (!reversed) {
      from = sc?.key ?? null;
      to = ec?.key ?? null;
      start = { pos: sSpec.pos, h: sSpec.h, dir: route.startDir };
      end = { pos: eSpec.pos, h: eSpec.h, dir: route.endDir };
    } else {
      path = path.reversed();
      from = ec?.key ?? null;
      to = sc?.key ?? null;
      start = { pos: eSpec.pos, h: eSpec.h, dir: neg(route.endDir) };
      end = { pos: sSpec.pos, h: sSpec.h, dir: neg(route.startDir) };
    }

    const errors = validatePath(path, this.rules);
    const hit = this.collision(path, {
      skipStart: from ? 1.0 : 0,
      skipEnd: to ? 1.0 : 0,
      ignoreBelts: new Set(ignoreBelts),
    });
    if (hit) errors.push(hit);
    return { path, from, to, start, end, mode, errors, kind: route.kind, reversed, sSpec, eSpec };
  }

  addBelt({ id, mode = 'default', from = null, to = null, start, end, path }) {
    const belt = { id: id ?? this.nextId++, mode, from, to, start, end, path };
    if (id && id >= this.nextId) this.nextId = id + 1;
    belt._cache = null;
    this.belts.set(belt.id, belt);
    this._link(belt);
    this.emit();
    return belt;
  }

  commitPlan(plan) {
    return this.addBelt(plan);
  }

  _link(belt) {
    if (belt.from) {
      if (belt.from.startsWith('p:')) this.portLinks.set(belt.from, belt.id);
      else {
        const up = this.belts.get(Number(belt.from.split(':')[1]));
        if (up) up.to = `b:${belt.id}:in`;
      }
    }
    if (belt.to) {
      if (belt.to.startsWith('p:')) this.portLinks.set(belt.to, belt.id);
      else {
        const down = this.belts.get(Number(belt.to.split(':')[1]));
        if (down) down.from = `b:${belt.id}:out`;
      }
    }
  }

  _unlink(belt) {
    if (belt.from) {
      if (belt.from.startsWith('p:')) this.portLinks.delete(belt.from);
      else {
        const up = this.belts.get(Number(belt.from.split(':')[1]));
        if (up && up.to === `b:${belt.id}:in`) up.to = null;
      }
    }
    if (belt.to) {
      if (belt.to.startsWith('p:')) this.portLinks.delete(belt.to);
      else {
        const down = this.belts.get(Number(belt.to.split(':')[1]));
        if (down && down.from === `b:${belt.id}:out`) down.from = null;
      }
    }
  }

  removeBelt(id) {
    const belt = this.belts.get(id);
    if (!belt) return;
    this._unlink(belt);
    this.belts.delete(id);
    this.emit();
  }

  /** Selection that reproduces a belt endpoint (connector if linked, else its stored free state). */
  _endSel(belt, which) {
    const key = which === 'start' ? belt.from : belt.to;
    if (key) return { key };
    const st = belt[which];
    return { pos: st.pos, h: st.h, dir: st.dir };
  }

  /** Re-route an existing belt from its current endpoints. */
  replanBelt(belt, mode = belt.mode) {
    return this.planBelt(this._endSel(belt, 'start'), this._endSel(belt, 'end'), { mode });
  }

  _applyPlan(belt, plan) {
    belt.path = plan.path;
    belt.start = plan.start;
    belt.end = plan.end;
    belt._cache = null;
  }

  /** Move/rotate a building and re-route the belts attached to it. */
  moveBuilding(id, x, z, rot, y) {
    const b = this.buildings.get(id);
    if (!b) return { error: 'missing building' };
    const old = { x: b.x, y: b.y, z: b.z, rot: b.rot };
    Object.assign(b, { x, z, rot, y: y ?? b.y });
    return this._rerouteAttached(b, () => Object.assign(b, old));
  }

  /** Change a conveyor pole's connector height; its belts re-route. */
  setPoleHeight(id, height) {
    const b = this.buildings.get(id);
    if (!b) return { error: 'missing building' };
    const old = b.config.height;
    b.config.height = clamp(height, POLE_MIN, 30);
    if (this.buildingOverlaps(b, b.id)) {
      b.config.height = old;
      return { error: '這個高度會和上方的設施重疊' };
    }
    return this._rerouteAttached(b, () => (b.config.height = old));
  }

  /** Raise or lower a facility (e.g. onto a mezzanine); its belts re-route to the new port heights. */
  setElevation(id, y) {
    const b = this.buildings.get(id);
    if (!b) return { error: 'missing building' };
    y = clamp(y, 0, 30);
    if (this.buildingOverlaps({ ...b, y }, b.id)) return { error: '這個高度會和其他設施重疊' };
    return this.moveBuilding(id, b.x, b.z, b.rot, y);
  }

  /** After a building changed shape or place: re-route its belts, or call `undo` and report why not. */
  _rerouteAttached(b, undo) {
    const plans = [];
    for (const belt of this.attachedBelts(b)) {
      let plan = this.replanBelt(belt);
      if (plan.error && belt.mode !== 'default') plan = this.replanBelt(belt, 'default');
      const hard = plan.error || plan.errors.filter((e) => !e.startsWith('碰撞')).join('；');
      if (hard) {
        undo();
        return { error: `輸送帶 #${belt.id} 無法重新路由：${hard}` };
      }
      plans.push([belt, plan]);
    }
    for (const [belt, plan] of plans) this._applyPlan(belt, plan);
    this.emit();
    return { ok: true };
  }

  // ---------------------------------------------------------------- walls

  /** Change a wall's length / height; holes that no longer fit are pulled inside. */
  setWallSize(id, { length, height }) {
    const b = this.buildings.get(id);
    if (!b) return { error: 'missing building' };
    const old = structuredClone(b.config);
    if (length != null) {
      b.config.length = clamp(length, WALL_MIN_LENGTH, WALL_MAX_LENGTH);
      const lim = b.config.length / 2 - HOLE_MARGIN;
      for (const h of b.config.holes) h.offset = clamp(h.offset, -Math.max(0, lim), Math.max(0, lim));
      if (!this._holesFit(b.config)) {
        b.config = old;
        return { error: '牆壁太短，放不下目前的洞口' };
      }
    }
    if (height != null) {
      b.config.height = clamp(height, 1.5, 20);
      if (!this._holesFit(b.config)) {
        b.config = old;
        return { error: '牆壁太矮，放不下目前的洞口' };
      }
    }
    if (this.buildingOverlaps(b, b.id)) {
      b.config = old;
      return { error: '牆壁會和其他建築重疊' };
    }
    return this._rerouteAttached(b, () => (b.config = old));
  }

  /** Holes stay inside the wall face and don't overlap each other (they may stack vertically). */
  _holesFit(cfg) {
    const lim = cfg.length / 2 - HOLE_MARGIN + 1e-9;
    const top = cfg.height - HOLE_TOP + 1e-9;
    if (cfg.holes.some((h) => Math.abs(h.offset) > lim || holeY(h) < HOLE_MIN_Y - 1e-9 || holeY(h) > top)) return false;
    return cfg.holes.every((a, i) =>
      cfg.holes.every(
        (c, j) => j <= i || Math.abs(a.offset - c.offset) >= HOLE_WIDTH - 1e-9 || Math.abs(holeY(a) - holeY(c)) >= HOLE_HEIGHT - 1e-9,
      ),
    );
  }

  /** Free hole position at height `y` closest to `near` (null if that row of the wall is full). */
  freeHoleOffset(b, near = 0, y = PORT_HEIGHT) {
    const lim = b.config.length / 2 - HOLE_MARGIN;
    if (lim < 0) return null;
    const step = 0.5;
    const cands = [];
    for (let x = -Math.floor(lim / step) * step; x <= lim + 1e-9; x += step) cands.push(Number(x.toFixed(3)));
    cands.sort((a, c) => Math.abs(a - near) - Math.abs(c - near));
    const clear = (x) => (h) => Math.abs(h.offset - x) >= HOLE_WIDTH - 1e-9 || Math.abs(holeY(h) - y) >= HOLE_HEIGHT - 1e-9;
    return cands.find((x) => b.config.holes.every(clear(x))) ?? null;
  }

  /** Would a hole at (offset, y) fit on wall `b`? */
  canPlaceHole(b, offset, y) {
    return this._holesFit({ ...b.config, holes: [...b.config.holes, { offset, y }] });
  }

  /** Add a hole; without an explicit offset, take the first free spot, row by row from the bottom. */
  addWallHole(id, dir, offset, y, side = 1) {
    const b = this.buildings.get(id);
    if (!b) return { error: 'missing building' };
    let x = offset;
    if (x == null) {
      const rows = [];
      for (let r = y ?? PORT_HEIGHT; r <= b.config.height - HOLE_TOP + 1e-9; r += HOLE_HEIGHT) rows.push(Number(r.toFixed(3)));
      for (const r of rows) {
        x = this.freeHoleOffset(b, 0, r);
        if (x != null) {
          y = r;
          break;
        }
      }
      if (x == null) return { error: '牆壁上已經沒有空間開洞口（加長或加高牆壁）' };
    }
    y ??= PORT_HEIGHT;
    const hole = newHole(dir, x, y, side);
    b.config.holes.push(hole);
    if (!this._holesFit(b.config)) {
      b.config.holes.pop();
      return { error: '這個位置和其他洞口重疊或超出牆壁' };
    }
    this.emit();
    return { ok: true, index: b.config.holes.length - 1 };
  }

  /**
   * Edit hole i of a wall. Moving it re-routes the attached belt; flipping its direction or the
   * face it opens on disconnects that belt.
   */
  updateWallHole(id, i, patch) {
    const b = this.buildings.get(id);
    let hole = b?.config.holes[i];
    if (!hole) return { error: 'missing hole' };
    const old = structuredClone(b.config);
    if (patch.dir && patch.dir !== hole.dir) {
      hole = b.config.holes[i] = newHole(patch.dir, hole.offset, holeY(hole), holeSide(hole));
      this._disconnectPort(`p:${b.id}:${i}`);
    }
    if (patch.side && patch.side !== holeSide(hole)) {
      hole.side = patch.side;
      this._disconnectPort(`p:${b.id}:${i}`);
    }
    for (const k of ['offset', 'y', 'rate']) if (patch[k] != null) hole[k] = patch[k];
    if (!this._holesFit(b.config)) {
      b.config = old;
      return { error: '這個位置和其他洞口重疊或超出牆壁' };
    }
    if (patch.offset != null || patch.y != null) return this._rerouteAttached(b, () => (b.config = old));
    this.emit();
    return { ok: true };
  }

  removeWallHole(id, i) {
    const b = this.buildings.get(id);
    if (!b?.config.holes[i]) return;
    this._disconnectPort(`p:${b.id}:${i}`);
    // Later holes shift down one index; carry their links along.
    for (let j = i + 1; j < b.config.holes.length; j++) {
      const from = `p:${b.id}:${j}`;
      const to = `p:${b.id}:${j - 1}`;
      const beltId = this.portLinks.get(from);
      if (beltId == null) continue;
      const belt = this.belts.get(beltId);
      if (belt?.from === from) belt.from = to;
      if (belt?.to === from) belt.to = to;
      this.portLinks.delete(from);
      this.portLinks.set(to, beltId);
    }
    b.config.holes.splice(i, 1);
    this.emit();
  }

  _disconnectPort(key) {
    const beltId = this.portLinks.get(key);
    if (beltId == null) return;
    const belt = this.belts.get(beltId);
    if (belt?.from === key) belt.from = null;
    if (belt?.to === key) belt.to = null;
    this.portLinks.delete(key);
  }

  attachedBelts(b) {
    const out = [];
    for (const port of this.buildingPorts(b)) {
      const beltId = this.portLinks.get(port.key);
      if (beltId != null && this.belts.has(beltId)) out.push(this.belts.get(beltId));
    }
    return out;
  }

  /**
   * Place a splitter or merger onto a belt at arc length s, splitting it in two.
   */
  splitBeltWith(beltId, type, s) {
    const belt = this.belts.get(beltId);
    if (!belt) return { error: 'missing belt' };
    const half = BUILDINGS[type].size[1] / 2;
    if (s < half + 0.6 || s > belt.path.length - half - 0.6) return { error: '離輸送帶端點太近，無法放置' };
    const smp = belt.path.sample(s);
    const rot = Math.atan2(smp.dir2[0], smp.dir2[1]);
    const def = BUILDINGS[type];
    const inIdx = def.ports.findIndex((p) => p.dir === 'in' && p.local[1] < 0);
    const outIdx = def.ports.findIndex((p) => p.dir === 'out' && p.local[1] > 0);

    const snapshot = { ...belt };
    let result;
    this.batch(() => {
      this._unlink(belt);
      this.belts.delete(belt.id);
      const node = this.addBuilding({ type, x: smp.pos[0], z: smp.pos[2], y: smp.pos[1] - PORT_HEIGHT, rot });
      const p1 = this.planBelt(this._endSel(snapshot, 'start'), { key: `p:${node.id}:${inIdx}` }, { mode: snapshot.mode });
      const p2 = this.planBelt({ key: `p:${node.id}:${outIdx}` }, this._endSel(snapshot, 'end'), { mode: snapshot.mode });
      const bad = [p1, p2].find((p) => p.error || p.errors.some((e) => !e.startsWith('碰撞')));
      if (bad) {
        this.buildings.delete(node.id);
        this.belts.set(snapshot.id, belt);
        this._link(belt);
        result = { error: `分割失敗：${bad.error || bad.errors.join('；')}` };
        return;
      }
      const b1 = this.addBelt(p1);
      const b2 = this.addBelt(p2);
      result = { ok: true, building: node, belts: [b1, b2] };
    });
    return result;
  }

  // ---------------------------------------------------------------- collision

  beltCache(belt) {
    if (!belt._cache) {
      const samples = belt.path.samples(0.5);
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (const s of samples) {
        minX = Math.min(minX, s.pos[0]);
        maxX = Math.max(maxX, s.pos[0]);
        minZ = Math.min(minZ, s.pos[2]);
        maxZ = Math.max(maxZ, s.pos[2]);
      }
      belt._cache = { samples, box: [minX, minZ, maxX, maxZ] };
    }
    return belt._cache;
  }

  /**
   * Clearance check along a path. Samples within `skipStart`/`skipEnd` metres of a snapped end are ignored,
   * which plays the role of GetIgnoredClearanceActors for the connected building/belt.
   * @returns {string|null}
   */
  collision(path, { skipStart = 0, skipEnd = 0, ignoreBelts = new Set() } = {}) {
    const L = path.length;
    const samples = path.samples(0.5).filter((s) => s.s >= skipStart && s.s <= L - skipEnd);
    if (!samples.length) return null;
    for (const b of this.buildings.values()) {
      const def = BUILDINGS[b.type];
      const size = buildingSize(b);
      for (const s of samples) {
        if (s.pos[1] > b.y + size[2] + 0.3 || s.pos[1] < b.y - 0.5) continue;
        if (this.insideFootprint(b, [s.pos[0], s.pos[2]], 0.4)) return `碰撞：穿過${def.name} #${b.id}`;
      }
    }
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const s of samples) {
      minX = Math.min(minX, s.pos[0]);
      maxX = Math.max(maxX, s.pos[0]);
      minZ = Math.min(minZ, s.pos[2]);
      maxZ = Math.max(maxZ, s.pos[2]);
    }
    for (const belt of this.belts.values()) {
      if (ignoreBelts.has(belt.id)) continue;
      const { samples: os, box } = this.beltCache(belt);
      if (box[0] > maxX + 1 || box[2] < minX - 1 || box[1] > maxZ + 1 || box[3] < minZ - 1) continue;
      for (const s of samples) {
        for (const o of os) {
          const dx = s.pos[0] - o.pos[0];
          const dz = s.pos[2] - o.pos[2];
          if (dx * dx + dz * dz < 0.85 * 0.85 && Math.abs(s.pos[1] - o.pos[1]) < 0.9) {
            return `碰撞：與輸送帶 #${belt.id} 重疊`;
          }
        }
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- persistence

  clear() {
    this.buildings.clear();
    this.belts.clear();
    this.portLinks.clear();
    this.nextId = 1;
    this.emit();
  }

  toJSON() {
    return {
      version: 1,
      rules: { bendRadius: this.rules.bendRadius },
      buildings: [...this.buildings.values()],
      belts: [...this.belts.values()].map((b) => ({
        id: b.id,
        mode: b.mode,
        from: b.from,
        to: b.to,
        start: b.start,
        end: b.end,
        path: b.path.toJSON(),
      })),
    };
  }

  load(data) {
    this.batch(() => {
      this.clear();
      if (data.rules?.bendRadius) this.rules.bendRadius = data.rules.bendRadius;
      for (const b of data.buildings || []) this.addBuilding(b);
      for (const b of data.belts || []) this.addBelt({ ...b, path: Path.fromJSON(b.path) });
    });
  }

  beltCapacity() {
    return BELT.rate;
  }
}
