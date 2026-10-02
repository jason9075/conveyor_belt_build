import * as THREE from 'three';
import {
  BUILDINGS,
  BUILDING_ORDER,
  BELT,
  PORT_HEIGHT,
  WALL_MIN_LENGTH,
  WALL_MAX_LENGTH,
  HOLE_MARGIN,
  HOLE_MIN_Y,
  HOLE_TOP,
  HOLE_TOOLS,
  holeY,
  holeSide,
  FLOOR_HEIGHT,
  POLE_MIN,
  POLE_STACK,
  buildingSize,
} from '../core/catalog.js';
import { MODES, MODE_LABEL } from '../core/routing.js';
import { snapToGuidelines, snapToGrid } from '../core/guidelines.js';
import { add, clamp, dot, neg, sub, dist, rotY, DEG } from '../core/vec.js';

const angleToDir = (a) => [Math.sin(a), Math.cos(a)];
const dirToAngle = (d) => Math.atan2(d[0], d[1]);
const BELT_GRID = 0.5;
const BUILD_GRID = 1;
const FLOOR_EYE = 0.15; // lowest camera height above the floor (m)

export const STEP_LABEL = {
  start: '選擇起點',
  end: '拉出輸送帶',
};

/**
 * Input handling for facility placement and belt drawing.
 * Tools: select | belt | build | hole | dismantle. For build, buildType is a building type; for hole, 'out' | 'in'.
 */
export class Controller {
  constructor({ stage, world, view, holo, ui }) {
    this.stage = stage;
    this.world = world;
    this.view = view;
    this.holo = holo;
    this.ui = ui;

    this.tool = 'select';
    this.buildType = null;
    this.wallStart = null; // first click of a wall
    this.mode = 'default';
    this.grid = true;
    this.freeH = PORT_HEIGHT; // belt end height on empty ground
    this.buildY = 0; // base height of walls being placed
    this.placeAt = null; // facility placement step 2: floor point fixed, picking the height
    this.buildRot = 0;
    this.chain = true;
    this.ctrl = false;

    this.step = 'start';
    this.startSel = null;
    this.startRot = null;
    this.endRot = null;
    this.plan = null;
    this.pending = null; // what a click would do right now
    this.hover = null;
    this.selection = null;
    this.drag = null;

    this.mouse = new THREE.Vector2();
    this.mousePx = { x: 0, y: 0 };
    this.raycaster = new THREE.Raycaster();
    this.workPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.keys = new Set();
    this._connectors = null;
    this._down = null;

    this._bind();
  }

  // ---------------------------------------------------------------- wiring

  _bind() {
    const el = this.stage.renderer.domElement;
    el.addEventListener('pointermove', (e) => this._onMove(e));
    el.addEventListener('pointerdown', (e) => this._onDown(e));
    el.addEventListener('pointerup', (e) => this._onUp(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerleave', () => {
      this.inside = false;
    });
    window.addEventListener('keydown', (e) => this._onKey(e, true));
    window.addEventListener('keyup', (e) => this._onKey(e, false));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.ctrl = false;
    });
    // Ctrl+wheel would zoom the page
    window.addEventListener('wheel', (e) => e.ctrlKey && e.preventDefault(), { passive: false });
  }

  onWorldChange() {
    this._connectors = null;
    if (this.selection) {
      const exists =
        this.selection.kind === 'belt' ? this.world.belts.has(this.selection.id) : this.world.buildings.has(this.selection.id);
      if (!exists) this.select(null);
    }
    if (this.startSel?.key && !this.world.getConnector(this.startSel.key)) this.resetBelt();
    this.refresh();
  }

  connectors() {
    this._connectors ??= this.world.connectors();
    return this._connectors;
  }

  // ---------------------------------------------------------------- tools

  setTool(tool, buildType = null) {
    this.tool = tool;
    this.buildType = buildType;
    this.wallStart = null;
    this.placeAt = null;
    this.resetBelt();
    this.drag = null;
    this.holo.clear();
    this.ui.syncToolbar(this);
    this.refresh();
  }

  cycleMode(delta = 1) {
    const i = MODES.indexOf(this.mode);
    this.mode = MODES[(i + delta + MODES.length) % MODES.length];
    this.ui.syncToolbar(this);
    this.ui.toast(`建造模式：${MODE_LABEL[this.mode]}`);
    this.refresh();
  }

  resetBelt() {
    this.step = 'start';
    this.startSel = null;
    this.startRot = null;
    this.endRot = null;
    this.plan = null;
  }

  select(sel) {
    this.selection = sel;
    this.ui.showSelection(sel);
    this._highlight();
  }

  // ---------------------------------------------------------------- input

  _onMove(e) {
    const rect = this.stage.renderer.domElement.getBoundingClientRect();
    this.mousePx = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.mouse.set((this.mousePx.x / rect.width) * 2 - 1, -(this.mousePx.y / rect.height) * 2 + 1);
    this.inside = true;
    this.ctrl = e.ctrlKey;
    if (this._down && this._down.button === 0 && this.tool === 'select' && this._down.pick?.kind === 'building') {
      const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
      if (moved > 5 && !this.drag) {
        const b = this.world.buildings.get(this._down.pick.id);
        const g = b && this.groundPoint(b.y);
        if (g) this.drag = { id: b.id, type: b.type, config: b.config, rot: b.rot, off: [b.x - g[0], b.z - g[1]], y: b.y };
      }
    }
    this.refresh();
  }

  _onDown(e) {
    // Give hotkeys back to the viewport after using a toolbar control.
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    this._down = { x: e.clientX, y: e.clientY, button: e.button, pick: e.button === 0 ? this.pickObject() : null };
  }

  _onUp(e) {
    const d = this._down;
    this._down = null;
    if (!d) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (this.drag && e.button === 0) {
      this._finishDrag();
      return;
    }
    if (moved > 5) return; // orbit / pan drag
    if (e.button === 0) this.click();
    else if (e.button === 2) this.cancel();
  }

  _onKey(e, down) {
    const t = e.target;
    if ((t instanceof HTMLInputElement && t.type !== 'checkbox') || t instanceof HTMLTextAreaElement) return;
    if (t instanceof HTMLSelectElement && !down) return;
    if (t instanceof HTMLSelectElement && ['arrowup', 'arrowdown', 'enter'].includes(e.key.toLowerCase())) return;
    if (e.key === ' ') e.preventDefault(); // don't also "click" a focused button
    const k = e.key.toLowerCase();
    if (k === 'control') {
      this.ctrl = down;
      this.refresh();
      return;
    }
    if (['w', 'a', 's', 'd', 'q', 'e'].includes(k)) {
      if (down) this.keys.add(k);
      else this.keys.delete(k);
      return;
    }
    if (!down) return;
    const digit = Number(e.key);
    if (digit >= 1 && digit <= BUILDING_ORDER.length && !e.ctrlKey) {
      this.setTool('build', BUILDING_ORDER[digit - 1]);
      return;
    }
    const holeTool = HOLE_TOOLS[digit - BUILDING_ORDER.length - 1];
    if (holeTool && !e.ctrlKey) {
      this.setTool('hole', holeTool.dir);
      return;
    }
    switch (k) {
      case 'escape':
        this.cancel(true);
        break;
      case 'v':
        this.setTool('select');
        break;
      case 'c':
        if (!e.ctrlKey) this.setTool('belt');
        break;
      case 'f':
        this.setTool('dismantle');
        break;
      case 'r':
        if (this.tool === 'belt') this.cycleMode(e.shiftKey ? -1 : 1);
        else this.rotate(90 * DEG);
        break;
      case 'z':
        this.rotate(-15 * DEG);
        break;
      case 'x':
        this.rotate(15 * DEG);
        break;
      case 'pageup':
      case ']':
        this.adjustHeight(0.5);
        e.preventDefault();
        break;
      case 'pagedown':
      case '[':
        this.adjustHeight(-0.5);
        e.preventDefault();
        break;
      case 'g':
        this.grid = !this.grid;
        this.ui.syncToolbar(this);
        this.refresh();
        break;
      case 'delete':
      case 'backspace':
        if (this.selection) this.removeSelection();
        break;
      default:
        this.ui.onKey?.(k, e);
    }
  }

  /** [ / ]: height of the facility being placed (build tool) or of free belt ends (belt tool). */
  adjustHeight(dh) {
    if (this.tool === 'build') {
      if (this.buildType !== 'wall') return; // facilities: height comes from the mouse (step 2)
      this.buildY = Math.max(0, Math.min(30, this.buildY + dh));
    }
    else this.freeH = Math.max(0.5, Math.min(30, this.freeH + dh));
    this.ui.syncToolbar(this);
    this.refresh();
  }

  rotate(da) {
    if (this.tool === 'build') {
      this.buildRot = (this.buildRot + da) % (Math.PI * 2);
    } else if (this.drag) {
      this.drag.rot = (this.drag.rot + da) % (Math.PI * 2);
    } else if (this.tool === 'belt') {
      if (this.step === 'start') {
        this.startRot = (this.startRot ?? 0) + da;
      } else {
        const cur = this.endRot ?? (this.plan?.geoEndDir ? dirToAngle(this.plan.geoEndDir) : 0);
        this.endRot = cur + da;
      }
    } else if (this.selection?.kind === 'building') {
      const b = this.world.buildings.get(this.selection.id);
      const res = this.world.moveBuilding(b.id, b.x, b.z, b.rot + da);
      if (res.error) this.ui.toast(res.error, 'error');
    }
    this.refresh();
  }

  cancel(hard = false) {
    if (this.drag) {
      this.drag = null;
    } else if (this.tool === 'belt' && this.step === 'end') {
      this.resetBelt();
    } else if (this.tool === 'build' && this.wallStart) {
      this.wallStart = null;
    } else if (this.tool === 'build' && this.placeAt) {
      this.placeAt = null;
    } else if (this.tool !== 'select') {
      this.setTool('select');
    } else if (hard || this.selection) {
      this.select(null);
    }
    this.holo.clear();
    this.refresh();
  }

  removeSelection() {
    const s = this.selection;
    if (!s) return;
    if (s.kind === 'belt') this.world.removeBelt(s.id);
    else this.world.removeBuilding(s.id);
    this.select(null);
  }

  // ---------------------------------------------------------------- picking

  /** Cursor ray hit on the horizontal plane at height `h` (the ground by default), as [x, z]. */
  groundPoint(h = 0) {
    this.raycaster.setFromCamera(this.mouse, this.stage.camera);
    this.workPlane.constant = -h;
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(this.workPlane, p) ? [p.x, p.z] : null;
  }

  pickObject() {
    this.raycaster.setFromCamera(this.mouse, this.stage.camera);
    const hits = this.raycaster.intersectObjects(this.view.pickables(), false);
    for (const h of hits) {
      const pick = h.object.userData.pick;
      if (!pick) continue;
      // Meshes of just-removed entities linger until the next sync.
      const alive = pick.kind === 'belt' ? this.world.belts.has(pick.id) : this.world.buildings.has(pick.id);
      if (alive) return { ...pick, point: h.point };
    }
    return null;
  }

  /** Nearest open connector to the cursor in screen space. */
  pickConnector(filter, maxPx = 30) {
    const cam = this.stage.camera;
    const rect = this.stage.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best = null;
    let bestD = maxPx;
    for (const c of this.connectors()) {
      if (c.connected || !filter(c)) continue;
      v.set(c.pos[0], c.h, c.pos[1]).project(cam);
      if (v.z > 1) continue;
      const x = ((v.x + 1) / 2) * rect.width;
      const y = ((1 - v.y) / 2) * rect.height;
      const d = Math.hypot(x - this.mousePx.x, y - this.mousePx.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /** Free point under the cursor, with Ctrl guidelines or grid snapping. */
  freePoint(lines) {
    const g = this.groundPoint(this.freeH);
    if (!g) return null;
    if (this.ctrl && lines?.length) {
      const snap = snapToGuidelines(g, lines, 1.5);
      if (snap) return { pos: snap.point, dir: snap.dir, guides: snap.used };
    }
    const pos = this.grid ? snapToGrid(g, BELT_GRID) : g;
    if (this.freeH > PORT_HEIGHT + 0.01) this.holo.showWorkPlane(snapToGrid(g, BUILD_GRID), this.freeH);
    return { pos, dir: null, guides: [] };
  }

  // ---------------------------------------------------------------- refresh

  refresh() {
    if (!this.inside && !this.drag) {
      this.holo.clear();
      this.hover = null;
      this._highlight();
      return;
    }
    this.pending = null;
    this.hover = null;
    this.holo.setGuidelines([]);
    this.holo.hideConnector();
    this.holo.hideWorkPlane();
    this.holo.hideHoleGhost();
    this.holo.showHoleGuides(null);
    this.holo.hideHeightTag();
    switch (this.tool) {
      case 'belt':
        this._refreshBelt();
        break;
      case 'hole':
        this._refreshHole();
        break;
      case 'build':
        this._refreshBuild();
        break;
      case 'dismantle': {
        const p = this.pickObject();
        // Over a hole: mark just that hole, so it's clear the wall itself stays.
        this.hover = p && !this._markHole(p, false) ? { ...p, color: '#ff4d5a' } : null;
        this.ui.setHint(
          p ? `點擊拆除 ${this._name(p)}${p.hole != null ? '（只拆洞口，牆壁保留）' : ''}` : '點擊設施、輸送帶或牆壁洞口以拆除',
          p ? 'warn' : '',
        );
        break;
      }
      default:
        this._refreshSelect();
    }
    this._highlight();
    const place = this.pending?.place;
    let h = this.drag?.y ?? 0;
    if (this.tool === 'belt') h = this.freeH;
    else if (place) h = place.type === 'pole' ? place.config.height : place.y;
    else if (this.tool === 'build' && this.buildType === 'wall') h = this.buildY;
    this.ui.setCoords(this.groundPoint(h), h);
  }

  _name(p) {
    if (p.kind === 'belt') return `輸送帶 #${p.id}`;
    const b = this.world.buildings.get(p.id);
    if (p.hole != null) return `${BUILDINGS[b.type].name} #${p.id} 的洞口 ${p.hole + 1}`;
    return `${BUILDINGS[b.type].name} #${p.id}`;
  }

  _highlight() {
    const picks = [];
    if (this.selection) picks.push({ ...this.selection, color: '#2f7fd8' });
    if (this.hover) picks.push(this.hover);
    this.view.setHighlight(picks, '#4fd1ff');
  }

  _refreshSelect() {
    if (this.drag) {
      const d = this.drag;
      const g = this.groundPoint(d.y);
      if (!g) return;
      const step = this.grid ? BUILD_GRID : 0;
      const [x, z] = snapToGrid([g[0] + d.off[0], g[1] + d.off[1]], step);
      const ok = !this.world.buildingOverlaps({ type: d.type, config: d.config, x, y: d.y, z, rot: d.rot }, d.id);
      this.holo.showGhost(d, x, d.y, z, d.rot, ok);
      this.pending = { x, z, ok };
      this.ui.setHint('放開以移動，連接的輸送帶會自動重新路由（R 旋轉）');
      return;
    }
    const p = this.pickObject();
    this.hover = p && !this._markHole(p, true) ? { ...p, color: '#4fd1ff' } : null;
    this.ui.setHint(p ? `${this._name(p)} · 點擊選取，拖曳移動` : '點擊選取物件；右鍵拖曳旋轉視角，中鍵平移，滾輪縮放');
  }

  /** If pick `p` is a wall hole, outline that hole (blue = select, red = dismantle) and return true. */
  _markHole(p, valid) {
    if (p?.hole == null) return false;
    const b = this.world.buildings.get(p.id);
    const h = b?.config.holes[p.hole];
    if (!h) return false;
    this.holo.showHoleGhost(b, h.offset, holeY(h), holeSide(h), h.dir, valid, true);
    return true;
  }

  // ---------------------------------------------------------------- build tool

  /**
   * Facilities go down in two clicks: the first fixes the floor position, then moving the mouse
   * up / down sets the height and the second click places it. Shortcuts that take one click:
   * hovering a unit it can stack on (lands on top), or a belt (splitter / merger cut into it).
   * Walls have their own two-click flow (start → end).
   */
  _refreshBuild() {
    const type = this.buildType;
    const def = BUILDINGS[type];
    if (def.kind === 'wall') {
      const g = this.groundPoint(this.buildY);
      if (!g) return;
      if (this.buildY > 0) this.holo.showWorkPlane(snapToGrid(g, BUILD_GRID), this.buildY);
      return this._refreshWall(g);
    }
    if (this.placeAt) return this._refreshPlaceHeight();

    const g = this.groundPoint(0);
    if (!g) return;
    // Over a unit it can stack on: sit right on top of it, as the next layer.
    const base = this._stackBase(type);
    if (base) {
      const top = this.world.topOf(base);
      // A stacked pole adds one fixed height step.
      const config = def.kind === 'pole' ? { height: POLE_STACK } : def.defaults;
      const probe = { type, x: base.x, y: top, z: base.z, rot: this.buildRot, config };
      const ok = !this.world.buildingOverlaps(probe);
      this.holo.showGhost(probe, probe.x, top, probe.z, probe.rot, ok);
      this.pending = { place: probe, ok };
      this.ui.setHint(
        ok
          ? `點擊把${def.name}疊在${BUILDINGS[base.type].name} #${base.id} 上（第 ${this._layer(probe)} 層，底部 ${top.toFixed(1)} m）`
          : '上面已經有東西了',
        ok ? 'good' : 'error',
      );
      return;
    }

    if (def.kind === 'splitter' || def.kind === 'merger') {
      const hit = this._beltUnderCursor(g);
      if (hit) {
        const smp = hit.belt.path.sample(hit.s);
        const rot = Math.atan2(smp.dir2[0], smp.dir2[1]);
        this.holo.showGhost({ type }, smp.pos[0], smp.pos[1] - PORT_HEIGHT, smp.pos[2], rot, true);
        this.pending = { split: { beltId: hit.belt.id, s: hit.s } };
        this.ui.setHint(`點擊把${def.name}插入輸送帶 #${hit.belt.id}（會把輸送帶分成兩段）`);
        return;
      }
    }
    const [x, z] = snapToGrid(g, this.grid ? BUILD_GRID : 0);
    const ok = !this.world.buildingOverlaps({ type, x, y: 0, z, rot: this.buildRot, config: def.defaults });
    this.holo.showGhost({ type }, x, 0, z, this.buildRot, true);
    this.pending = { placeAt: { x, z } };
    this.ui.setHint(`第 1 步：點擊決定${def.name}的水平位置，接著上下移動滑鼠設定高度${ok ? '' : '（地面這裡已有設施，要抬高）'}（R 旋轉 90°，Z/X 微調 15°）`);
  }

  /** Step 2: height follows the cursor's vertical movement above the fixed floor point. */
  _refreshPlaceHeight() {
    const type = this.buildType;
    const def = BUILDINGS[type];
    const { x, z } = this.placeAt;
    let h = this._cursorHeight(x, z);
    h = this.grid ? Math.round(h / 0.5) * 0.5 : Math.round(h * 20) / 20;
    h = clamp(h, 0, 30);
    const pole = def.kind === 'pole';
    // A pole stands on the floor and the height is where its connector sits; anything else is lifted whole.
    const probe = pole
      ? { type, x, y: 0, z, rot: this.buildRot, config: { height: Math.max(POLE_MIN, h) } }
      : { type, x, y: h, z, rot: this.buildRot, config: def.defaults };
    if (!pole) {
      // Snap onto the top of anything underneath when close, so stacking is easy.
      for (const o of this.world.buildings.values()) {
        const top = this.world.topOf(o);
        if (Math.abs(h - top) < 0.35 && this.world.supportHeight({ ...probe, y: top }) === top) probe.y = top;
      }
    }
    h = pole ? probe.config.height : probe.y;
    const ok = !this.world.buildingOverlaps(probe);
    this.holo.showGhost(probe, x, probe.y, z, this.buildRot, ok);
    if (!pole) this.holo.showMarker(0, [x, z], h, null, ok);
    if (h > 0) this.holo.showWorkPlane([x, z], h);
    // Read-out just above the preview.
    const top = probe.y + buildingSize(probe)[2];
    this.holo.showHeightTag([x, top + 0.9, z], `${pole ? '接口' : '高度'} ${h.toFixed(1)} m`, ok);
    this.pending = { place: probe, ok };
    this.ui.setHint(
      ok
        ? `第 2 步：往上拉調整${pole ? '輸送帶接口' : ''}高度 · ${h.toFixed(1)} m · 點擊放置${def.name}（右鍵回到第 1 步）`
        : `${h.toFixed(1)} m 這個高度會和其他設施重疊（右鍵回到第 1 步）`,
      ok ? 'good' : 'error',
    );
  }

  /**
   * Height (m) the cursor points at above floor point (x, z): measured along the screen direction
   * in which that vertical line rises, in pixels per metre at that spot.
   */
  _cursorHeight(x, z) {
    const cam = this.stage.camera;
    const rect = this.stage.renderer.domElement.getBoundingClientRect();
    const toPx = (y) => {
      const v = new THREE.Vector3(x, y, z).project(cam);
      return [((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height];
    };
    const p0 = toPx(0);
    const p1 = toPx(1);
    const up = [p1[0] - p0[0], p1[1] - p0[1]];
    const ppm = Math.max(4, Math.hypot(up[0], up[1])); // looking straight down: treat as 4 px per metre
    const u = Math.hypot(up[0], up[1]) > 1e-6 ? [up[0] / Math.hypot(...up), up[1] / Math.hypot(...up)] : [0, -1];
    const d = [this.mousePx.x - p0[0], this.mousePx.y - p0[1]];
    return (d[0] * u[0] + d[1] * u[1]) / ppm;
  }

  /** Building under the cursor that a `type` may be stacked on (see BUILDINGS[type].stackOn). */
  _stackBase(type) {
    const pick = this.pickObject();
    const b = pick && this.world.buildings.get(pick.id);
    if (!b || !BUILDINGS[type].stackOn?.includes(b.type)) return null;
    // Walls: only from the top face — clicks on a wall's side or end start a new wall (corners).
    if (b.type === 'wall' && Math.abs(pick.point.y - this.world.topOf(b)) > 0.05) return null;
    return b;
  }

  /** End points (centreline) of existing walls near `p`, so corners and runs join exactly. */
  _snapWallEnd(p) {
    let best = null;
    let bestD = 0.75;
    for (const b of this.world.buildings.values()) {
      if (b.type !== 'wall') continue;
      for (const sgn of [-1, 1]) {
        const e = add([b.x, b.z], rotY([(sgn * b.config.length) / 2, 0], b.rot));
        const d = dist(e, p);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
    }
    return best;
  }

  /** 1-based layer number of a stacked unit: how many units of the stack are at or below it. */
  _layer(b) {
    let n = 1;
    let cur = b;
    for (let guard = 0; guard < 50; guard++) {
      const below = [...this.world.buildings.values()].find(
        (o) => o !== cur && Math.abs(this.world.topOf(o) - cur.y) < 0.01 && Math.abs(o.x - cur.x) < 0.01 && Math.abs(o.z - cur.z) < 0.01,
      );
      if (!below) break;
      n++;
      cur = below;
    }
    return n;
  }

  /** Walls are drawn like a line: first click = one end, second click = the other end. */
  _refreshWall(g) {
    const step = this.grid ? BUILD_GRID : 0;
    const joined = this._snapWallEnd(g);
    const p = joined ?? snapToGrid(g, step);
    const def = BUILDINGS.wall;
    // Over an existing wall: one click adds a storey on top (same length and direction).
    const base = !this.wallStart && this._stackBase('wall');
    if (base) {
      const top = this.world.topOf(base);
      const config = { ...def.defaults, length: base.config.length, height: FLOOR_HEIGHT };
      const probe = { type: 'wall', x: base.x, y: top, z: base.z, rot: base.rot, config };
      const ok = !this.world.buildingOverlaps(probe);
      this.holo.showGhost(probe, probe.x, top, probe.z, probe.rot, ok);
      this.pending = { place: probe, ok };
      this.ui.setHint(
        ok ? `點擊在牆壁 #${base.id} 上加蓋一層 → 第 ${this._layer(probe)} 層（${FLOOR_HEIGHT} m 高）` : '上面已經有東西了',
        ok ? 'good' : 'error',
      );
      return;
    }
    if (!this.wallStart) {
      const config = { ...def.defaults, length: WALL_MIN_LENGTH };
      this.holo.showGhost({ type: 'wall', config }, p[0], this.buildY, p[1], this.buildRot, true);
      this.pending = { wallStart: p };
      this.ui.setHint(`點擊設定牆壁的起點，再點一次設定終點 · 底部高度 ${this.buildY.toFixed(1)} m（[ ] 調整）· 從既有牆壁的端點開始可以接成轉角 · 點在牆壁頂端可以加蓋一層`);
      return;
    }
    const a = this.wallStart;
    // Local +x runs from the first click toward the cursor; with the grid on, snap to 0.5 m / 15°.
    // (Not when the end lands on another wall's end: that join has to be exact.)
    const snap = (v, q) => (this.grid && !joined ? Math.round(v / q) * q : v);
    const length = Number(Math.min(WALL_MAX_LENGTH, Math.max(WALL_MIN_LENGTH, snap(dist(a, p), 0.5))).toFixed(2));
    const rot = dist(a, p) > 1e-6 ? snap(Math.atan2(-(p[1] - a[1]), p[0] - a[0]), 15 * DEG) : this.buildRot;
    const [x, z] = add(a, rotY([length / 2, 0], rot));
    const config = { ...def.defaults, length };
    const y = this.buildY;
    const ok = !this.world.buildingOverlaps({ type: 'wall', x, y, z, rot, config });
    this.holo.showGhost({ type: 'wall', config }, x, y, z, rot, ok);
    this.pending = { place: { type: 'wall', x, y, z, rot, config }, ok };
    this.ui.setHint(ok ? `牆壁 ${length.toFixed(1)} m · 點擊完成（右鍵取消）` : '與其他設施重疊', ok ? 'good' : 'error');
  }

  // ---------------------------------------------------------------- hole tool

  /** Hover a wall: the hole goes where the cursor hits, on the face it hits. */
  _refreshHole() {
    const dir = this.buildType;
    const tool = HOLE_TOOLS.find((t) => t.dir === dir);
    const pick = this.pickObject();
    const b = pick && this.world.buildings.get(pick.id);
    if (!b || b.type !== 'wall') {
      this.ui.setHint(`把滑鼠移到牆壁上，點擊放置${tool.name}（可以放在任何高度、任一面）`);
      return;
    }
    this.hover = { kind: 'building', id: b.id, color: '#4fd1ff' };
    const local = rotY([pick.point.x - b.x, pick.point.z - b.z], -b.rot);
    const side = local[1] >= 0 ? 1 : -1;
    const q = (v, step) => (this.grid ? Math.round(v / step) * step : Math.round(v * 100) / 100);
    const rawX = local[0];
    const rawY = pick.point.y - b.y - 0.1; // the cursor marks the opening's centre, 0.1 above belt height
    let offset = q(rawX, 0.5);
    let y = q(rawY, 0.1);
    // Ctrl: line up with other holes (columns / rows) and facility connector heights.
    const align = this.ctrl ? this._holeAlign(b, rawX, rawY) : {};
    if (align.x != null) offset = align.x;
    if (align.y != null) y = align.y;
    const lim = Math.max(0, b.config.length / 2 - HOLE_MARGIN);
    offset = Number(clamp(offset, -lim, lim).toFixed(2));
    y = Number(clamp(y, HOLE_MIN_Y, Math.max(HOLE_MIN_Y, b.config.height - HOLE_TOP)).toFixed(2));
    const ok = (pick.hole == null || align.x != null || align.y != null) && this.world.canPlaceHole(b, offset, y);
    this.holo.showHoleGhost(b, offset, y, side, dir, ok);
    this.holo.showHoleGuides(b, side, align.x != null ? offset : null, align.y != null ? y : null);
    this.pending = { hole: { id: b.id, offset, y, side }, ok };
    const aligned = [align.xFrom, align.yFrom].filter(Boolean).join('、');
    this.ui.setHint(
      ok
        ? `點擊在牆壁 #${b.id} 的${side > 0 ? '正面' : '背面'}放置${tool.name} · 位置 ${offset} m · 高度 ${y} m` +
            (this.ctrl ? (aligned ? ` · 對齊：${aligned}` : ' · Ctrl：靠近其他洞口或接口的高度就會對齊') : ' · 按住 Ctrl 對齊其他洞口')
        : '這裡和其他洞口重疊（洞口間距至少 1.2 m）',
      ok ? 'good' : 'error',
    );
  }

  /**
   * Alignment targets for a hole on wall `b` near (x, y) in the wall's own frame.
   * Columns: the wall centre, its other holes, and holes of walls stacked in line with it.
   * Rows: hole heights on every wall, and facility connector heights (so a belt can run level).
   */
  _holeAlign(b, x, y) {
    const SNAP_X = 0.5;
    const SNAP_Y = 0.35;
    const cols = [{ v: 0, from: '牆壁中心' }];
    const rows = [];
    for (const o of this.world.buildings.values()) {
      if (o.type === 'wall') {
        const inLine = Math.abs(o.x - b.x) < 0.01 && Math.abs(o.z - b.z) < 0.01 && Math.abs(o.rot - b.rot) < 1e-6;
        o.config.holes.forEach((h, i) => {
          const name = o.id === b.id ? `洞口 ${i + 1}` : `牆壁 #${o.id} 洞口 ${i + 1}`;
          if (inLine) cols.push({ v: h.offset, from: `${name} 的位置` });
          rows.push({ v: o.y + holeY(h) - b.y, from: `${name} 的高度` });
        });
      } else {
        for (const p of this.world.buildingPorts(o)) rows.push({ v: p.h - b.y, from: `${BUILDINGS[o.type].name} #${o.id} 的接口高度` });
      }
    }
    const nearest = (list, v, max) => {
      let best = null;
      for (const c of list) if (Math.abs(c.v - v) <= max && (!best || Math.abs(c.v - v) < Math.abs(best.v - v))) best = c;
      return best;
    };
    const cx = nearest(cols, x, SNAP_X);
    const cy = nearest(rows, y, SNAP_Y);
    return { x: cx?.v, xFrom: cx?.from, y: cy?.v, yFrom: cy?.from };
  }

  _beltUnderCursor(g) {
    const p = this.pickObject();
    if (p?.kind === 'belt') {
      const belt = this.world.belts.get(p.id);
      const c = belt.path.closest([p.point.x, p.point.y, p.point.z]);
      return { belt, s: c.s };
    }
    let best = null;
    for (const belt of this.world.belts.values()) {
      const c = belt.path.closest([g[0], belt.path.h0, g[1]]);
      const dx = c.pos[0] - g[0];
      const dz = c.pos[2] - g[1];
      const d = Math.hypot(dx, dz);
      if (d < 1.2 && (!best || d < best.d)) best = { belt, s: c.s, d };
    }
    return best;
  }

  // ---------------------------------------------------------------- belt tool

  _startConnector() {
    return this.startSel?.key ? this.world.getConnector(this.startSel.key) : null;
  }

  _startHeading() {
    const sc = this._startConnector();
    if (sc) return sc.normal;
    if (this.startSel?.dir) return this.startSel.dir;
    return null;
  }

  _refreshBelt() {
    this.ui.setStep(STEP_LABEL[this.step]);
    if (this.step === 'start') return this._refreshBeltStart();
    return this._refreshBeltEnd();
  }

  _refreshBeltStart() {
    this.holo.hideBelt();
    this.holo.hideMarker(1);
    const c = this.pickConnector(() => true);
    if (c) {
      this.holo.hideMarker(0);
      this.holo.showConnector(c);
      this.pending = { startKey: c.key };
      const what = c.owner.type === 'belt' ? `輸送帶 #${c.owner.id} 的${c.dir === 'out' ? '末端' : '起點'}` : `${BUILDINGS[this.world.buildings.get(c.owner.id).type].name}的${c.dir === 'out' ? '輸出口' : '輸入口'}`;
      this.ui.setHint(`已吸附：${what} · 點擊設定起點${c.dir === 'in' ? '（反向拉線，箱子流向起點）' : ''}`, 'good');
      return;
    }
    const lines = this.connectors()
      .filter((c) => !c.connected)
      .map((c) => ({ origin: c.pos, dir: c.normal, h: c.h }));
    const fp = this.freePoint(lines);
    if (!fp) return;
    const dir = this.startRot != null ? angleToDir(this.startRot) : null;
    this.holo.showMarker(0, fp.pos, this.freeH, dir);
    this.holo.setGuidelines(fp.guides.map((l) => ({ ...l, h: this.freeH })));
    this.pending = { startFree: { pos: fp.pos, h: this.freeH, dir } };
    this.ui.setHint(
      `點擊在空地設定起點（高度 ${this.freeH.toFixed(1)} m，[ ] 調整；Z/X 設定方向${dir ? '' : '，目前自動'}；按住 Ctrl 對齊引導線）`,
    );
  }

  _refreshBeltEnd() {
    const sc = this._startConnector();
    const need = sc ? (sc.dir === 'out' ? 'in' : 'out') : null;
    const startOwner = sc?.owner;
    const c = this.pickConnector(
      (x) =>
        x.key !== this.startSel.key &&
        (!need || x.dir === need) &&
        !(startOwner && x.owner.type === startOwner.type && x.owner.id === startOwner.id && x.owner.type === 'belt'),
    );

    const startPos = sc ? sc.pos : this.startSel.pos;
    const startH = sc ? sc.h : this.startSel.h;
    let endSel;
    let guides = [];
    if (c) {
      endSel = { key: c.key };
      this.holo.showConnector(c);
    } else {
      const lines = [];
      const heading = this._startHeading();
      if (heading) lines.push({ origin: startPos, dir: heading, h: startH });
      for (const a of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (!heading || Math.abs(dot(a, heading)) < 0.999) lines.push({ origin: startPos, dir: a, h: startH });
      }
      for (const o of this.connectors()) {
        if (o.connected || o.key === this.startSel.key || (need && o.dir !== need)) continue;
        lines.push({ origin: o.pos, dir: o.normal, h: o.h });
      }
      const fp = this.freePoint(lines);
      if (!fp) return;
      let dir = this.endRot != null ? angleToDir(this.endRot) : null;
      if (!dir && fp.dir) {
        dir = fp.dir;
        if (dot(dir, sub(fp.pos, startPos)) < 0) dir = neg(dir);
      }
      endSel = { pos: fp.pos, h: this.freeH, dir };
      guides = fp.guides;
    }
    this.holo.setGuidelines(guides.map((l) => ({ ...l, h: l.h ?? this.freeH })));

    const plan = this.world.planBelt(this.startSel, endSel, { mode: this.mode });
    this.plan = plan;
    if (plan.error) {
      this.holo.hideBelt();
      if (!c) this.holo.showMarker(1, endSel.pos, endSel.h, endSel.dir, false);
      this.ui.setHint(`✕ ${plan.error}`, 'error');
      this.pending = null;
      return;
    }
    const valid = plan.errors.length === 0;
    // Geometric (click-order) headings, regardless of the item flow direction.
    plan.geoStartDir = plan.reversed ? neg(plan.path.endDir) : plan.path.startDir;
    plan.geoEndDir = plan.reversed ? neg(plan.path.startDir) : plan.path.endDir;
    this.holo.showBelt(plan.path, valid);
    if (this.startSel.key) this.holo.hideMarker(0);
    else this.holo.showMarker(0, this.startSel.pos, this.startSel.h, plan.geoStartDir, valid);
    if (c) this.holo.hideMarker(1);
    else this.holo.showMarker(1, endSel.pos, endSel.h, plan.geoEndDir, valid);

    this.pending = { plan, endConnector: c };
    const info = `${plan.path.length.toFixed(1)} m · ${MODE_LABEL[this.mode]}（${plan.kind}）· ${BELT.rate}/min${plan.reversed ? ' · 反向' : ''}`;
    if (valid) this.ui.setHint(`${info} · 點擊建造${c ? '' : '（終點自動放置支撐點）'}`, 'good');
    else this.ui.setHint(`✕ ${plan.errors.join('；')} · ${info}`, 'error');
  }

  // ---------------------------------------------------------------- click

  click() {
    const p = this.pending;
    switch (this.tool) {
      case 'belt':
        return this._clickBelt(p);
      case 'hole': {
        if (!p?.hole) return;
        if (!p.ok) return this.ui.toast('這裡放不下洞口', 'error');
        const { id, offset, y, side } = p.hole;
        const res = this.world.addWallHole(id, this.buildType, offset, y, side);
        if (res.error) this.ui.toast(res.error, 'error');
        return;
      }
      case 'build':
        if (!p) return;
        if (p.wallStart) {
          this.wallStart = p.wallStart;
          this.refresh();
        } else if (p.placeAt) {
          this.placeAt = p.placeAt;
          this.refresh();
        } else if (p.split) {
          const res = this.world.splitBeltWith(p.split.beltId, this.buildType, p.split.s);
          if (res.error) this.ui.toast(res.error, 'error');
        } else if (p.place && p.ok) {
          this.world.addBuilding(p.place);
          this.wallStart = null;
          this.placeAt = null;
        } else {
          this.ui.toast('無法放置：與其他設施重疊', 'error');
        }
        return;
      case 'dismantle': {
        const pick = this.pickObject();
        if (!pick) return;
        if (pick.kind === 'belt') this.world.removeBelt(pick.id);
        else if (pick.hole != null) this.world.removeWallHole(pick.id, pick.hole);
        else this.world.removeBuilding(pick.id);
        return;
      }
      default: {
        const pick = this.pickObject();
        this.select(pick ? { kind: pick.kind, id: pick.id, hole: pick.hole } : null);
      }
    }
  }

  _clickBelt(p) {
    if (this.step === 'start') {
      if (!p) return;
      this.startSel = p.startKey ? { key: p.startKey } : p.startFree;
      this.step = 'end';
      this.endRot = null;
      this.refresh();
      return;
    }
    if (!p?.plan) {
      if (this.plan?.error) this.ui.toast(this.plan.error, 'error');
      return;
    }
    const plan = p.plan;
    if (plan.errors.length) {
      this.ui.toast(plan.errors.join('；'), 'error');
      return;
    }
    const belt = this.world.commitPlan(plan);
    if (this.chain && !p.endConnector) {
      // Continue from the free end just placed (it becomes the next start).
      this.startSel = { key: plan.reversed ? `b:${belt.id}:in` : `b:${belt.id}:out` };
      this.step = 'end';
    } else {
      this.resetBelt();
    }
    this.startRot = null;
    this.endRot = null;
    this.refresh();
  }

  _finishDrag() {
    const d = this.drag;
    this.drag = null;
    this.holo.hideGhost();
    const p = this.pending;
    if (!p || !p.ok) {
      this.ui.toast('無法移動：與其他設施重疊', 'error');
      this.refresh();
      return;
    }
    const res = this.world.moveBuilding(d.id, p.x, p.z, d.rot);
    if (res.error) this.ui.toast(res.error, 'error');
    this.select({ kind: 'building', id: d.id });
    this.refresh();
  }

  // ---------------------------------------------------------------- per frame

  tick(dt) {
    if (!this.keys.size) return;
    const cam = this.stage.camera;
    const ctl = this.stage.controls;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3();
    if (this.keys.has('w')) move.add(fwd);
    if (this.keys.has('s')) move.sub(fwd);
    if (this.keys.has('d')) move.add(right);
    if (this.keys.has('a')) move.sub(right);
    // Q / E: raise / lower the view (camera and look-at point together), e.g. to an upper level.
    if (this.keys.has('q')) move.y += 1;
    if (this.keys.has('e')) move.y -= 1;
    if (!move.lengthSq()) return;
    const speed = Math.max(8, cam.position.distanceTo(ctl.target) * 0.9);
    move.normalize().multiplyScalar(speed * dt);
    // Going down: the look-at point stops at the floor, then the camera alone keeps sinking
    // (the view levels out) until it is just above the floor.
    const camDy = Math.max(move.y, FLOOR_EYE - cam.position.y);
    const targetDy = Math.max(move.y, -ctl.target.y);
    cam.position.add(new THREE.Vector3(move.x, Math.min(0, camDy) + Math.max(0, move.y), move.z));
    ctl.target.add(new THREE.Vector3(move.x, move.y > 0 ? move.y : targetDy, move.z));
    this.refresh();
  }

  /** Frame every building and belt in view (on load, demo and import). */
  fitView() {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    const grow = (x, z, r = 0) => {
      minX = Math.min(minX, x - r);
      maxX = Math.max(maxX, x + r);
      minZ = Math.min(minZ, z - r);
      maxZ = Math.max(maxZ, z + r);
    };
    for (const b of this.world.buildings.values()) grow(b.x, b.z, Math.max(...buildingSize(b).slice(0, 2)) / 2);
    for (const belt of this.world.belts.values()) for (const p of [belt.start.pos, belt.end.pos]) grow(p[0], p[1]);
    if (!Number.isFinite(minX)) {
      minX = minZ = -20;
      maxX = maxZ = 20;
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const extent = Math.max(maxX - minX, maxZ - minZ, 16);
    const cam = this.stage.camera;
    const dist = (extent * 0.5) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const dir = new THREE.Vector3(0.35, 0.95, 0.75).normalize();
    this.stage.controls.target.set(cx, 0, cz);
    cam.position.set(cx, 0, cz).addScaledVector(dir, dist);
  }

  focus(x, z) {
    const ctl = this.stage.controls;
    const off = this.stage.camera.position.clone().sub(ctl.target);
    ctl.target.set(x, 0, z);
    this.stage.camera.position.copy(ctl.target).add(off);
  }
}
