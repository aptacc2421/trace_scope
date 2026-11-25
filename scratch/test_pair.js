// per 聚合菜单 + per-fc 改名 + fc/guest 同 VM 对照：CDP 真机验证
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9236;
const PROF = path.join(__dirname, 'chrome-prof-pair');
const BASE = 'http://127.0.0.1:8765';
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

  // 1) 聚合入口存在，旧的 per-VM / guest 按钮已移除，per-fc 名字进入面板标题
  const ui = await ev(`({
    perBtn: document.querySelector('#perBtn')?.textContent.trim(),
    perMenuBtns: [...document.querySelectorAll('#perMenu button')].map(b=>b.dataset.per),
    oldVmBtn: !!document.querySelector('#memVmBtn'),
    oldGuestBtn: !!document.querySelector('#memGuestBtn'),
    vmTitle: document.querySelector('#memVm .mb-h b')?.textContent.trim()
  })`);
  console.log('ui ' + JSON.stringify(ui));
  if (!ui.perBtn || !ui.perBtn.startsWith('per')) throw new Error('per 按钮缺失');
  if (JSON.stringify(ui.perMenuBtns) !== JSON.stringify(['fc', 'guest', 'pair', 'pervm', 'swe'])) throw new Error('per 菜单五项不对');
  if (ui.oldVmBtn || ui.oldGuestBtn) throw new Error('旧按钮仍在');
  if (ui.vmTitle !== 'per-fc 视图') throw new Error('面板未改名: ' + ui.vmTitle);

  // 点开菜单 → 点 guest 子项 → guest 面板可见
  await ev(`document.querySelector('#perBtn').click()`);
  const opened = await ev(`document.querySelector('#perHost').classList.contains('open')`);
  if (!opened) throw new Error('per 菜单没展开');
  await ev(`document.querySelector('#perMenu button[data-per="guest"]').click()`);
  console.log('menu guest click ok');

  // 2) 整目录加载：14 路，每路 mem+guest 都挂上
  const root = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display\\webdev-prof-usable-20261123';
  await ev(`scopeDebug.autoLoadAll(${JSON.stringify(root)})`);
  await waitFor(`scopeDebug.state.lanes.length === 14 && scopeDebug.gsGuestLanes().every(x => x.l.guestCache)`, 180000, 'autoload');
  console.log('autoload 14 lanes ok');

  // 3) 打开对照视图（走菜单 pair 子项），验证配对
  await ev(`document.querySelector('#perBtn').click()`);
  await ev(`document.querySelector('#perMenu button[data-per="pair"]').click()`);
  // 等所有 14 路都算完 pairData（reloadMemPair 是异步串行循环，早读会漏）
  await waitFor(`scopeDebug.pairLanes().filter(x=>x.l.pairData).length === 14`, 180000, 'pair data all lanes');
  const view = await ev(`scopeDebug.pairView()`);
  console.log('pair view lanes ' + view.length);
  let pairTotal = 0;
  view.forEach(v => {
    console.log('  lane' + v.lane + ' key=' + v.key + ' pairs=' + v.pairs.length +
      ' matched=' + v.pairs.filter(p => p.vm && p.guest).length);
    pairTotal += v.pairs.filter(p => p.vm && p.guest).length;
  });
  if (pairTotal < 4) throw new Error('配对数太少: ' + pairTotal + '，fc/guest 未按 samp 对上');
  const vis = await ev(`getComputedStyle(document.querySelector('#memPair')).display`);
  if (vis === 'none') throw new Error('对照面板没显示');
  // 同一 pair 内 fc 与 guest 同色（col 一致天然保证，因为一个对象里 col 单一）
  const colOk = await ev(`scopeDebug.pairView().every(v => v.pairs.every(p => typeof p.col === 'string' && p.col.length >= 6))`);
  if (!colOk) throw new Error('pair 颜色无效');

  // 4) 切对照字段 anon → file，找一条有 smaps 数据的路比较峰值（有些 run 的 smaps 全 0）。
  // 现在默认是 rss，先显式切到 anon 再找有数据的路。
  await ev(`scopeDebug.pairSetField('anon')`);
  await waitFor(`scopeDebug.pairKeyRef() === 'anon' && scopeDebug.pairView().filter(x=>x.key==='anon').length === 14`, 90000, 'set anon');
  const withData = await ev(`(() => {
    const v = scopeDebug.pairView();
    return v.findIndex(x => x.pairs.some(p => p.fcPeak > 0));
  })()`);
  console.log('lane with smaps data: ' + withData);
  if (withData < 0) throw new Error('没有任何路有 smaps 数据，无法验证字段切换');
  const before = await ev(`scopeDebug.pairView()[${withData}].pairs.map(p=>p.fcPeak)`);
  await ev(`scopeDebug.pairSetField('file')`);
  await waitFor(`scopeDebug.pairView()[${withData}] && scopeDebug.pairView()[${withData}].key === 'file' && scopeDebug.pairView()[${withData}].pairs.some(p=>p.fcPeak>0)`, 60000, 'pair field');
  const after = await ev(`scopeDebug.pairView()[${withData}].pairs.map(p=>p.fcPeak)`);
  console.log('anon fcPeak ' + JSON.stringify(before));
  console.log('file fcPeak ' + JSON.stringify(after));
  if (JSON.stringify(before) === JSON.stringify(after)) throw new Error('切对照字段后 fc 峰值没变');
  await ev(`scopeDebug.pairSetField('rss')`);
  await shot(path.join(__dirname, 'shot_pair.png'));

  console.log('runtime errors: ' + JSON.stringify(rtErrors));
  if (rtErrors.length) throw new Error('有运行时错误');
  console.log('DONE');
  chrome.kill();
  ws.close();
  process.exit(0);
})().catch(e => { console.error('ERR ' + e.message); chrome.kill(); process.exit(1); });
