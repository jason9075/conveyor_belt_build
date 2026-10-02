import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { BUILDINGS, ITEM_SPACING, BELT, BELT_SPEED, HOLE_LABEL, buildingSize, shapeKey } from '../core/catalog.js';
import { fmt } from '../core/analysis.js';
import { beltGeometry, buildingObject, createItemMesh, createBeltTexture, legsObject, postObject, BELT_TOP } from './meshes.js';

function label(cls) {
  const el = document.createElement('div');
  el.className = `tag ${cls}`;
  return new CSS2DObject(el);
}

const HEAT = {
  idle: new THREE.Color('#56606b'),
  ok: new THREE.Color('#3ec27a'),
  full: new THREE.Color('#e3c443'),
  backed: new THREE.Color('#f08a3a'),
  over: new THREE.Color('#e5484d'),
};

/** Keeps three.js objects in sync with the World and renders items from the Simulation. */
export class FactoryView {
  constructor(stage, world, sim) {
    this.stage = stage;
    this.world = world;
    this.sim = sim;
    this.root = new THREE.Group();
    stage.scene.add(this.root);
    this.buildingObjs = new Map();
    this.beltObjs = new Map();
    this.texture = createBeltTexture();
    this.items = createItemMesh();
    this.root.add(this.items);
    this.showLabels = true;
    this.heatmap = false;
    this.analysis = null;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._c = new THREE.Color();
    this._fwd = new THREE.Vector3(0, 0, 1);
    this._d = new THREE.Vector3();
    this._one = new THREE.Vector3(1, 1, 1);
  }

  // ---------------------------------------------------------------- sync

  sync() {
    const w = this.world;
    for (const [id, o] of this.buildingObjs) {
      if (!w.buildings.has(id)) {
        this._dispose(o.group);
        this.buildingObjs.delete(id);
      }
    }
    for (const b of w.buildings.values()) {
      let o = this.buildingObjs.get(b.id);
      if (o && o.shape !== shapeKey(b)) {
        this._dispose(o.group);
        o = null;
      }
      if (!o) {
        const group = buildingObject(b);
        group.traverse((c) => {
          c.userData.pick = { kind: 'building', id: b.id };
          if (c.userData.holeIndex != null) c.userData.pick.hole = c.userData.holeIndex;
        });
        const tag = label('building');
        tag.position.y = buildingSize(b)[2] + 1.3;
        group.add(tag);
        this.root.add(group);
        o = { group, shape: shapeKey(b), tag };
        this.buildingObjs.set(b.id, o);
      }
      o.group.position.set(b.x, b.y, b.z);
      o.group.rotation.y = b.rot;
      // Legs under raised facilities, down to whatever they stand on (none when stacked directly).
      const legH = b.y - w.supportHeight(b);
      if (o.legH !== legH) {
        if (o.legs) this._dispose(o.legs);
        o.legs = legH > 0.05 ? legsObject(buildingSize(b), legH) : null;
        if (o.legs) {
          o.legs.traverse((c) => (c.userData.pick = { kind: 'building', id: b.id }));
          o.group.add(o.legs);
        }
        o.legH = legH;
      }
    }

    for (const [id, o] of this.beltObjs) {
      if (!w.belts.has(id)) {
        this._dispose(o.group);
        this.beltObjs.delete(id);
      }
    }
    for (const belt of w.belts.values()) {
      let o = this.beltObjs.get(belt.id);
      if (o && o.path !== belt.path) {
        this._dispose(o.group);
        o = null;
      }
      if (!o) o = this._createBelt(belt);
      // Posts under free (unconnected) ends
      o.posts.forEach((p) => o.group.remove(p));
      o.posts = [];
      for (const [end, linked] of [
        [belt.start, belt.from],
        [belt.end, belt.to],
      ]) {
        if (linked || end.h < 0.4) continue;
        const post = postObject(end.h);
        post.position.x = end.pos[0];
        post.position.z = end.pos[1];
        o.group.add(post);
        o.posts.push(post);
      }
    }
    this.applyColors();
  }

  _createBelt(belt) {
    const group = new THREE.Group();
    const surface = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.8, side: THREE.DoubleSide });
    const frame = new THREE.MeshStandardMaterial({ color: BELT.color, roughness: 0.5, metalness: 0.35, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(beltGeometry(belt.path), [surface, frame]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.pick = { kind: 'belt', id: belt.id };
    group.add(mesh);
    const tag = label('belt');
    const mid = belt.path.sample(belt.path.length / 2);
    tag.position.set(mid.pos[0], mid.pos[1] + 1.1, mid.pos[2]);
    group.add(tag);
    this.root.add(group);
    const o = { group, mesh, surface, frame, tag, path: belt.path, posts: [] };
    this.beltObjs.set(belt.id, o);
    return o;
  }

  _dispose(obj) {
    obj.traverse((c) => {
      if (c.isCSS2DObject) c.element.remove();
      if (c.geometry && !c.geometry.userData.shared) c.geometry.dispose?.();
      const mats = Array.isArray(c.material) ? c.material : c.material ? [c.material] : [];
      for (const m of mats) if (!this.items.material.includes(m)) m.dispose?.();
    });
    obj.removeFromParent();
  }

  // ---------------------------------------------------------------- appearance

  setAnalysis(a) {
    this.analysis = a;
    this.applyColors();
  }

  applyColors() {
    const white = new THREE.Color('#ffffff');
    for (const [id, o] of this.beltObjs) {
      const belt = this.world.belts.get(id);
      if (!belt) continue;
      let c;
      if (!this.heatmap || !this.analysis) {
        c = this._c.set(BELT.color);
      } else {
        const r = this.analysis.belts.get(id);
        c = HEAT.idle;
        if (r) {
          if (r.overCapacity) c = HEAT.over;
          else if (r.backedUp) c = HEAT.backed;
          else if (r.util > 0.999) c = HEAT.full;
          else if (r.flow > 0) c = HEAT.ok;
        }
      }
      o.frame.color.copy(c);
      // Tint the (dark) belt surface so the heat colour reads from above too.
      o.surface.color.copy(white).lerp(c, this.heatmap ? 0.85 : 0.45);
    }
    for (const [id, o] of this.buildingObjs) {
      const b = this.world.buildings.get(id);
      if (b) o.group.userData.bodyMaterial.color.set(BUILDINGS[b.type].color);
    }
  }

  setHighlight(pick, color) {
    for (const o of this.beltObjs.values()) o.frame.emissive.set('#000000');
    for (const o of this.buildingObjs.values()) o.group.userData.bodyMaterial.emissive.set('#000000');
    for (const p of [].concat(pick || [])) {
      if (!p) continue;
      const o = p.kind === 'belt' ? this.beltObjs.get(p.id) : this.buildingObjs.get(p.id);
      if (!o) continue;
      const m = p.kind === 'belt' ? o.frame : o.group.userData.bodyMaterial;
      m.emissive.set(p.color || color);
      m.emissiveIntensity = 0.55;
    }
  }

  pickables() {
    const out = [];
    for (const o of this.beltObjs.values()) out.push(o.mesh);
    for (const o of this.buildingObjs.values()) o.group.traverse((c) => c.isMesh && out.push(c));
    return out;
  }

  // ---------------------------------------------------------------- per frame

  update(dt, running, speedMul) {
    // Scroll the belt texture at belt speed
    if (running) this.texture.offset.y -= ((BELT_SPEED / ITEM_SPACING) * dt * speedMul) % 1;
    this._updateItems();
    this._updateLabels();
  }

  _updateItems() {
    const mesh = this.items;
    let n = 0;
    const max = mesh.instanceMatrix.count;
    for (const [id, rt] of this.sim.belts) {
      const belt = this.world.belts.get(id);
      if (!belt) continue;
      const path = belt.path;
      for (const it of rt.items) {
        if (n >= max) break;
        const smp = path.sample(Math.max(0, it.s));
        this._v.set(smp.pos[0], smp.pos[1] + BELT_TOP + 0.21, smp.pos[2]);
        this._d.set(smp.dir[0], smp.dir[1], smp.dir[2]);
        this._q.setFromUnitVectors(this._fwd, this._d);
        this._m.compose(this._v, this._q, this._one);
        mesh.setMatrixAt(n, this._m);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  _updateLabels() {
    const a = this.analysis;
    const cam = this.stage.camera.position;
    const wp = this._v;
    const visible = (tag, maxDist) => {
      tag.getWorldPosition(wp);
      return this.showLabels && wp.distanceTo(cam) < maxDist;
    };
    for (const [id, o] of this.beltObjs) {
      const el = o.tag.element;
      const show = visible(o.tag, 75);
      o.tag.visible = show; // CSS2DRenderer rewrites style.display every frame; it does honour .visible
      if (!show) continue;
      const cap = BELT.rate;
      const r = a?.belts.get(id);
      const measured = this.sim.beltRate(id);
      const cls = !r ? '' : r.overCapacity ? 'bad' : r.backedUp || r.openEnd ? 'warn' : r.flow > 0 ? 'good' : '';
      el.className = `tag belt ${cls}`;
      el.innerHTML =
        `${r ? fmt(r.flow) : '–'}/${cap}` +
        `<span class="dim"> · 實測 ${fmt(measured)}</span>`;
    }
    for (const [id, o] of this.buildingObjs) {
      const el = o.tag.element;
      const show = visible(o.tag, 160);
      o.tag.visible = show; // CSS2DRenderer rewrites style.display every frame; it does honour .visible
      if (!show) continue;
      const b = this.world.buildings.get(id);
      const def = BUILDINGS[b.type];
      const rep = a?.nodes.get(id);
      let line = '';
      let cls = '';
      if (def.kind === 'source') {
        line = `送出 ${rep ? fmt(rep.output) : '–'}/${b.config.rate} 箱/分`;
        cls = rep && rep.output < rep.nominal - 1e-6 ? 'warn' : 'good';
      } else if (def.kind === 'sink') {
        line = `收到 ${rep ? fmt(rep.input) : '–'}${b.config.rate > 0 ? `/${b.config.rate}` : ''} 箱/分`;
        cls = rep?.input > 0 ? 'good' : '';
      } else if (def.kind === 'wall') {
        const holes = b.config.holes;
        if (!holes.length) line = '沒有洞口';
        else {
          const outs = holes.filter((h) => h.dir === 'out').length;
          line = `${HOLE_LABEL.out} ${outs} · ${HOLE_LABEL.in} ${holes.length - outs} · 送出 ${rep ? fmt(rep.output) : '–'} · 收到 ${rep ? fmt(rep.input) : '–'}`;
        }
        cls = rep && rep.output < rep.nominal - 1e-6 ? 'warn' : rep?.output || rep?.input ? 'good' : '';
      } else {
        line = `${rep ? fmt(rep.throughput) : '–'} 箱/分`;
      }
      el.className = `tag building ${cls}`;
      el.innerHTML = `<b>${def.name}</b> #${id}<br><span>${line}</span>`;
    }
  }
}
