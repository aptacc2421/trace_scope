// 量并发带序列（工具/活跃）的分布，判断为什么带内几乎看不见东西
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9229;
const PROF = path.join(__dirname, 'chrome-prof-band');
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
  await sleep(800);
  const stat = await ev(`(() => {
    const ls = scopeDebug.memCmpLanes();
    const dmax = Math.max(...ls.map(({ l }) => {
      const r = scopeDebug.state.lanes[Object.values(scopeDebug.state.lanes).indexOf(l)].payload.runs.find(x => true);
      return 1; }));
    const out = [];
    for (const { l, i } of ls) {
      const r = l.payload.runs.find(x => x.id === l.runId) || l.payload.runs[0];
      const dur = Math.max(1, (r.end || 0) - (r.start || 0));
      const t = scopeDebug.memCmpConc(l, dur, 200, 'tool');
      const a = scopeDebug.memCmpConc(l, dur, 200, 'all');
      const st = (p) => ({ n: p.pts.length, peak: p.peak,
        nz: p.pts.filter(x => x[1] > 0).length,
        mean: +(p.pts.reduce((s, x) => s + x[1], 0) / p.pts.length).toFixed(2),
        head: p.pts.slice(0, 6).map(x => x[1]) });
      out.push({ lane: String.fromCharCode(65 + i), eps: r.episodes.length, dur,
        tool: st(t), all: st(a) });
    }
    return out;
  })()`);
  console.log(JSON.stringify(stat, null, 1));
  try { chrome.kill(); } catch (e) { }
  process.exit(0);
})().catch(e => { console.log('ERR ' + e.message); try { chrome.kill(); } catch (x) { } process.exit(1); });
