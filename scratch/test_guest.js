// guest.csv 接入 + 整目录一键加载：真机（CDP）验证
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9231;
const PROF = path.join(__dirname, 'chrome-prof-guest');
const BASE = 'http://127.0.0.1:8791';
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
  const rtErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') rtErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 300));
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
  const { targetId } = await send('Target.createTarget', { url: BASE + '/' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId, 180000);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
  };
  const waitFor = async (expr, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 90000)) { try { if (await ev(expr)) return; } catch (e) { } await sleep(300); }
    throw new Error('超时 ' + label);
  };
  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('shot ' + path.basename(file));
  };

  await waitFor('!!(window.scopeDebug && scopeDebug.state && scopeDebug.state.lanes)', 90000, 'boot');
  console.log('boot ok');

  // 整目录一键加载：直接传入 webdev 根目录
  const root = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display\\webdev-prof-usable-20261123';
  console.log('root ' + root);
  await ev(`scopeDebug.autoLoadAll(${JSON.stringify(root)})`);
  await waitFor(`scopeDebug.gsGuestLanes().length >= 2 &&
    scopeDebug.gsGuestLanes().every(x => x.l.guestCache)`, 180000, 'autoload');
  const view = await ev(`scopeDebug.gsView()`);
  console.log('guest lanes ' + view.length);
  view.forEach(v => console.log('  lane' + v.lane, v.label, 'err=' + v.err,
    'trajs=' + v.trajs.length, 'samps=' + v.trajs.map(t => t.samp).join(','),
    'colors=' + new Set(v.trajs.map(t => t.col)).size));
  if (view.length < 2) throw new Error('guest 路数不足');
  for (const v of view) {
    if (v.err) throw new Error('guest 读取错误 ' + v.err);
    if (v.trajs.length !== 4) throw new Error('期望 4 条轨迹，实际 ' + v.trajs.length);
    if (new Set(v.trajs.map(t => t.col)).size !== 4) throw new Error('同路颜色重复');
  }
  // 每路都该同时挂上 memlog（整目录加载把三类数据都装上）
  const assets = await ev(`(() => {
    const ls = scopeDebug.state.lanes;
    return ls.slice(0, scopeDebug.gsGuestLanes().length).map((l,i) => ({
      lane:i, runs:l.payload?l.payload.runs.length:0,
      mem:!!l.mem, guest:!!l.guest,
      memlog:(l.mem&&l.mem.path||'').split(/[\\\\/]/).pop()
    }));
  })()`);
  console.log('assets ' + JSON.stringify(assets));
  for (const a of assets) {
    if (!a.mem) throw new Error('lane' + a.lane + ' 没挂 memlog');
    if (!a.guest) throw new Error('lane' + a.lane + ' 没挂 guest');
  }

  // 面板可见 + 字段切换
  const vis = await ev(`getComputedStyle(document.querySelector('#memGuest')).display`);
  if (vis === 'none') throw new Error('guest 面板没显示');
  const f0 = await ev(`scopeDebug.gsFieldRef()`);
  const nOpts = await ev(`document.querySelector('#gsField').options.length`);
  console.log('field ' + f0 + ' options ' + nOpts);
  if (nOpts < 10) throw new Error('字段下拉太少');
  const before = await ev(`scopeDebug.gsView()[0].trajs.map(t=>t.peak)`);
  await ev(`scopeDebug.gsSetField('cached_kb')`);
  const after = await ev(`scopeDebug.gsView()[0].trajs.map(t=>t.peak)`);
  console.log('anon peaks ' + JSON.stringify(before));
  console.log('cached peaks ' + JSON.stringify(after));
  if (JSON.stringify(before) === JSON.stringify(after)) throw new Error('切字段后峰值没变');
  await ev(`scopeDebug.gsSetField('anon_kb')`);
  await shot(path.join(__dirname, 'shot_guest.png'));

  console.log('runtime errors: ' + JSON.stringify(rtErrors));
  if (rtErrors.length) throw new Error('有运行时错误');
  console.log('DONE');
  chrome.kill();
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR ' + e.message); chrome.kill(); process.exit(1); });
