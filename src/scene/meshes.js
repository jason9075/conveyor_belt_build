import * as THREE from 'three';
import { BUILDINGS, ITEM_SPACING, PORT_HEIGHT, HOLE_WIDTH, buildingSize, portDefs } from '../core/catalog.js';

export const BELT_TOP = 0.12; // belt surface above the path height
const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ belt texture

function chevronCanvas() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#6b737c';
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#b9c1c9';
  g.lineWidth = 7;
  g.lineCap = 'round';
  g.beginPath();
  // Chevron pointing toward +v (canvas top = v = 1 after flipY)
  g.moveTo(10, 46);
  g.lineTo(32, 22);
  g.lineTo(54, 46);
  g.stroke();
  return c;
}

let _chevron = null;
/** Shared scrolling chevron texture for every belt. */
export function createBeltTexture() {
  _chevron ??= chevronCanvas();
  const t = new THREE.CanvasTexture(_chevron);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

// ------------------------------------------------------------------ belt geometry

// Frame cross-section (x = right, y = up) relative to the path point, swept along the path.
const FRAME = [
  [-0.6, 0.0],
  [0.6, 0.0],
  [0.6, 0.28],
  [0.46, 0.28],
  [0.46, BELT_TOP],
  [-0.46, BELT_TOP],
  [-0.46, 0.28],
  [-0.6, 0.28],
];

function frames(path, spacing = 0.25) {
  return path.samples(spacing).map((s) => {
    const p = new THREE.Vector3(...s.pos);
    const t = new THREE.Vector3(...s.dir);
    const r = new THREE.Vector3().crossVectors(t, UP).normalize();
    const u = new THREE.Vector3().crossVectors(r, t).normalize();
    return { p, t, r, u, s: s.s };
  });
}

/**
 * Belt geometry with two groups: 0 = textured surface, 1 = metal frame.
 * Surface UV: u across, v = arc length / ITEM_SPACING (one chevron per item slot).
 */
export function beltGeometry(path) {
  const F = frames(path);
  const pos = [];
  const nor = [];
  const uv = [];
  const idx = [];
  const tmp = new THREE.Vector3();
  const at = (f, x, y) => tmp.copy(f.p).addScaledVector(f.r, x).addScaledVector(f.u, y).toArray();

  // Surface
  const sw = 0.46;
  for (const f of F) {
    pos.push(...at(f, -sw, BELT_TOP + 0.002), ...at(f, sw, BELT_TOP + 0.002));
    nor.push(...f.u.toArray(), ...f.u.toArray());
    const v = f.s / ITEM_SPACING;
    uv.push(0, v, 1, v);
  }
  for (let i = 0; i < F.length - 1; i++) {
    const a = i * 2;
    // Counter-clockwise seen from above → front face (and normal) points up.
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const surfaceCount = idx.length;

  // Frame: one flat-shaded strip per profile edge
  for (let e = 0; e < FRAME.length; e++) {
    const [x0, y0] = FRAME[e];
    const [x1, y1] = FRAME[(e + 1) % FRAME.length];
    if (y0 === BELT_TOP && y1 === BELT_TOP) continue; // covered by the surface
    const ex = x1 - x0;
    const ey = y1 - y0;
    // Outward normal of an edge of the counter-clockwise (x,y) profile
    const nx = ey;
    const ny = -ex;
    const nl = Math.hypot(nx, ny) || 1;
    const base = pos.length / 3;
    for (const f of F) {
      const n = new THREE.Vector3().addScaledVector(f.r, nx / nl).addScaledVector(f.u, ny / nl);
      pos.push(...at(f, x0, y0), ...at(f, x1, y1));
      nor.push(...n.toArray(), ...n.toArray());
      uv.push(0, 0, 0, 0);
    }
    for (let i = 0; i < F.length - 1; i++) {
      const a = base + i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.addGroup(0, surfaceCount, 0);
  g.addGroup(surfaceCount, idx.length - surfaceCount, 1);
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ buildings

const portGeo = new THREE.ConeGeometry(0.28, 0.6, 12);
portGeo.rotateX(Math.PI / 2); // point along +z
const frameGeo = new THREE.BoxGeometry(1.2, 1.0, 0.12);
export const PORT_COLORS = { in: '#3ec27a', out: '#f39c32' };

/** The opening through a wall of thickness `d`. */
export const holeGeometry = (d) => new THREE.BoxGeometry(HOLE_WIDTH - 0.1, 1.1, d + 0.04);

/** Building group in local space; caller sets position/rotation. `b` = { type, config }. */
export function buildingObject(b) {
  const def = BUILDINGS[b.type];
  const [w, d, h] = buildingSize(b);
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.7, metalness: 0.15 });
  const pole = def.kind === 'pole';
  const body = new THREE.Mesh(pole ? new THREE.BoxGeometry(0.28, h, 0.28) : new THREE.BoxGeometry(w, h, d), mat);
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  body.name = 'body';
  group.add(body);
  if (pole) {
    // Bracket the belt rests on, plus a foot plate.
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.9), mat);
    bracket.position.y = h - 0.06;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.7), mat);
    foot.position.y = 0.03;
    bracket.castShadow = true;
    group.add(bracket, foot);
  }

  if (def.kind === 'source' || def.kind === 'sink') {
    const hole = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 1.1, 0.05),
      new THREE.MeshBasicMaterial({ color: '#08090b' }),
    );
    hole.position.set(0, PORT_HEIGHT + 0.1, d / 2 + 0.01);
    // Hazard-striped header over the opening, like a dock door.
    const header = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 0.06), hazardMaterial());
    header.position.set(0, PORT_HEIGHT + 0.8, d / 2 + 0.02);
    group.add(hole, header);
  }
  if (def.kind === 'wall') {
    // Openings go all the way through the slab.
    const holeMat = new THREE.MeshBasicMaterial({ color: '#08090b' });
    portDefs(b).forEach((p, i) => {
      const hole = new THREE.Mesh(holeGeometry(d), holeMat);
      hole.position.set(p.local[0], p.y + 0.1, 0);
      hole.userData.holeIndex = i;
      group.add(hole);
    });
    // Yellow-black kick strip along the base, both faces.
    const strip = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d + 0.04), hazardMaterial(w));
    strip.position.y = 0.15;
    group.add(strip);
  }

  portDefs(b).forEach((p, i) => {
    const color = PORT_COLORS[p.dir];
    const pm = new THREE.Group();
    pm.position.set(p.local[0], p.y ?? PORT_HEIGHT, p.local[1]);
    pm.rotation.y = Math.atan2(p.normal[0], p.normal[1]);
    const ring = new THREE.Mesh(frameGeo, new THREE.MeshStandardMaterial({ color: '#15181c', roughness: 0.5 }));
    ring.position.z = 0.02;
    const cone = new THREE.Mesh(portGeo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35 }));
    cone.position.z = 0.45;
    if (p.dir === 'in') cone.rotation.y = Math.PI; // arrow points into the building
    cone.userData.portDir = p.dir; // previews keep the arrow in its port colour
    pm.add(ring, cone);
    pm.userData.portIndex = i;
    if (def.kind === 'wall') for (const m of [ring, cone]) m.userData.holeIndex = i;
    group.add(pm);
  });
  group.userData.bodyMaterial = mat;
  return group;
}

let _hazard = null;
/** Diagonal yellow/black safety stripes; `len` metres of strip → repeat count. */
function hazardMaterial(len = 1.5) {
  if (!_hazard) {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 16;
    const g = c.getContext('2d');
    g.fillStyle = '#e8b52c';
    g.fillRect(0, 0, 64, 16);
    g.fillStyle = '#1d1f22';
    for (let x = -16; x < 64; x += 16) {
      g.beginPath();
      g.moveTo(x, 16);
      g.lineTo(x + 8, 16);
      g.lineTo(x + 16, 0);
      g.lineTo(x + 8, 0);
      g.fill();
    }
    _hazard = c;
  }
  const t = new THREE.CanvasTexture(_hazard);
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(Math.max(1, Math.round(len / 1.2)), 1);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.7 });
}

// ------------------------------------------------------------------ items

/** Cardboard carton with a strip of tape over the top. */
function cartonMaterials() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#c49a62';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#b48a54';
  g.fillRect(0, 0, 64, 3);
  g.fillRect(0, 61, 64, 3);
  const side = new THREE.CanvasTexture(c);
  side.colorSpace = THREE.SRGBColorSpace;
  const c2 = document.createElement('canvas');
  c2.width = 64;
  c2.height = 64;
  const g2 = c2.getContext('2d');
  g2.drawImage(c, 0, 0);
  g2.fillStyle = '#e2cfa4';
  g2.fillRect(26, 0, 12, 64);
  const top = new THREE.CanvasTexture(c2);
  top.colorSpace = THREE.SRGBColorSpace;
  const m = (map) => new THREE.MeshStandardMaterial({ map, roughness: 0.85 });
  const s = m(side);
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  return [s, s, m(top), s, s, s];
}

export function createItemMesh(max = 40000) {
  const geo = new THREE.BoxGeometry(0.6, 0.42, 0.7);
  const mesh = new THREE.InstancedMesh(geo, cartonMaterials(), max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

/** Steel legs from the ground up to a raised facility's base (visual only). Local to the facility. */
export function legsObject(size, y) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#5b636c', roughness: 0.6, metalness: 0.5 });
  const geo = new THREE.BoxGeometry(0.16, y, 0.16);
  const [w, d] = size;
  const xs = w > 6 ? [-w / 2 + 0.2, 0, w / 2 - 0.2] : [-w / 2 + 0.2, w / 2 - 0.2];
  for (const x of xs) {
    for (const z of [-d / 2 + 0.12, d / 2 - 0.12]) {
      const leg = new THREE.Mesh(geo, mat);
      leg.position.set(x, -y / 2, z);
      leg.castShadow = true;
      g.add(leg);
    }
  }
  return g;
}

/** Thin post under a free belt endpoint (visual only). */
export function postObject(h) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.12, h, 8),
    new THREE.MeshStandardMaterial({ color: '#5b636c', roughness: 0.6, metalness: 0.5 }),
  );
  m.position.y = h / 2;
  m.castShadow = true;
  return m;
}
