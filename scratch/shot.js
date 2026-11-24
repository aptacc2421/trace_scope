// 截图 + 基线/录制对齐核对
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9224;
const PROF = path.join(__dirname, 'chrome-prof-shot');
const BASE = 'http://127.0.0.1:8791';
const DISP = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display';
const DENSITY = DISP + '\\density2-20261123\\density2-20261123';
const MEM_RUN = DENSITY + '\\density2-dsec-mem-0515';
const CPU_MEMLOG = DENSITY + '\\density2-dsec-cpu-0015\\memlog.jsonl';
const MEM_MEMLOG = MEM_RUN + '\\memlog.jsonl';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
if (fs.existsSync(PROF)) fs.rmSync(PROF, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--no-first-run', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
  '--window-size=1680,1000', 'about:blank',
], { stdio: 'ignore' });

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
  // CURRENT_ROOT 必须先指向 density2 根目录，页面 boot 才会拿它当数据源
  await fetch(BASE + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: DENSITY }) });
  await sleep(400);
  const { targetId } = await send('Target.createTarget', { url: BASE + '/' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId, 60000);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  const waitFor = async (expr, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) { try { if (await ev(expr)) return; } catch (e) { } await sleep(250); }
    throw new Error('超时 ' + label);
  };
  const shot = async (file, clip) => {
    const r = await send('Page.captureScreenshot',
      clip ? { format: 'png', clip: { ...clip, scale: 2 }, captureBeyondViewport: false }
        : { format: 'png', captureBeyondViewport: false }, sessionId);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('shot ' + file);
  };

  await waitFor('!!(window.scopeDebug && scopeDebug.state.lanes[0] && scopeDebug.state.lanes[0].payload)', 60000, 'boot');
  await ev(`scopeDebug.setScreen('compare'); true`);
  await waitFor(`scopeDebug.state.lanes.some(l => l.autoBase && l.payload)`, 60000, 'record lane');
  await sleep(800);

  // 录制与回放的轨迹键是否真能对上
  const align = await ev(`(() => {
    const cols = scopeDebug.cmpLaneCols();
    const bi = scopeDebug.baseCiOf(cols);
    const bars = scopeDebug.chartRunBars(cols, bi);
    const base = bars.find(b => b.isBase);
    const rep = bars.find(b => !b.isBase);
    let both = 0, onlyBase = 0, onlyRep = 0, sumBase = 0, sumRep = 0, n = 0;
    for (const [k, c] of base.cells) {
      const r = rep.cells.get(k);
      if (r) { both++; sumBase += c.g + c.t; sumRep += r.g + r.t; n++; } else onlyBase++;
    }
    for (const k of rep.cells.keys()) if (!base.cells.has(k)) onlyRep++;
    const rows = scopeDebug.cmpData().rows.filter(r => r.cols[bi] && r.cols[0]);
    return { both, onlyBase, onlyRep, avgBase: +(sumBase / Math.max(1, n)).toFixed(1),
      avgRep: +(sumRep / Math.max(1, n)).toFixed(1), cmpRows: rows.length,
      sample: rows.slice(0, 3).map(r => ({ k: r.label, baseTool: +r.cols[bi].tool.toFixed(0), repTool: +r.cols[0].tool.toFixed(0) })) };
  })()`);
  console.log('align ' + JSON.stringify(align));
  await shot(path.join(__dirname, 'shot_cmp.png'));
  await shot(path.join(__dirname, 'shot_cmp_zoom.png'), { x: 0, y: 90, width: 1120, height: 400 });

  // 元数据对比：加载两路 memlog
  await ev(`(async () => {
    const j = await (await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ${JSON.stringify(MEM_RUN)} }) })).json();
    const lane = scopeDebug.addLane(null);
    scopeDebug.applyPayload(lane, j);
    return true;
  })()`);
  await waitFor(`scopeDebug.state.lanes.length === 3 && !!scopeDebug.state.lanes[2].payload`, 30000, 'mem lane');
  await ev(`(async () => {
    await scopeDebug.loadMemlogFile(0, ${JSON.stringify(CPU_MEMLOG)});
    await scopeDebug.loadMemlogFile(2, ${JSON.stringify(MEM_MEMLOG)});
    return true;
  })()`);
  await waitFor(`!!(scopeDebug.state.lanes[0].mem && scopeDebug.state.lanes[2].mem)`, 90000, 'memlogs');
  await ev(`scopeDebug.openMemCmp(); true`);
  await sleep(900);
  await shot(path.join(__dirname, 'shot_mc.png'));
  await shot(path.join(__dirname, 'shot_mc_zoom.png'), { x: 0, y: 0, width: 760, height: 420 });
  const rect = await ev(`(() => { const r = document.querySelector('#mcFields').getBoundingClientRect();
    return { x: 0, y: Math.round(r.top), width: 1680, height: Math.round(r.height) }; })()`);
  await shot(path.join(__dirname, 'shot_mc_fields.png'), rect);
  await shot(path.join(__dirname, 'shot_mc_badge.png'),
    { x: Math.max(0, rect.width - 560), y: rect.y - 30, width: 560, height: Math.min(240, rect.height + 30) });

  console.log('DONE');
  try { chrome.kill(); } catch (e) { }
  process.exit(0);
})().catch(e => { console.log('ERR ' + e.message); try { chrome.kill(); } catch (x) { } process.exit(1); });
