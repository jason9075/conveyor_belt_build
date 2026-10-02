import { BUILDINGS, BUILDING_ORDER, BELT, BELT_SPEED, WALL_MIN_LENGTH, WALL_MAX_LENGTH, HOLE_LABEL, HOLE_MIN_Y, HOLE_TOOLS, holeY, holeSide, holesOf } from '../core/catalog.js';
import { MODE_LABEL, MODES } from '../core/routing.js';
import { STEP_LABEL } from './controller.js';
import { fmt } from '../core/analysis.js';
import { DEG } from '../core/vec.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const STATUS = {
  running: ['運轉中', 'good'],
  starved: ['缺料', 'warn'],
  blocked: ['輸出堵塞', 'warn'],
  unconnected: ['未連接', 'bad'],
  idle: ['待機', ''],
};

export class UI {
  constructor({ world, sim, app }) {
    this.world = world;
    this.sim = sim;
    this.app = app;
    this.analysis = null;
    this.selection = null;
    this.ctl = null;
    this._statsTimer = 0;
    this._buildStatic();
  }

  attach(ctl) {
    this.ctl = ctl;
    this.syncToolbar(ctl);
  }

  // ---------------------------------------------------------------- static chrome

  _buildStatic() {
    $('#palette').innerHTML =
      `<div class="pal-title">設施</div>` +
      BUILDING_ORDER.map((type, i) => {
        const d = BUILDINGS[type];
        return `<button data-build="${type}" title="${d.name}（${i + 1}）"><span class="chip" style="background:${d.color}">${d.short}</span><span>${d.name}</span><kbd>${i + 1}</kbd></button>`;
      }).join('') +
      `<div class="pal-title">牆壁洞口</div>` +
      HOLE_TOOLS.map((t, i) => {
        const key = BUILDING_ORDER.length + i + 1;
        return `<button data-hole-tool="${t.dir}" title="${t.name}：點在牆壁上放置（${key}）"><span class="chip hole-chip" style="background:${t.color}">${t.short}</span><span>${t.name}</span><kbd>${key}</kbd></button>`;
      }).join('');
    $('#palette').addEventListener('click', (e) => {
      const b = e.target.closest('[data-build]');
      if (b) this.ctl.setTool('build', b.dataset.build);
      const h = e.target.closest('[data-hole-tool]');
      if (h) this.ctl.setTool('hole', h.dataset.holeTool);
    });

    $('#tools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (b) this.ctl.setTool(b.dataset.tool);
    });
    $('#modeBtn').onclick = () => this.ctl.cycleMode();
    $('#gridBtn').onclick = () => {
      this.ctl.grid = !this.ctl.grid;
      this.syncToolbar(this.ctl);
    };
    $('#hUp').onclick = () => this.ctl.adjustHeight(0.5);
    $('#hDown').onclick = () => this.ctl.adjustHeight(-0.5);
    $('#chainChk').onchange = (e) => (this.ctl.chain = e.target.checked);

    $('#playBtn').onclick = () => this.togglePlay();
    $('#speedSel').onchange = (e) => {
      this.app.speed = Number(e.target.value);
      e.target.blur();
    };
    // Toolbar buttons should not keep focus (Space / hotkeys belong to the viewport).
    document.addEventListener('click', (e) => {
      const b = e.target.closest?.('button');
      if (b) b.blur();
    });
    $('#resetSimBtn').onclick = () => {
      this.sim.reset();
      this.toast('已清空線上所有箱子並重設統計');
    };
    $('#labelsBtn').onclick = () => this.app.toggleLabels();
    $('#heatBtn').onclick = () => this.app.toggleHeatmap();
    $('#demoBtn').onclick = () => {
      if (!this.world.buildings.size || confirm('載入示範倉庫會取代目前的配置，確定？')) this.app.loadDemo();
    };
    $('#exportBtn').onclick = () => this.app.exportJSON();
    $('#importBtn').onclick = () => $('#importFile').click();
    $('#importFile').onchange = (e) => {
      const f = e.target.files[0];
      if (f) f.text().then((t) => this.app.importJSON(t));
      e.target.value = '';
    };
    $('#clearBtn').onclick = () => {
      if (confirm('清空所有設施與輸送帶？')) this.world.clear();
    };
    $('#helpBtn').onclick = () => this.toggleHelp();
    $('#help').addEventListener('click', (e) => {
      if (e.target.id === 'help' || e.target.closest('.close')) this.toggleHelp(false);
    });
    $('#bendInput').onchange = (e) => {
      const v = Math.max(0.5, Math.min(8, Number(e.target.value) || 2));
      this.world.rules.bendRadius = v;
      e.target.value = v;
      this.toast(`最小彎曲半徑 = ${v} m（只影響之後建造的輸送帶）`);
      this.ctl.refresh();
    };
    $('#bendInput').value = this.world.rules.bendRadius;
    // Live re-renders would swap a button out from under a click in progress.
    $('#selection').addEventListener('pointerdown', () => (this._pressing = true));
    window.addEventListener('pointerup', () => setTimeout(() => (this._pressing = false)));
  }

  onKey(k) {
    if (k === ' ') this.togglePlay();
    else if (k === 'h' || k === '?') this.toggleHelp();
    else if (k === 'l') this.app.toggleLabels();
    else if (k === 'm') this.app.toggleHeatmap();
  }

  togglePlay() {
    this.app.running = !this.app.running;
    $('#playBtn').textContent = this.app.running ? '⏸ 暫停' : '▶ 執行';
  }

  toggleHelp(force) {
    $('#help').classList.toggle('hidden', force === undefined ? undefined : !force);
  }

  syncToolbar(ctl) {
    document.querySelectorAll('#tools [data-tool]').forEach((b) => b.classList.toggle('active', ctl.tool === b.dataset.tool));
    document.querySelectorAll('#palette [data-build]').forEach((b) =>
      b.classList.toggle('active', ctl.tool === 'build' && ctl.buildType === b.dataset.build),
    );
    document.querySelectorAll('#palette [data-hole-tool]').forEach((b) =>
      b.classList.toggle('active', ctl.tool === 'hole' && ctl.buildType === b.dataset.holeTool),
    );
    $('#modeBtn').innerHTML = `模式：<b>${MODE_LABEL[ctl.mode]}</b> <kbd>R</kbd>`;
    $('#gridBtn').classList.toggle('active', ctl.grid);
    const wall = ctl.tool === 'build' && ctl.buildType === 'wall';
    const facility = ctl.tool === 'build' && !wall;
    $('#heightLbl').textContent = facility ? '滑鼠' : `${(wall ? ctl.buildY : ctl.freeH).toFixed(1)} m`;
    $('#heightName').textContent = wall ? '牆底高度' : facility ? '設施高度' : '端點高度';
    $('#heightName').title = wall
      ? '牆壁的底部高度 ([ / ])'
      : facility
        ? '放置設施時：第一下決定位置，往上移動滑鼠決定高度，第二下放置'
        : '輸送帶端點放在空地時的高度 ([ / ])';
    $('#hUp').disabled = $('#hDown').disabled = facility;
    $('#labelsBtn').classList.toggle('active', this.app.view?.showLabels);
    $('#heatBtn').classList.toggle('active', this.app.view?.heatmap);
    if (ctl.tool === 'belt') this.setStep(STEP_LABEL[ctl.step]);
    else {
      const step = {
        build: () => `放置 ${BUILDINGS[ctl.buildType]?.name ?? ''}`,
        hole: () => `放置 ${HOLE_TOOLS.find((t) => t.dir === ctl.buildType)?.name ?? ''}`,
        dismantle: () => '拆除模式',
      }[ctl.tool];
      this.setStep(step ? step() : '選取模式');
    }
  }

  setStep(t) {
    $('#step').textContent = t;
  }

  setHint(t, level = '') {
    const el = $('#hint');
    el.textContent = t;
    el.className = level;
  }

  setCoords(g, h = 0) {
    $('#coords').textContent = g ? `x ${g[0].toFixed(1)}  y ${h.toFixed(1)}  z ${g[1].toFixed(1)}` : '';
  }

  toast(msg, level = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${level}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3100);
  }

  // ---------------------------------------------------------------- analysis & selection

  setAnalysis(a) {
    this.analysis = a;
    this.renderSummary();
    this.renderSelection();
  }

  showSelection(sel) {
    this.selection = sel;
    this.renderSelection();
    $('#selection .hole.focus')?.scrollIntoView({ block: 'nearest' });
  }

  tick(dt) {
    this._statsTimer += dt;
    if (this._statsTimer < 0.5) return;
    this._statsTimer = 0;
    $('#simTime').textContent = `${fmtTime(this.sim.time)} · ${this.sim.itemCount()} 箱在線上`;
    const panel = $('#selection');
    if (!this._pressing && !panel.contains(document.activeElement)) this.renderSelection();
    this.renderMeasured();
  }

  renderSummary() {
    const a = this.analysis;
    if (!a) return;
    const w = this.world;
    let supplyOut = 0;
    let supplyNominal = 0;
    const receivers = [];
    for (const b of w.buildings.values()) {
      const rep = a.nodes.get(b.id);
      (holesOf(b) ?? []).forEach((h, i) => {
        const flow = rep?.holes?.[i].flow ?? 0;
        if (h.dir === 'out') {
          supplyOut += flow;
          supplyNominal += h.rate;
        } else receivers.push({ b, i, h, flow });
      });
    }
    let beltLen = 0;
    for (const b of w.belts.values()) beltLen += b.path.length;
    const where = (b, i) => (b.type === 'wall' ? `${BUILDINGS.wall.name} #${b.id} · 洞口 ${i + 1}` : `${BUILDINGS[b.type].name} #${b.id}`);

    $('#summary').innerHTML = `
      <h3>倉庫總覽 <small>理論穩態</small></h3>
      <div class="kv"><span>設施</span><span>${w.buildings.size} 座 · 輸送帶 ${w.belts.size} 條（${beltLen.toFixed(0)} m）</span></div>
      <div class="kv"><span>供箱</span><span><b>${fmt(supplyOut)}</b> / ${fmt(supplyNominal)} 箱/分</span></div>
      <div class="kv"><span>收箱</span><span><b>${fmt(a.delivered)}</b> 箱/分 <em class="measured" id="measuredTotal"></em></span></div>
      <h4>各收箱點</h4>
      <div id="deliveredList">
      ${receivers.map(({ b, i, flow }) => `<div class="kv" data-recv="${b.id}:${i}"><span>${where(b, i)}</span><span><b>${fmt(flow)}</b> <em class="measured"></em></span></div>`).join('') || '<div class="dim">尚無收箱口</div>'}
      </div>
      <h4>問題 <small>${a.issues.length}</small></h4>
      <ul class="issues">
        ${a.issues.map((i, n) => `<li class="${i.level}" data-n="${n}">${esc(i.text)}</li>`).join('') || '<li class="good">沒有發現瓶頸 👍</li>'}
      </ul>`;
    $('#summary .issues').onclick = (e) => {
      const li = e.target.closest('[data-n]');
      if (!li) return;
      const issue = a.issues[Number(li.dataset.n)];
      const kind = issue.type === 'belt' ? 'belt' : 'building';
      this.ctl.select({ kind, id: issue.id });
      if (kind === 'building') {
        const b = w.buildings.get(issue.id);
        if (b) this.ctl.focus(b.x, b.z);
      } else {
        const belt = w.belts.get(issue.id);
        if (belt) {
          const m = belt.path.sample(belt.path.length / 2);
          this.ctl.focus(m.pos[0], m.pos[2]);
        }
      }
    };
  }

  renderMeasured() {
    // Measured receive rates next to the theoretical ones.
    let total = 0;
    document.querySelectorAll('#deliveredList [data-recv]').forEach((el) => {
      const [id, i] = el.dataset.recv.split(':').map(Number);
      const v = this.sim.nodeStats(id)?.holes[i] ?? 0;
      total += v;
      const m = el.querySelector('.measured');
      if (m) m.textContent = `實測 ${fmt(v)}`;
    });
    const t = $('#measuredTotal');
    if (t) t.textContent = `實測 ${fmt(total)}`;
  }

  renderSelection() {
    const el = $('#selection');
    const sel = this.selection;
    if (!sel) {
      el.innerHTML = `<h3>選取</h3><div class="dim">按 <kbd>V</kbd> 選取工具後點擊設施或輸送帶。<br>拖曳設施可以移動，連接的輸送帶會自動重新路由。</div>`;
      return;
    }
    if (sel.kind === 'belt') this._renderBelt(el, sel.id);
    else this._renderBuilding(el, sel.id, sel.hole);
  }

  _renderBelt(el, id) {
    const belt = this.world.belts.get(id);
    if (!belt) return (el.innerHTML = '');
    const r = this.analysis?.belts.get(id);
    const desc = (key) => {
      if (!key) return '<span class="dim">未連接（支撐點）</span>';
      const c = this.world.getConnector(key);
      if (!c) return key;
      if (c.owner.type === 'belt') return `輸送帶 #${c.owner.id}`;
      const b = this.world.buildings.get(c.owner.id);
      return `${BUILDINGS[b.type].name} #${b.id}`;
    };
    const rt = this.sim.belts.get(id);
    el.innerHTML = `
      <h3>輸送帶 #${id}</h3>
      <div class="kv"><span>從</span><span>${desc(belt.from)}</span></div>
      <div class="kv"><span>到</span><span>${desc(belt.to)}</span></div>
      <div class="kv"><span>長度</span><span>${belt.path.length.toFixed(2)} m · 坡度 ${(belt.path.incline() / DEG).toFixed(1)}°</span></div>
      <div class="kv"><span>最小半徑</span><span>${fmtR(belt.path.minRadius())}</span></div>
      <div class="kv"><span>Spline 段數</span><span>${belt.path.segments.length}</span></div>
      <div class="kv"><span>速度</span><span>${BELT_SPEED.toFixed(2)} m/s · 容量 ${BELT.rate} 箱/分</span></div>
      <h4>吞吐量</h4>
      ${r ? `
      <div class="bar"><div style="width:${Math.min(100, r.util * 100)}%" class="${r.overCapacity ? 'bad' : r.util > 0.999 ? 'full' : 'good'}"></div></div>
      <div class="kv"><span>理論流量</span><span><b>${fmt(r.flow)}</b> / ${r.cap} 箱/分（${(r.util * 100).toFixed(0)}%）</span></div>
      <div class="kv"><span>上游供給</span><span>${fmt(r.offer)} 箱/分${r.overCapacity ? ' <em class="bad">超過容量</em>' : r.backedUp ? ' <em class="warn">下游回堵</em>' : ''}</span></div>
` : ''}
      <div class="kv"><span>實測</span><span>${fmt(this.sim.beltRate(id))} 箱/分 · 線上 ${rt?.items.length ?? 0} 箱</span></div>
      <h4>重新路由</h4>
      <div class="row">${MODES.map((m) => `<button data-mode="${m}" class="${m === belt.mode ? 'active' : ''}">${MODE_LABEL[m]}</button>`).join('')}</div>
      <div class="row"><button class="danger" data-act="del">刪除 <kbd>Del</kbd></button></div>`;
    el.querySelectorAll('[data-mode]').forEach(
      (b) =>
        (b.onclick = () => {
          const plan = this.world.replanBelt(belt, b.dataset.mode);
          if (plan.error) return this.toast(plan.error, 'error');
          const hard = plan.errors.filter((x) => !x.startsWith('碰撞'));
          if (hard.length) return this.toast(hard.join('；'), 'error');
          belt.mode = b.dataset.mode;
          this.world._applyPlan(belt, plan);
          this.world.emit();
        }),
    );
    el.querySelector('[data-act=del]').onclick = () => this.ctl.removeSelection();
  }

  _renderBuilding(el, id, focusHole) {
    const b = this.world.buildings.get(id);
    if (!b) return (el.innerHTML = '');
    const def = BUILDINGS[b.type];
    const rep = this.analysis?.nodes.get(id);
    const st = this.sim.nodeStats(id);
    const [stText, stCls] = STATUS[st?.status] || ['', ''];
    let body = '';
    if (def.kind === 'source') {
      body = `
        <label class="field">供箱速率 <input data-cfg="rate" type="number" min="1" max="5000" step="1" value="${b.config.rate}"> 箱/分</label>
        <div class="row presets">${[10, 15, 20, 30, 45, 60, 90].map((v) => `<button data-rate="${v}">${v}</button>`).join('')}</div>
        <h4>狀態</h4>
        <div class="kv"><span>理論送出</span><span><b>${fmt(rep?.output ?? 0)}</b> / ${b.config.rate} 箱/分</span></div>
        <div class="kv"><span>實測送出</span><span>${fmt(st?.produced ?? 0)} 箱/分 <em class="${stCls}">${stText}</em></span></div>`;
    } else if (def.kind === 'sink') {
      body = `
        <label class="field">處理上限 <input data-cfg="rate" type="number" min="0" step="1" value="${b.config.rate}"> 箱/分 <small class="dim">0 = 無限</small></label>
        <div class="dim">例如包裝站、出貨碼頭或儲位入口每分鐘能吃下的箱數。</div>
        <h4>狀態</h4>
        <div class="kv"><span>理論接收</span><span><b>${fmt(rep?.input ?? 0)}</b> 箱/分</span></div>
        <div class="kv"><span>實測接收</span><span>${fmt(st?.consumed ?? 0)} 箱/分</span></div>`;
    } else if (def.kind === 'wall') {
      body = this._wallBody(b, rep, st, focusHole);
    } else if (def.kind === 'pole') {
      body = `
        <label class="field">接口高度 <input data-pole type="number" min="0.5" max="30" step="0.5" value="${b.config.height}"> m</label>
        <div class="dim">輸送帶接到貨架頂端的接口（一進一出），用來把線拉到二樓或架高跨過走道。把另一個貨架疊在上面可以再加一層接口。</div>
        <h4>狀態</h4><div class="kv"><span>理論通過量</span><span><b>${fmt(rep?.throughput ?? 0)}</b> 箱/分</span></div>`;
    } else {
      body = `<h4>狀態</h4><div class="kv"><span>理論通過量</span><span><b>${fmt(rep?.throughput ?? 0)}</b> 箱/分</span></div>
        <div class="dim">${
          def.kind === 'splitter'
            ? '分流器把箱子輪流分到已連接的出口；某個出口堵住時，其他出口會分到更多。'
            : '集合器輪流從各入口取箱子併成一條線；出口吃不下時，各入口公平分配。'
        }</div>`;
    }
    el.innerHTML = `
      <h3><span class="chip" style="background:${def.color}">${def.short}</span> ${def.name} #${id}</h3>
      ${body}
      <label class="field">底部高度 <input data-elev type="number" min="0" max="30" step="0.5" value="${b.y}"> m <small class="dim">夾層／高架</small></label>
      <div class="kv"><span>位置</span><span>(${b.x.toFixed(1)}, ${b.y.toFixed(1)}, ${b.z.toFixed(1)}) · ${((((b.rot / DEG) % 360) + 360) % 360).toFixed(0)}°</span></div>
      <div class="row"><button data-act="rot">旋轉 90° <kbd>R</kbd></button><button class="danger" data-act="del">刪除 <kbd>Del</kbd></button></div>`;
    el.querySelectorAll('[data-cfg]').forEach((inp) => {
      inp.onchange = () => {
        const key = inp.dataset.cfg;
        b.config[key] = inp.type === 'number' ? Math.max(0, Number(inp.value) || 0) : inp.value;
        this.world.emit();
      };
    });
    el.querySelectorAll('[data-rate]').forEach(
      (btn) =>
        (btn.onclick = () => {
          b.config.rate = Number(btn.dataset.rate);
          this.world.emit();
        }),
    );
    if (def.kind === 'wall') this._bindWall(el, b);
    const poleInput = el.querySelector('[data-pole]');
    if (poleInput) {
      poleInput.onchange = () => {
        const res = this.world.setPoleHeight(b.id, Number(poleInput.value) || 0);
        if (res.error) this.toast(res.error, 'error');
        this.renderSelection();
      };
    }
    el.querySelector('[data-elev]').onchange = (e) => {
      const res = this.world.setElevation(b.id, Number(e.target.value) || 0);
      if (res.error) this.toast(res.error, 'error');
      this.renderSelection();
    };
    el.querySelector('[data-act=rot]').onclick = () => {
      const res = this.world.moveBuilding(b.id, b.x, b.z, b.rot + Math.PI / 2);
      if (res.error) this.toast(res.error, 'error');
    };
    el.querySelector('[data-act=del]').onclick = () => this.ctl.removeSelection();
  }

  // ---------------------------------------------------------------- walls

  _wallBody(b, rep, st, focusHole) {
    const holes = b.config.holes;
    const rows = holes
      .map((h, i) => {
        const hr = rep?.holes?.[i];
        const measured = st?.holes?.[i] ?? 0;
        const cfg =
          h.dir === 'out'
            ? `<label class="field">供箱速率 <input data-hole="${i}" data-k="rate" type="number" min="1" max="5000" step="1" value="${h.rate}"> 箱/分</label>`
            : `<label class="field">處理上限 <input data-hole="${i}" data-k="rate" type="number" min="0" step="1" value="${h.rate}"> 箱/分 <small class="dim">0 = 無限</small></label>`;
        const flow = h.dir === 'out' ? `送出 <b>${fmt(hr?.flow ?? 0)}</b> / ${h.rate}` : `收到 <b>${fmt(hr?.flow ?? 0)}</b>`;
        return `<div class="hole ${h.dir}${i === focusHole ? ' focus' : ''}">
          <div class="hole-head">
            <b>洞口 ${i + 1}</b>
            <select data-hole="${i}" data-k="dir">${['out', 'in'].map((d) => `<option value="${d}" ${h.dir === d ? 'selected' : ''}>${HOLE_LABEL[d]}</option>`).join('')}</select>
            <select data-hole="${i}" data-k="side" title="洞口開在哪一面">${[1, -1].map((v) => `<option value="${v}" ${holeSide(h) === v ? 'selected' : ''}>${v > 0 ? '正面' : '背面'}</option>`).join('')}</select>
            <button class="sq danger" data-del-hole="${i}" title="移除洞口">✕</button>
          </div>
          <div class="field">位置 <input data-hole="${i}" data-k="offset" type="number" step="0.5" value="${h.offset}" title="沿牆距中心">
            高度 <input data-hole="${i}" data-k="y" type="number" min="${HOLE_MIN_Y}" step="0.5" value="${holeY(h)}" title="離牆底的輸送帶高度"> m</div>
          ${cfg}
          <div class="kv"><span>${hr?.linked ? '已連接' : '<span class="dim">未連接</span>'}</span><span>${flow} 箱/分 · 實測 ${fmt(measured)}</span></div>
        </div>`;
      })
      .join('');
    return `
      <label class="field">長度 <input data-wall="length" type="number" min="${WALL_MIN_LENGTH}" max="${WALL_MAX_LENGTH}" step="0.5" value="${b.config.length}"> m</label>
      <label class="field">高度 <input data-wall="height" type="number" min="1.5" max="20" step="0.5" value="${b.config.height}"> m</label>
      <h4>洞口 <small>${holes.length}</small></h4>
      ${holes.length ? '<div class="dim">位置＝沿牆距中心，高度＝離牆底的輸送帶高度；洞口可以上下疊放。</div>' : ''}
      ${rows || '<div class="dim">還沒有洞口。供箱洞口讓箱子從牆的另一側送進來（例如收貨區），收箱洞口把箱子送出這一區（例如出貨區）。</div>'}
      <div class="dim">要加洞口：從左側選「${HOLE_TOOLS.map((t) => t.name).join('」或「')}」，點在牆上想開洞的位置。</div>
      ${holes.length ? `<h4>合計</h4>
      <div class="kv"><span>理論送出</span><span><b>${fmt(rep?.output ?? 0)}</b> / ${fmt(rep?.nominal ?? 0)} 箱/分</span></div>
      <div class="kv"><span>理論接收</span><span><b>${fmt(rep?.input ?? 0)}</b> 箱/分</span></div>` : ''}`;
  }

  _bindWall(el, b) {
    const report = (res) => res?.error && this.toast(res.error, 'error');
    el.querySelectorAll('[data-wall]').forEach((inp) => {
      inp.onchange = () => {
        report(this.world.setWallSize(b.id, { [inp.dataset.wall]: Number(inp.value) || 0 }));
        this.renderSelection();
      };
    });
    el.querySelectorAll('[data-hole]').forEach((inp) => {
      inp.onchange = () => {
        const k = inp.dataset.k;
        const v = k === 'dir' ? inp.value : k === 'side' ? Number(inp.value) : k === 'rate' ? Math.max(0, Number(inp.value) || 0) : Number(inp.value) || 0;
        report(this.world.updateWallHole(b.id, Number(inp.dataset.hole), { [k]: v }));
        this.renderSelection();
      };
    });
    el.querySelectorAll('[data-del-hole]').forEach((btn) => (btn.onclick = () => this.world.removeWallHole(b.id, Number(btn.dataset.delHole))));
  }
}

function fmtTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtR(r) {
  return r === Infinity ? '∞（直線）' : `${r.toFixed(2)} m`;
}
