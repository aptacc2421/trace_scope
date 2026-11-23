// 单路元数据的并发带 + per-VM 曲线的直标（真机 CDP）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9231;
const PROF = path.join(__dirname, 'chrome-prof-readout');
const BASE = 'http://127.0.0.1:8791';
const ROOT = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display\\webdev-prof-usable-20261123';
const M1 = ROOT + '\\webdev-64-g4\\host\\memlog.jsonl';
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
  const shot = async (name) => {
    const png = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(png.data, 'base64'));
    console.log('shot ' + name);
  };
  await waitFor('!!(window.scopeDebug && scopeDebug.state.lanes[0] && scopeDebug.state.lanes[0].payload)', 90000, 'boot');
  await ev(`(async () => {
    scopeDebug.state.lanes[0].runId = 'webdev-64-g4';
    await scopeDebug.loadMemlogFile(0, ${JSON.stringify(M1)});
    return true;
  })()`);
  await waitFor('!!scopeDebug.state.lanes[0].mem', 120000, 'memlog');

  // A. 单路元数据：顶部并发带
  await ev('scopeDebug.openMemBig(0); true');
  await sleep(600);
  const band = await ev(`(() => { const c = scopeDebug.memBigConcRef();
    return c ? { toolPeak: c.toolS.peak, allPeak: c.allS.peak, n: c.toolS.pts.length,
      first: c.toolS.pts.slice(0, 3), read: document.querySelector('#mbRead').textContent.slice(0, 120) } : null; })()`);
  console.log('band ' + JSON.stringify(band));
  const hover = await ev(`(() => { const c = document.querySelector('#mbCv'); const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width * 0.55, clientY: r.top + 60, bubbles: true }));
    return document.querySelector('#mbRead').textContent.slice(0, 200); })()`);
  console.log('mbRead ' + JSON.stringify(hover));
  await shot('shot_membig_conc.png');

  // B. per-VM：曲线直标
  await ev('scopeDebug.openMemVm(); true');
  await waitFor('!!(scopeDebug.state.lanes[0].vmCache && window.__vmTags)', 120000, 'vm');
  await sleep(400);
  const tags = await ev('window.__vmTags || []');
  console.log('vmTags ' + JSON.stringify({ n: tags.length, top: tags.slice(0, 6) }));
  const vhover = await ev(`(() => { const c = document.querySelector('#vmCv'); const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width * 0.62, clientY: r.top + 200, bubbles: true }));
    return document.querySelector('#vmRead').textContent.slice(0, 220); })()`);
  console.log('vmRead ' + JSON.stringify(vhover));
  await shot('shot_vm_tags.png');

  const errs = await ev('window.__errs || []');
  console.log('runtime errors: ' + JSON.stringify(errs));
  console.log('DONE');
  try { chrome.kill(); } catch (e) { }
  process.exit(0);
})().catch(e => { console.log('ERR ' + e.message); try { chrome.kill(); } catch (x) { } process.exit(1); });
