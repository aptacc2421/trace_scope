// 核对对比图 DOM：每条轨迹是否基线柱在最左、柱高关系是否合理
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9225;
const PROF = path.join(__dirname, 'chrome-prof-dom');
const BASE = 'http://127.0.0.1:8791';
const DISP = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display';
const DENSITY = DISP + '\\density2-20261123\\density2-20261123';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
if (fs.existsSync(PROF)) fs.rmSync(PROF, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF, '--window-size=1680,1000', 'about:blank'], { stdio: 'ignore' });

(async () => {
  let ver = null;
  for (let i = 0; i < 80; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (e) { await sleep(250); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && wait.has(m.id)) { const { res, rej } = wait.get(m.id); wait.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
  const send = (method, params, sid, tmo) => {
    const i = ++id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { wait.delete(i); rej(new Error('CDP 超时 ' + method)); }, tmo || 30000);
      wait.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId: sid }));
    });
  };
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
  await waitFor('!!(window.scopeDebug && scopeDebug.state.lanes[0] && scopeDebug.state.lanes[0].payload)', 60000, 'boot');
  await ev(`scopeDebug.setScreen('compare'); true`);
  await waitFor(`scopeDebug.state.lanes.some(l => l.autoBase && l.payload)`, 60000, 'record');
  await sleep(800);
  const dom = await ev(`(() => {
    const trajs = [...document.querySelectorAll('#cmpChart .gc-traj')];
    const info = trajs.slice(0, 6).map(t => {
      const bars = [...t.querySelectorAll('.gc-bar')];
      return {
        n: bars.length,
        cls: bars.map(b => b.className.replace('gc-bar', '').trim()),
        h: bars.map(b => +b.style.height.replace('px', '')),
        title: bars[0] ? bars[0].title : ''
      };
    });
    const multi = trajs.filter(t => t.querySelectorAll('.gc-bar').length > 2).length;
    const baseFirst = trajs.filter(t => { const b = t.querySelector('.gc-bar'); return b && b.classList.contains('base'); }).length;
    return { trajs: trajs.length, multi, baseFirst, info };
  })()`);
  console.log(JSON.stringify(dom, null, 1));
  try { chrome.kill(); } catch (e) { }
  process.exit(0);
})().catch(e => { console.log('ERR ' + e.message); try { chrome.kill(); } catch (x) { } process.exit(1); });
