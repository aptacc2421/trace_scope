// 直读 canvas 像素 + 序列值，定位并发带画不出来在哪一步
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9231;
const PROF = path.join(__dirname, 'chrome-prof-px');
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
  await ev(`scopeDebug.openMemCmp(); true`);
  await sleep(900);
  const expr = `(() => {
    const ls = scopeDebug.memCmpLanes();
    const cv = document.querySelector('#mcCv');
    const ctx = cv.getContext('2d');
    const out = [];
    for (const { l, i } of ls) {
      const runObj = l.payload.runs.find(r => r.id === l.runId) || l.payload.runs[0];
      const durRun = Math.max(1, (runObj.end || 0) - (runObj.start || 0));
      const c = scopeDebug.memCmpConc(l, durRun, 60, 'all');
      out.push({ lane: String.fromCharCode(65 + i), runId: l.runId,
        runStart: runObj.start, runEnd: runObj.end || null, memT1: l.mem.t1,
        durRun, peak: c.peak, pts: c.pts.map(p => p[1]) });
    }
    const bg = [20, 24, 36];
    const rows = {};
    for (const y of [10, 16, 22, 28, 34, 50, 58, 66, 74]) {
      const img = ctx.getImageData(0, y, cv.width, 1).data;
      let n = 0, firstX = -1, lastX = -1;
      for (let x = 190; x < cv.width - 58; x++) {
        const p = [img[x * 4], img[x * 4 + 1], img[x * 4 + 2]];
        if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 8) {
          n++; if (firstX < 0) firstX = x; lastX = x;
        }
      }
      rows[y] = { n, firstX, lastX };
    }
    return { out, rows, cvH: cv.height, cvW: cv.width };
  })()`;
  console.log(JSON.stringify(await ev(expr), null, 1));
  try { chrome.kill(); } catch (e) { }
  process.exit(0);
})().catch(e => { console.log('ERR ' + e.message); try { chrome.kill(); } catch (x) { } process.exit(1); });
