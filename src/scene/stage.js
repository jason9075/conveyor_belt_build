import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

/** Renderer, camera, lights, ground and grid. */
export function createStage(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'label-layer';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1a1f25');
  scene.fog = new THREE.Fog('#1a1f25', 160, 420);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 2000);
  camera.position.set(38, 46, 92);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 36);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(89.5); // E can lower the camera to almost floor level
  controls.minDistance = 4;
  controls.maxDistance = 400;
  // Left button is reserved for building; right = orbit, middle = pan, wheel = zoom.
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };

  scene.add(new THREE.HemisphereLight('#dfe8ff', '#3a3226', 1.1));
  const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
  sun.position.set(40, 80, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -90;
  sc.right = 90;
  sc.top = 90;
  sc.bottom = -90;
  sc.near = 1;
  sc.far = 260;
  sun.shadow.bias = -0.0005;
  scene.add(sun, sun.target);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(800, 800),
    new THREE.MeshStandardMaterial({ color: '#2a3036', roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);

  const minor = new THREE.GridHelper(400, 400, '#3a424b', '#323941');
  minor.position.y = 0.003;
  minor.material.transparent = true;
  minor.material.opacity = 0.55;
  const major = new THREE.GridHelper(400, 50, '#4d5863', '#4d5863');
  major.position.y = 0.006;
  major.material.transparent = true;
  major.material.opacity = 0.7;
  scene.add(minor, major);

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  function render() {
    controls.update();
    // Keep the shadow frustum around what the camera is looking at.
    sun.target.position.copy(controls.target);
    sun.position.set(controls.target.x + 40, 80, controls.target.z + 30);
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  return { renderer, labelRenderer, scene, camera, controls, ground, render, resize };
}
