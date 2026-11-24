// 冒烟：对比视图三种形态（总览/split/宽表）都不报错，宽表倍数以录制为基线
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9226;
const PROF = path.join(__dirname, 'chrome-prof-smoke');
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
  let id = 0; const wait = new Map(); const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception || {}).description);
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
  await fetch(BASE + '/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: DENSITY }) });
  await sleep(400);
  const { targetId } = await send('Target.createTarget', { url: BASE + '/' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId, 60000);
    if (r.exceptionDetails) throw new Error('页面异常 ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
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

  const out = {};
  out.chart = await ev(`({ bars: document.querySelectorAll('#cmpChart .gc-bar').length,
    base: document.querySelectorAll('#cmpChart .gc-bar.base').length,
    hint: document.querySelector('#cmpHint').textContent })`);

  await ev(`scopeDebug.state.cmpSplit = true; scopeDebug.renderCmp(); true`);
  await sleep(400);
  out.split = await ev(`({ cols: document.querySelectorAll('#cmpChart .gsp-col').length,
    title: (document.querySelector('.gsp-nav .ttl') || {}).textContent })`);

  await ev(`scopeDebug.state.cmpSplit = false; scopeDebug.state.cmpView = 'table'; scopeDebug.renderCmp(); true`);
  await sleep(400);
  out.table = await ev(`(() => {
    const rows = document.querySelectorAll('#cmpTable tr');
    const head = [...document.querySelectorAll('#cmpTable tr')[1].children].map(th => th.textContent);
    const hints = document.querySelector('#cmpHint').textContent;
    return { rows: rows.length, head: head.slice(0, 9), hint: hints };
  })()`);

  await ev(`scopeDebug.state.cmpView = 'chart'; scopeDebug.renderCmp(); true`);
  await ev(`scopeDebug.setScreen('scope'); true`);
  await sleep(500);
  out.scope = await ev(`({ lanes: document.querySelectorAll('#lanes > .lane:not([style*="none"])').length,
    view: scopeDebug.state.view ? +((scopeDebug.state.view.t1 - scopeDebug.state.view.t0) / 3.6e6).toFixed(1) : null })`);

  console.log(JSON.stringify(out, null, 1));
  console.log('runtime errors: ' + JSON.stringify(errors));
  try { chrome.kill(); } catch (e) { }
  process.exit(errors.length ? 2 : 0);
})().catch(e => { console.log('ERR ' + e.message); try { chrome.kill(); } catch (x) { } process.exit(1); });
