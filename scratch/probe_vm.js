// 量 per-VM 画布实际尺寸与内容高度
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9228;
const PROF = path.join(__dirname, 'chrome-prof-probe');
const BASE = 'http://127.0.0.1:8791';
const ROOT = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display\\webdev-prof-usable-20261123';
const M1 = ROOT + '\\webdev-64-g4\\host\\memlog.jsonl';
const M2 = ROOT + '\\webdev-plumbing-g4\\host\\memlog.jsonl';
const R2 = ROOT + '\\webdev-plumbing-g4';
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
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && wait.has(m.id)) { const { res, rej } = wait.get(m.id); wait.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } };
  const send = (method, params, sid, tmo) => { const i = ++id; return new Promise((res, rej) => { const t = setTimeout(() => { wait.delete(i); rej(new Error('CDP 超时 ' + method)); }, tmo || 30000); wait.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId: sid })); }); };
  await fetch(BASE + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ROOT }) });
  const { targetId } = await send('Target.createTarget', { url: BASE + '/' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId); await send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId, 120000); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
  const waitFor = async (expr, ms, label) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 60000)) { try { if (await ev(expr)) return; } catch (e) { } await sleep(300); } throw new Error('超时 ' + label); };
  await waitFor('!!(window.scopeDebug && scopeDebug.state.lanes[0] && scopeDebug.state.lanes[0].payload)', 90000, 'boot');
  await ev(`(async () => {
    scopeDebug.state.lanes[0].runId = 'webdev-64-g4';
    const j = await (await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: ${JSON.stringify(R2)} }) })).json();
    const lane = scopeDebug.addLane(null); scopeDebug.applyPayload(lane, j); lane.runId = 'webdev-plumbing-g4';
    await scopeDebug.loadMemlogFile(0, ${JSON.stringify(M1)});
    await scopeDebug.loadMemlogFile(1, ${JSON.stringify(M2)});
    return true;
  })()`);
  await waitFor(`!!(scopeDebug.state.lanes[0].mem && scopeDebug.state.lanes[1].mem)`, 120000, 'memlogs');
  await ev(`scopeDebug.openMemVm(); true`);
  await waitFor(`!!(scopeDebug.state.lanes[0].vmCache && scopeDebug.state.lanes[1].vmCache)`, 120000, 'vm');
  await sleep(500);
  const dims = await ev(`(() => { const c = document.querySelector('#vmCv');
    const body = document.querySelector('#memVm .mb-body');
    return { cssW: c.clientWidth, cssH: c.clientHeight, attrW: c.width, attrH: c.height,
      bodyH: body.clientHeight, bodyScroll: body.scrollHeight,
      live: scopeDebug.state.lanes.map(l => l.vmCache ? l.vmCache.data.n_live : null) }; })()`);
  console.log('dims ' + JSON.stringify(dims));
  const rect = await ev(`(() => { const r = document.querySelector('#vmCv').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  const png = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: true }, sessionId);
  fs.writeFileSync(path.join(__dirname, 'shot_vm_canvas.png'), Buffer.from(png.data, 'base64'));
  const full = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.writeFileSync(path.join(__dirname, 'shot_vm_full.png'), Buffer.from(full.data, 'base64'));
  console.log('canvas rect ' + JSON.stringify(rect));
  console.log('dbg ' + JSON.stringify(await ev('window.__vmDbg || null')));
  console.log('dbg ' + JSON.stringify(await ev('window.__vmDbg || null')));
  try { chrome.kill(); } catch (e) { }
  process.exit(0);
})().catch(e => { console.log('ERR ' + e.message); try { chrome.kill(); } catch (x) { } process.exit(1); });
