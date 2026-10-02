import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { beltGeometry, buildingObject, holeGeometry, PORT_COLORS } from './meshes.js';
import { BUILDINGS, WALL_THICKNESS, shapeKey } from '../core/catalog.js';
import { add, rotY } from '../core/vec.js';

const VALID = new THREE.Color('#4fd1ff');
const INVALID = new THREE.Color('#ff4d5a');

/** Port arrows in previews: their in / out colour, nearly opaque and drawn over the ghost body. */
function arrowMaterial(dir) {
  return new THREE.MeshBasicMaterial({ color: PORT_COLORS[dir], transparent: true, opacity: 0.95, depthTest: false });
}

function holoMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Preview objects: belt hologram, endpoint markers, guidelines, building ghost. */
export class Hologram {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.renderOrder = 10;
    scene.add(this.group);

    this.beltMat = holoMaterial(VALID);
    this.belt = new THREE.Mesh(new THREE.BufferGeometry(), [this.beltMat, this.beltMat]);
    this.belt.visible = false;
    this.group.add(this.belt);

    // Endpoint marker: post + heading arrow
    this.markers = [0, 1].map(() => {
      const g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1, 8), holoMaterial(VALID));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.06, 8, 32), holoMaterial(VALID));
      ring.rotation.x = Math.PI / 2;
      const arrowGeo = new THREE.ConeGeometry(0.25, 0.7, 12);
      arrowGeo.rotateX(Math.PI / 2);
      const arrow = new THREE.Mesh(arrowGeo, holoMaterial(VALID));
      arrow.position.z = 1.1;
      const head = new THREE.Group();
      head.add(ring, arrow);
      g.add(post, head);
      g.userData = { post, head, arrow, ring };
      g.visible = false;
      this.group.add(g);
      return g;
    });

    this.connectorRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.85, 0.08, 8, 40),
      new THREE.MeshBasicMaterial({ color: '#ffe066', transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.connectorRing.visible = false;
    this.connectorRing.renderOrder = 20;
    this.group.add(this.connectorRing);

    this.guides = new THREE.Group();
    this.group.add(this.guides);
    this.holeGuides = new THREE.Group();
    this.group.add(this.holeGuides);
    this.guideMat = new THREE.LineDashedMaterial({ color: '#ffe066', dashSize: 0.6, gapSize: 0.35, transparent: true, opacity: 0.9 });

    this.ghost = null;
    this.ghostType = null;

    // Working plane: a small grid at the height being built on, so elevated placement reads in 3D.
    this.workPlane = new THREE.GridHelper(16, 16, '#4fd1ff', '#4fd1ff');
    this.workPlane.material.transparent = true;
    this.workPlane.material.opacity = 0.35;
    this.workPlane.material.depthWrite = false;
    this.workPlane.visible = false;
    this.group.add(this.workPlane);

    // Hole ghost: the opening plus an arrow for the box flow direction.
    this.holeGhost = new THREE.Group();
    const holeMat = holoMaterial(VALID);
    const box = new THREE.Mesh(holeGeometry(WALL_THICKNESS), holeMat);
    box.position.y = 0.1;
    const coneGeo = new THREE.ConeGeometry(0.3, 0.7, 12);
    coneGeo.rotateX(Math.PI / 2);
    const cone = new THREE.Mesh(coneGeo, arrowMaterial('out'));
    cone.renderOrder = 22;
    this.holeGhost.add(box, cone);
    this.holeGhost.userData = { mat: holeMat, cone };
    this.holeGhost.visible = false;
    this.group.add(this.holeGhost);

    // Live height read-out while pulling a facility up.
    const el = document.createElement('div');
    el.className = 'tag height-tag';
    this.heightTag = new CSS2DObject(el);
    this.heightTag.visible = false;
    this.group.add(this.heightTag);
  }

  /** Floating label at world point [x, y, z]. */
  showHeightTag(pos, text, valid = true) {
    this.heightTag.position.set(...pos);
    this.heightTag.element.textContent = text;
    this.heightTag.element.classList.toggle('bad', !valid);
    this.heightTag.visible = true;
  }

  hideHeightTag() {
    this.heightTag.visible = false;
  }

  /**
   * Preview a hole on wall `b` at (offset, y) on face `side`; dir 'out' points away from the wall.
   * `mark`: outline an existing hole instead (drawn a little larger so it shows around the opening).
   */
  showHoleGhost(b, offset, y, side, dir, valid, mark = false) {
    const g = this.holeGhost;
    g.scale.setScalar(mark ? 1.15 : 1);
    const [x, z] = add([b.x, b.z], rotY([offset, 0], b.rot));
    g.position.set(x, b.y + y, z);
    g.rotation.y = b.rot + (side < 0 ? Math.PI : 0);
    const { cone, mat } = g.userData;
    cone.position.z = WALL_THICKNESS / 2 + 0.6;
    cone.rotation.y = dir === 'in' ? Math.PI : 0;
    cone.material.color.set(PORT_COLORS[dir]);
    mat.color.copy(valid ? VALID : INVALID);
    g.visible = true;
  }

  hideHoleGhost() {
    this.holeGhost.visible = false;
  }

  /**
   * Ctrl-alignment guides on a wall face: a vertical line at `offset` and/or a horizontal line at
   * hole height `y` (both in the wall's frame; null = none). Call with b = null to clear.
   */
  showHoleGuides(b, side, offset, y) {
    for (const c of [...this.holeGuides.children]) {
      c.geometry.dispose();
      this.holeGuides.remove(c);
    }
    if (!b) return;
    const face = side * (WALL_THICKNESS / 2 + 0.03);
    const L = b.config.length / 2 + WALL_THICKNESS / 2;
    const at = (lx, ly) => {
      const [x, z] = add([b.x, b.z], rotY([lx, face], b.rot));
      return new THREE.Vector3(x, b.y + ly, z);
    };
    const segs = [];
    if (offset != null) segs.push([at(offset, 0), at(offset, b.config.height)]);
    if (y != null) segs.push([at(-L, y + 0.1), at(L, y + 0.1)]);
    for (const [p0, p1] of segs) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p0, p1]), this.guideMat);
      line.computeLineDistances();
      line.renderOrder = 21;
      this.holeGuides.add(line);
    }
  }

  // ---------------------------------------------------------------- working plane

  showWorkPlane(center, h) {
    this.workPlane.position.set(center[0], h + 0.01, center[1]);
    this.workPlane.visible = true;
  }

  hideWorkPlane() {
    this.workPlane.visible = false;
  }

  // ---------------------------------------------------------------- belt

  showBelt(path, valid) {
    this.belt.geometry.dispose();
    this.belt.geometry = beltGeometry(path);
    this.beltMat.color.copy(valid ? VALID : INVALID);
    this.belt.visible = true;
  }

  hideBelt() {
    this.belt.visible = false;
  }

  /** i = 0 start, 1 end. dir: [x, z] or null (no arrow). */
  showMarker(i, pos, h, dir, valid = true) {
    const m = this.markers[i];
    const { post, head, arrow } = m.userData;
    m.visible = true;
    m.position.set(pos[0], 0, pos[1]);
    post.scale.y = Math.max(0.01, h);
    post.position.y = h / 2;
    head.position.y = h;
    arrow.visible = !!dir;
    if (dir) head.rotation.y = Math.atan2(dir[0], dir[1]);
    const c = valid ? VALID : INVALID;
    m.traverse((o) => o.material?.color?.copy(c));
  }

  hideMarker(i) {
    this.markers[i].visible = false;
  }

  showConnector(c) {
    this.connectorRing.visible = true;
    this.connectorRing.position.set(c.pos[0], c.h, c.pos[1]);
    this.connectorRing.rotation.set(0, Math.atan2(c.normal[0], c.normal[1]), 0);
  }

  hideConnector() {
    this.connectorRing.visible = false;
  }

  /** lines: [{origin:[x,z], dir:[x,z], h}] drawn 40 m long. */
  setGuidelines(lines) {
    for (const c of [...this.guides.children]) {
      c.geometry.dispose();
      this.guides.remove(c);
    }
    for (const l of lines || []) {
      const a = new THREE.Vector3(l.origin[0], l.h + 0.05, l.origin[1]);
      const b = new THREE.Vector3(l.origin[0] + l.dir[0] * 40, l.h + 0.05, l.origin[1] + l.dir[1] * 40);
      const g = new THREE.BufferGeometry().setFromPoints([a, b]);
      const line = new THREE.Line(g, this.guideMat);
      line.computeLineDistances();
      this.guides.add(line);
    }
  }

  // ---------------------------------------------------------------- building ghost

  /** `b` = { type, config? } — config defaults to the building type's defaults. */
  showGhost(b, x, y, z, rot, valid) {
    const shape = { type: b.type, config: b.config ?? BUILDINGS[b.type].defaults };
    const key = shapeKey(shape);
    if (this.ghostType !== key) {
      this.hideGhost();
      this.ghost = buildingObject(shape);
      this.ghost.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = false;
        if (o.userData.portDir) {
          o.material = arrowMaterial(o.userData.portDir);
          o.renderOrder = 22;
          o.scale.setScalar(1.3);
        } else o.material = holoMaterial(VALID);
      });
      this.ghostType = key;
      this.group.add(this.ghost);
    }
    this.ghost.visible = true;
    this.ghost.position.set(x, y, z);
    this.ghost.rotation.y = rot;
    const c = valid ? VALID : INVALID;
    this.ghost.traverse((o) => o.isMesh && !o.userData.portDir && o.material.color.copy(c));
  }

  hideGhost() {
    if (this.ghost) {
      this.ghost.removeFromParent();
      this.ghost = null;
      this.ghostType = null;
    }
  }

  clear() {
    this.hideBelt();
    this.hideMarker(0);
    this.hideMarker(1);
    this.hideConnector();
    this.setGuidelines([]);
    this.hideGhost();
    this.hideWorkPlane();
    this.hideHoleGhost();
    this.showHoleGuides(null);
    this.hideHeightTag();
  }
}
