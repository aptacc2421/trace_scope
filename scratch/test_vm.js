// per-VM 面板 + token 口径 + 并发带：真机（CDP）验证
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9227;
const PROF = path.join(__dirname, 'chrome-prof-vm');
const BASE = 'http://127.0.0.1:8765';
const ROOT = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display\\webdev-prof-usable-20261123';
const R1 = ROOT + '\\tb-auto-g4';
const R2 = ROOT + '\\webdev-plumbing-g4';
const M1 = R1 + '\\host\\memlog.jsonl';
const M2 = R2 + '\\host\\memlog.jsonl';
const SWE = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display\\mimo-swe-12\\traj';
const REP = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display\\swe12-replay-1-20261116\\swe12-replay-1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
if (fs.existsSync(PROF)) fs.rmSync(PROF, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--no-first-run', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
  '--window-size=1680,1000', 'about:blank'], { stdio: 'ignore' });

(async () => {
  let ver = null;
  for (let i = 0; i < 80; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (e) { await sleep(250); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && wait.has(m.id)) { const { res, rej } = wait.get(m.id); wait.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  const send = (method, params, sid, tmo) => {
    const i = ++id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { wait.delete(i); rej(new Error('CDP 超时 ' + method)); }, tmo || 30000);
      wait.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId: sid }));
    });
  };
  await fetch(BASE + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ROOT }) });
  await sleep(400);
  const { targetId } = await send('Target.createTarget', { url: BASE + '/' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId, 120000);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  const waitFor = async (expr, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 60000)) { try { if (await ev(expr)) return; } catch (e) { } await sleep(300); }
    throw new Error('超时 ' + label);
  };
  const shot = async (file, clip) => {
    const r = await send('Page.captureScreenshot', clip
      ? { format: 'png', clip: { ...clip, scale: 2 }, captureBeyondViewport: false }
      : { format: 'png', captureBeyondViewport: false }, sessionId);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('shot ' + path.basename(file));
  };

  await waitFor('!!(window.scopeDebug && scopeDebug.state.lanes[0] && scopeDebug.state.lanes[0].payload)', 90000, 'boot');
  const boots = await ev(`(() => ({ runs: scopeDebug.state.lanes[0].payload.runs.length,
    ids: scopeDebug.state.lanes[0].payload.runs.map(r => r.id).slice(0, 4) }))()`);
  console.log('lane0 ' + JSON.stringify(boots));

  // 两路：tb-auto-g4（第 0 路固定到这个 run）+ 新增 webdev-plumbing-g4
  await ev(`(async () => {
    const pick = (i, rid) => { const l = scopeDebug.state.lanes[i];
      l.runId = rid; l.activeEp = null; l.activeSpan = null; };
    pick(0, 'tb-auto-g4');
    const j = await (await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ${JSON.stringify(R2)} }) })).json();
    const lane = scopeDebug.addLane(null);
    scopeDebug.applyPayload(lane, j);
    lane.runId = 'webdev-plumbing-g4';
    return true;
  })()`);
  await waitFor(`scopeDebug.state.lanes.length === 2 && !!scopeDebug.state.lanes[1].payload`, 60000, 'lane2');
  await ev(`(async () => {
    await scopeDebug.loadMemlogFile(0, ${JSON.stringify(M1)});
    await scopeDebug.loadMemlogFile(1, ${JSON.stringify(M2)});
    return true;
  })()`);
  await waitFor(`!!(scopeDebug.state.lanes[0].mem && scopeDebug.state.lanes[1].mem)`, 120000, 'memlogs');
  const memInfo = await ev(`(() => ({ f0: scopeDebug.state.lanes[0].mem.fields.length,
    f1: scopeDebug.state.lanes[1].mem.fields.length,
    pervmFields: scopeDebug.state.lanes[0].mem.fields.filter(f => f.startsWith('per_vm')).length,
    fc: scopeDebug.state.lanes[0].mem.fields.filter(f => f.includes('fc_')) }))()`);
  console.log('mem ' + JSON.stringify(memInfo));

  // per-VM 面板
  await ev(`scopeDebug.openMemVm(); true`);
  await waitFor(`!!(scopeDebug.state.lanes[0].vmCache && scopeDebug.state.lanes[1].vmCache)`, 120000, 'vm data');
  await sleep(600);
  const vmInfo = await ev(`(() => {
    const d0 = scopeDebug.state.lanes[0].vmCache.data, d1 = scopeDebug.state.lanes[1].vmCache.data;
    return { m: scopeDebug.vmMetricRef(),
      l0: { n: d0.n_vm, live: d0.n_live, peakN: d0.peak.n, peakRss: d0.peak.rss, t0: d0.t0, t1: d0.t1,
            vms: d0.vms.slice(0, 3).map(v => ({ id: v.label, live: v.live, peak: v.peak, rssPeak: v.rss_peak, npts: v.pts.length })) },
      l1: { n: d1.n_vm, live: d1.n_live, peakN: d1.peak.n, peakRss: d1.peak.rss },
      disp: document.querySelector('#memVm').style.display,
      read: document.querySelector('#vmRead').textContent.slice(0, 90),
      list: document.querySelector('#vmList').textContent.slice(0, 160) };
  })()`);
  console.log('vm ' + JSON.stringify(vmInfo));
  // 每沙箱一色：同路内不重复，两路之间不撞色
  const vmCols = await ev(`(() => {
    const d = window.__vmDots || [];
    const by = { 0: [], 1: [] }, cnt = { 0: 0, 1: 0 };
    d.forEach(x => {
      if (!by[x.lane]) return;
      cnt[x.lane]++;
      if (!by[x.lane].includes(x.col)) by[x.lane].push(x.col);
    });
    return { n: d.length, c0: by[0], c1: by[1], n0: cnt[0], n1: cnt[1],
      hover: !!(window.__vmCursor && window.__vmCursor.hover) };
  })()`);
  console.log('vmCols ' + JSON.stringify(vmCols));
  if (vmCols.hover) throw new Error('默认状态不应该算悬停');
  // 默认游标未必落在多沙箱时刻；移到沙箱密集处验颜色，同时验鼠标移动不抖
  const hoverAt = async (frac) => ev(`(async () => {
    const c = document.querySelector('#vmCv'); const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width * ${frac}, clientY: r.top + 200, bubbles: true }));
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const d = window.__vmDots || []; const body = document.querySelector('#memVm .mb-body');
    return { dots: d.map(x => ({ label: x.label, lane: x.lane, col: x.col, dy: x.ly - x.y })),
      dims: { cssW: c.clientWidth, cssH: c.clientHeight, attrW: c.width, attrH: c.height,
        bodyH: body.clientHeight, bodyScroll: body.scrollHeight },
      cursor: window.__vmCursor };
  })()`);
  const h1 = await hoverAt(0.18), h2 = await hoverAt(0.22);
  console.log('hover1 ' + JSON.stringify({ n: h1.dots.length, dims: h1.dims, cursor: h1.cursor }));
  console.log('hover2 ' + JSON.stringify({ n: h2.dots.length, dims: h2.dims, cursor: h2.cursor }));
  if (JSON.stringify(h1.dims) !== JSON.stringify(h2.dims)) throw new Error('鼠标移动导致画布尺寸变化');
  const dyBad = h1.dots.filter(a => {
    const b = h2.dots.find(x => x.label === a.label && x.lane === a.lane);
    return b && b.dy !== a.dy;
  });
  if (dyBad.length) throw new Error('鼠标移动导致标签上下跳动：' + dyBad.map(x => x.label).join(','));
  const by = { 0: [], 1: [] };
  h1.dots.concat(h2.dots).forEach(x => { if (by[x.lane] && !by[x.lane].includes(x.col)) by[x.lane].push(x.col); });
  console.log('hoverCols ' + JSON.stringify(by));
  if (by[0].length < 2) throw new Error('第 0 路只有 ' + by[0].length + ' 种曲线颜色');
  // 同一路内部每条曲线必须不同色；跨路用不同色段区分，不再靠虚线
  for (const [lane, frame] of [[0, h1], [1, h2]]) {
    const seen = new Map();
    frame.dots.filter(x => x.lane === lane).forEach(x => {
      if (seen.has(x.col) && seen.get(x.col) !== x.label) throw new Error('第 ' + lane + ' 路曲线重色');
      seen.set(x.col, x.label);
    });
  }
  // 底部换成轨迹：确认 spans 已加载，并悬停一个工具段能读到命令
  const trajInfo = await ev(`(() => ({
    eps: scopeDebug.state.lanes.map(l => l.vmTraj ? l.vmTraj.eps.length : 0),
    spans: scopeDebug.state.lanes.map(l => l.vmTraj
      ? Object.values(l.vmTraj.spans).reduce((a, s) => a + s.length, 0) : 0),
    hits: scopeDebug.vmTrajHits().length,
    hint: document.querySelector('#vmRead').textContent.slice(0, 40)
  }))()`);
  console.log('traj ' + JSON.stringify(trajInfo));
  if (!trajInfo.eps[0] || !trajInfo.spans[0] || !trajInfo.hits) throw new Error('per-VM 底部轨迹未加载');
  const toolHover = await ev(`(async () => {
    const h = scopeDebug.vmTrajHits()[0]; const c = document.querySelector('#vmCv'); const r = c.getBoundingClientRect();
    const px = (h.x0 + h.x1) / 2, py = (h.y0 + h.y1) / 2;
    c.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + px, clientY: r.top + py, bubbles: true }));
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const v = scopeDebug.vmHoverTrajRef();
    return { hit: !!v, cmd: v ? String(v.sp.cmd || '').slice(0, 90) : '',
      dbg: { last: scopeDebug.vmLastMoveRef(),
        direct: !!scopeDebug.vmTrajHits().find(x => px >= x.x0 && px <= x.x1 && py >= x.y0 && py <= x.y1),
        h: { x0: h.x0, x1: h.x1, y0: h.y0, y1: h.y1 }, px, py,
        rect: { left: r.left, top: r.top, w: r.width, h: r.height },
        near: scopeDebug.vmTrajHits().filter(x => Math.abs(x.y0 - h.y0) < 2).slice(0, 4)
          .map(x => ({ x0: x.x0, x1: x.x1, y0: x.y0 })) },
      read: document.querySelector('#vmRead').textContent.slice(0, 120) };
  })()`);
  console.log('toolHover ' + JSON.stringify(toolHover));
  if (!toolHover.hit || !toolHover.cmd) throw new Error('悬停工具段没有读到命令');

  // 轨迹↔沙箱配对：一条轨迹锁一个沙箱，轨迹色必须等于该沙箱曲线色
  const bind = await ev(`(() => scopeDebug.vmBindView())()`);
  console.log('bind ' + JSON.stringify(bind));
  for (const b of bind) {
    const ok = b.pairs.length === 4 && b.pairs.every(p => p.vm && p.col && p.deltaMs <= 30000);
    if (!ok) throw new Error('第 ' + b.lane + ' 路配对不全：' + JSON.stringify(b.pairs));
    const cols = new Set(b.pairs.map(p => p.col));
    if (cols.size !== 4) throw new Error('第 ' + b.lane + ' 路配对颜色重复');
  }
  // 配对曲线色必须 == 游标打点里那条沙箱的色
  const colMatch = await ev(`(() => {
    const pairs = scopeDebug.vmBindView()[0].pairs;
    const dots = window.__vmDots || [];
    return pairs.map(p => ({ samp: p.samp, vm: p.vm, col: p.col,
      dotCol: (dots.find(d => d.lane === 0 && d.label === p.vm) || {}).col }));
  })()`);
  console.log('colMatch ' + JSON.stringify(colMatch));
  for (const c of colMatch) if (c.dotCol && c.dotCol !== c.col) throw new Error('轨迹色与沙箱曲线色不一致：' + JSON.stringify(c));
  await shot(path.join(__dirname, 'shot_vm.png'));

  // 「全部沙箱」开关：默认关，只画配对曲线；打开后补画未配对沙箱
  const showAll = await ev(`(async () => {
    const before = (window.__vmDots || []).filter(d => d.lane === 0).length;
    const el = document.querySelector('#vmShowAll'); el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    const after = (window.__vmDots || []).filter(d => d.lane === 0).length;
    el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
    return { before, after, restored: (window.__vmDots || []).filter(d => d.lane === 0).length };
  })()`);
  console.log('showAll ' + JSON.stringify(showAll));
  if (!showAll.before || showAll.after <= showAll.before || showAll.restored !== showAll.before)
    throw new Error('全部沙箱开关未按预期补画：' + JSON.stringify(showAll));

  // 切指标
  await ev(`scopeDebug.vmSetMetric('cpu')`);
  await sleep(800);
  const vmCpu = await ev(`(() => { const d = scopeDebug.state.lanes[0].vmCache.data;
    return { m: scopeDebug.vmMetricRef(), topPeak: d.vms[0].peak, first3: d.vms.slice(0,3).map(v => v.peak) }; })()`);
  console.log('vm cpu ' + JSON.stringify(vmCpu));
  await shot(path.join(__dirname, 'shot_vm_cpu.png'));

  // 元数据对比的并发带（同一批 webdev 数据，带 per_vm 的 derived.fc_*）
  await ev(`scopeDebug.closeMemCmp(); scopeDebug.openMemCmp(); true`);
  await sleep(900);
  const mcInfo = await ev(`(() => {
    const ls = scopeDebug.memCmpLanes();
    const dmax = Math.max(...ls.map(({ l }) => { const r = l.payload.runs[0]; return 1; }));
    const peaks = ls.map(({ l }) => ({ tool: scopeDebug.memCmpConc(l, 3600e3, 60, 'tool').peak,
      all: scopeDebug.memCmpConc(l, 3600e3, 60, 'all').peak }));
    return { lanes: ls.length, sel: [...scopeDebug.memCmpSelRef()],
      hasFc: [...scopeDebug.memCmpSelRef()].filter(f => f.includes('fc_')), peaks };
  })()`);
  console.log('memcmp ' + JSON.stringify(mcInfo));
  await shot(path.join(__dirname, 'shot_mc_band.png'));

  // token 口径：加一路 swe 录制数据当基线
  await ev(`(async () => {
    scopeDebug.closeMemCmp();
    const j = await (await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ${JSON.stringify(SWE)} }) })).json();
    const lane = scopeDebug.addLane(null);
    scopeDebug.applyPayload(lane, j);
    lane.cmpRun = '*';
    scopeDebug.setScreen('compare');
    return j.runs.length;
  })()`);
  await sleep(1200);
  const tokInfo = await ev(`(() => {
    const cols = scopeDebug.cmpLaneCols();
    const bi = scopeDebug.baseCiOf(cols);
    const ep = cols[bi].eps.find(e => e.tok && e.tok.ct > 0);
    return { cols: cols.map(c => c.name), base: cols[bi].name,
      ep: ep ? { ct: ep.tok.ct, pt: ep.tok.pt, tps: ep.tok.tps, gen: ep.gen_s } : null,
      tpsOn: scopeDebug.state.cmpTok };
  })()`);
  console.log('tok ' + JSON.stringify(tokInfo));
  // 打开 token 重算，柱高应变化
  const before = await ev(`(() => { const cols = scopeDebug.cmpLaneCols(); const bi = scopeDebug.baseCiOf(cols);
    const bars = scopeDebug.chartRunBars(cols, bi); const c = bars.find(b => b.isBase).cells;
    const k = [...c.keys()][0]; return { k, ct: c.get(k).ct, g: c.get(k).g, n: c.get(k).n }; })()`);
  await ev(`(() => { const el = document.querySelector('#cmpTok'); el.checked = true;
    el.dispatchEvent(new Event('change')); return scopeDebug.state.cmpTok; })()`);
  await sleep(800);
  const after = await ev(`(() => ({ on: scopeDebug.state.cmpTok, tps: scopeDebug.state.cmpTps,
    hint: document.querySelector('#cmpHint').textContent.slice(0, 120),
    foot: document.querySelector('#cmpFoot').textContent.slice(0, 220) }))()`);
  console.log('tokBefore ' + JSON.stringify(before));
  console.log('tokAfter ' + JSON.stringify(after));
  // 点柱子的推理段，读数里应出现「按 110 tok/s 重算推理 …（原 …）」
  const readout = await ev(`(() => { const sg = document.querySelector('.sg.g'); if (!sg) return 'no-seg';
    sg.click(); return document.querySelector('#gcReadout').textContent.slice(-160); })()`);
  console.log('tokReadout ' + JSON.stringify(readout));
  await shot(path.join(__dirname, 'shot_tok.png'));

  // 再加一路回放数据：录制/回放同轨迹 token 数只差几十，ttft 差很多，
  // 正好用来验证「忽略首 token 等待」后两路柱子能不能对齐
  await ev(`(async () => {
    const j = await (await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ${JSON.stringify(REP)} }) })).json();
    const lane = scopeDebug.addLane(null);
    scopeDebug.applyPayload(lane, j);
    lane.cmpRun = '*';
    scopeDebug.renderCmp();
    return j.runs.length;
  })()`);
  await sleep(900);
  // 「忽略首 token 等待」：同 token 跨 run 应等高（gen = 完成 token ÷ tok/s）
  const tps = await ev('scopeDebug.state.cmpTps');
  const segExpr = `(() => [...document.querySelectorAll('#cmpChart .sg.g')]
    .filter(el => (el.dataset.row || '').includes('000122'))
    .map(el => ({ row: el.dataset.row, col: el.dataset.col, g: +el.dataset.g,
      ct: +el.dataset.ct, ttft: +el.dataset.ttft, n: +el.dataset.n })))()`;
  const segBefore = await ev(segExpr);
  await ev(`(() => { const el = document.querySelector('#cmpNoTtft');
    el.checked = true; el.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(700);
  const segAfter = await ev(segExpr);
  const noSt = await ev(`(() => ({ tok: scopeDebug.state.cmpTok, off: scopeDebug.state.cmpNoTtft,
    tokChecked: document.querySelector('#cmpTok').checked,
    offChecked: document.querySelector('#cmpNoTtft').checked,
    offDisabled: document.querySelector('#cmpNoTtft').disabled,
    saved: (() => { const k = Object.keys(localStorage).find(x => (localStorage.getItem(x) || '').includes('cmpNoTtft'));
      return k ? JSON.parse(localStorage.getItem(k)).cmpNoTtft : null; })(),
    hint: document.querySelector('#cmpHint').textContent.slice(0, 160) }))()`);
  console.log('noTtftSegs ' + JSON.stringify({ before: segBefore.slice(0, 8), after: segAfter.slice(0, 8) }));
  console.log('noTtftState ' + JSON.stringify(noSt));
  if (!noSt.tok || !noSt.off || !noSt.tokChecked || !noSt.offChecked || noSt.offDisabled || noSt.saved !== true)
    throw new Error('忽略首 token 等待开关状态不对：' + JSON.stringify(noSt));
  if (!noSt.hint.includes('忽略首 token 等待')) throw new Error('提示行没写重算口径：' + noSt.hint);
  if (!segBefore.length || segBefore.length !== segAfter.length) throw new Error('000122 柱段数量异常');
  let maxGapBefore = 0, maxGapAfter = 0, groupN = 0;
  const byRow = new Map();
  segBefore.forEach((s, i) => {
    if (Math.abs(s.g - (s.ct / tps + s.ttft)) > 0.6)
      throw new Error('开「忽略」前不是 ttft + token 口径：' + JSON.stringify(s));
    const a = segAfter[i];
    if (Math.abs(a.g - s.ct / tps) > 0.6)
      throw new Error('忽略后 gen 不等于 token ÷ 吞吐：' + JSON.stringify(a));
    if (Math.abs(s.g - a.g - s.ttft) > 0.6)
      throw new Error('忽略后没扣掉首 token 等待：' + JSON.stringify({ s, a }));
    const g = byRow.get(s.row) || []; g.push([s.g, a.g]); byRow.set(s.row, g);
  });
  for (const [, arr] of byRow) {
    if (arr.length < 2) continue;
    groupN++;
    maxGapBefore = Math.max(maxGapBefore, Math.max(...arr.map(x => x[0])) - Math.min(...arr.map(x => x[0])));
    maxGapAfter = Math.max(maxGapAfter, Math.max(...arr.map(x => x[1])) - Math.min(...arr.map(x => x[1])));
  }
  console.log('noTtftAlign ' + JSON.stringify({ groupN, maxGapBefore, maxGapAfter }));
  if (!groupN || maxGapBefore <= 5 || maxGapAfter >= 2)
    throw new Error('同 token 跨 run 没有对齐：' + JSON.stringify({ groupN, maxGapBefore, maxGapAfter }));
  const noRead = await ev(`(() => { const sg = [...document.querySelectorAll('#cmpChart .sg.g')]
    .find(el => (el.dataset.row || '').includes('000122'));
    if (!sg) return 'no-seg'; sg.click();
    return document.querySelector('#gcReadout').textContent.slice(-180); })()`);
  console.log('noTtftReadout ' + JSON.stringify(noRead));
  if (!noRead.includes('未计首 token 等待')) throw new Error('读数没说明忽略 ttft：' + noRead);
  await shot(path.join(__dirname, 'shot_tok_nottft.png'));
  // 反向联动：取消重算会清掉忽略开关；只勾忽略开关会自动打开重算
  const link = await ev(`(() => {
    const t = document.querySelector('#cmpTok'), n = document.querySelector('#cmpNoTtft');
    t.checked = false; t.dispatchEvent(new Event('change'));
    const a = { tok: scopeDebug.state.cmpTok, off: scopeDebug.state.cmpNoTtft, disabled: n.disabled };
    n.checked = true; n.dispatchEvent(new Event('change'));
    return { a, b: { tok: scopeDebug.state.cmpTok, off: scopeDebug.state.cmpNoTtft,
      tokChecked: t.checked, disabled: n.disabled } }; })()`);
  console.log('noTtftLink ' + JSON.stringify(link));
  if (link.a.tok || link.a.off || !link.a.disabled) throw new Error('取消重算没清掉忽略开关');
  if (!link.b.tok || !link.b.off || !link.b.tokChecked || link.b.disabled)
    throw new Error('只勾忽略开关没自动打开重算');
  await ev(`(() => { const t = document.querySelector('#cmpTok'); t.checked = false;
    t.dispatchEvent(new Event('change')); return true; })()`);

  const errs = await ev(`window.__errs || []`);
  console.log('runtime errors: ' + JSON.stringify(errs));

  // 没有 per_vm 段的 memlog（density2 那批旧采集）应给出可读原因，而不是空图
  const noVm = await ev(`(async () => {
    await scopeDebug.loadMemlogFile(0, 'C:\\\\Users\\\\MECHREVO\\\\Desktop\\\\develop_sandox\\\\display\\\\density2-20261123\\\\density2-20261123\\\\density2-dsec-cpu-0015\\\\memlog.jsonl');
    await scopeDebug.openMemVm();
    await new Promise(r => setTimeout(r, 1200));
    return { read: document.querySelector('#vmRead').textContent.slice(0, 160),
      list: document.querySelector('#vmList').textContent.slice(0, 160) };
  })()`);
  console.log('noPerVm ' + JSON.stringify(noVm));
  console.log('DONE');
  try { chrome.kill(); } catch (e) { }
  process.exit(0);
})().catch(e => { console.log('ERR ' + e.message); try { chrome.kill(); } catch (x) { } process.exit(1); });
