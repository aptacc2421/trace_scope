// pervm-12 逐 VM 对照视图：CDP 真机验证
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9241;
const PROF = path.join(__dirname, 'chrome-prof-pervm');
const BASE = 'http://127.0.0.1:8766';
const ROOT = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display\\pervm-12';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
if (fs.existsSync(PROF)) fs.rmSync(PROF, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  '--no-first-run', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
  '--window-size=1680,1000', 'about:blank'], { stdio: 'ignore' });

(async () => {
  let ver = null;
  for (let i = 0; i < 80; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (e) { await sleep(250); } }
  if (!ver) throw new Error('chrome 未启动');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map();
  const rtErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') rtErrors.push(JSON.stringify(m.params.exceptionDetails).slice(0, 400));
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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800));
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

  // 1) per 菜单含第四项 pervm
  const menu = await ev(`[...document.querySelectorAll('#perMenu button')].map(b=>b.dataset.per)`);
  console.log('menu ' + JSON.stringify(menu));
  if (!menu.includes('pervm')) throw new Error('pervm 菜单项缺失');

  // 2) 打开 pervm 面板
  await ev(`document.querySelector('#perBtn').click()`);
  await ev(`document.querySelector('#perMenu button[data-per="pervm"]').click()`);
  await waitFor(`scopeDebug.pvmState().open`, 10000, 'pervm panel open');
  console.log('panel open ok');

  // 3) 设 root → 加载数据
  const ok = await ev(`scopeDebug.pvmSetRoot(${JSON.stringify(ROOT)})`);
  if (!ok) throw new Error('pervm 数据加载失败');
  await waitFor(`scopeDebug.pvmState().vms > 0`, 10000, 'pervm vms');
  const st = await ev(`scopeDebug.pvmState()`);
  console.log('state ' + JSON.stringify({ n: st.n, guest: st.nGuest, host: st.nHost, vms: st.vms, fields: st.fields }));
  if (st.vms < 50) throw new Error('VM 数太少: ' + st.vms);
  if (st.nGuest < 30 || st.nHost < 30) throw new Error('guest/host 数不对');
  if (JSON.stringify(st.fields) !== JSON.stringify(['used', 'anon', 'file', 'shmem', 'swap'])) throw new Error('字段组不对');

  // 4) 找一个两侧都有的 VM，验证出图与读数
  const bothIdx = await ev(`(() => {
    const s = scopeDebug.pvmState();
    for (let i = 0; i < s.vms; i++) { scopeDebug.pvmSetVm(i); const v = scopeDebug.pvmView(); if (v && v.hasGuest && v.hasHost && v.guestN > 5 && v.hostN > 5) return i; }
    return -1;
  })()`);
  if (bothIdx < 0) throw new Error('没有两侧都有数据的 VM');
  await ev(`scopeDebug.pvmSetVm(${bothIdx})`);
  const v = await ev(`scopeDebug.pvmView()`);
  console.log('vm view ' + JSON.stringify(v));
  if (!v.guestN || !v.hostN) throw new Error('曲线点数为空');
  if (!(v.guestPeak > 0) || !(v.hostPeak > 0)) throw new Error('峰值为 0');
  const read = (await ev(`scopeDebug.pvmState().read`));
  console.log('readout ' + read);
  if (!read.includes('guest 峰值') || !read.includes('host 峰值')) throw new Error('读数行缺失');

  // 5) 切字段 anon → file，峰值应变化
  await ev(`scopeDebug.pvmSetField('anon')`);
  const va = await ev(`scopeDebug.pvmView()`);
  await ev(`scopeDebug.pvmSetField('file')`);
  const vf = await ev(`scopeDebug.pvmView()`);
  console.log('field switch anon guestPeak=' + va.guestPeak + ' file guestPeak=' + vf.guestPeak);
  if (va.guestField !== 'AnonPages_mb' || vf.guestField !== 'Cached_mb') throw new Error('字段映射不对');
  if (va.guestPeak === vf.guestPeak) throw new Error('切字段后 guest 峰值没变');
  await ev(`scopeDebug.pvmSetField('used')`);

  // 6) 找一个仅 host 的 VM（000803 或残留），验证单侧提示
  const hostOnly = await ev(`(() => {
    const s = scopeDebug.pvmState();
    for (let i = 0; i < s.vms; i++) { scopeDebug.pvmSetVm(i); const v = scopeDebug.pvmView(); if (v && v.hasHost && !v.hasGuest) return i; }
    return -1;
  })()`);
  console.log('hostOnly idx ' + hostOnly);
  if (hostOnly >= 0) {
    const vh = await ev(`scopeDebug.pvmView()`);
    if (!(vh.hostN > 0)) throw new Error('host-only VM 没有 host 数据');
    const rd = await ev(`scopeDebug.pvmState().read`);
    if (!rd.includes('只有单侧')) throw new Error('单侧提示缺失');
  }

  await ev(`scopeDebug.pvmSetVm(${bothIdx})`);
  await shot(path.join(__dirname, 'shot_pervm.png'));
  console.log('runtime errors: ' + JSON.stringify(rtErrors));
  if (rtErrors.length) throw new Error('有运行时错误');
  console.log('DONE');
  chrome.kill();
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR ' + e.message); chrome.kill(); process.exit(1); });
