import './style.css';
import { World } from './core/world.js';
import { Simulation } from './core/sim.js';
import { analyze } from './core/analysis.js';
import { buildDemo } from './core/examples.js';
import { createStage } from './scene/stage.js';
import { FactoryView } from './scene/view.js';
import { Hologram } from './scene/hologram.js';
import { Controller } from './ui/controller.js';
import { UI } from './ui/panel.js';

const STORAGE_KEY = 'warehouse-planner-v1';
const TICK = 1 / 60;

const world = new World();
let restored = false;
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    world.load(JSON.parse(saved));
    restored = true;
  }
} catch (err) {
  console.warn('could not restore layout', err);
}
if (!restored) buildDemo(world);

const sim = new Simulation(world);
const stage = createStage(document.getElementById('viewport'));
const view = new FactoryView(stage, world, sim);
const holo = new Hologram(stage.scene);

const app = {
  running: true,
  speed: 1,
  view,
  toggleLabels() {
    view.showLabels = !view.showLabels;
    ui.syncToolbar(ctl);
  },
  toggleHeatmap() {
    view.heatmap = !view.heatmap;
    view.applyColors();
    ui.syncToolbar(ctl);
    ui.toast(view.heatmap ? '利用率熱圖：綠 = 有流量、黃 = 滿載、橘 = 下游回堵、紅 = 超過容量' : '顯示輸送帶原色');
  },
  loadDemo() {
    buildDemo(world);
    sim.reset();
    ctl.fitView();
    ui.toast('已載入示範倉庫：收貨牆 → 分流 → 儲位／包裝站／出貨牆（含刻意的瓶頸）');
  },
  exportJSON() {
    const blob = new Blob([JSON.stringify(world.toJSON(), null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `factory-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  importJSON(text) {
    try {
      world.load(JSON.parse(text));
      sim.reset();
      ctl.fitView();
      ui.toast('已匯入配置');
    } catch (err) {
      ui.toast(`匯入失敗：${err.message}`, 'error');
    }
  },
};

const ui = new UI({ world, sim, app });
const ctl = new Controller({ stage, world, view, holo, ui });
ui.attach(ctl);
ctl.fitView();
if (!restored) ui.toggleHelp(true);

// ------------------------------------------------------------------ world changes

let dirty = true;
let saveTimer = null;
world.onChange(() => {
  dirty = true;
});

function recompute() {
  sim.rebuild();
  view.sync();
  const a = analyze(world);
  view.setAnalysis(a);
  ui.setAnalysis(a);
  ctl.onWorldChange();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(world.toJSON()));
    } catch {
      /* storage unavailable */
    }
  }, 400);
}

// ------------------------------------------------------------------ loop

let last = performance.now();
let acc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (dirty) {
    dirty = false;
    recompute();
  }
  if (app.running) {
    acc += dt * app.speed;
    let n = 0;
    while (acc >= TICK && n < 1200) {
      sim.step(TICK);
      acc -= TICK;
      n++;
    }
    if (n >= 1200) acc = 0;
  }
  ctl.tick(dt);
  view.update(dt, app.running, app.speed);
  ui.tick(dt);
  stage.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for poking at things from the devtools console.
window.planner = { world, sim, view, ctl, analyze };
