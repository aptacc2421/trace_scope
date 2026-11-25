// SWE 负载总览 + 逐 VM episode 对照：CDP 真机验证
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9243;
const PROF = path.join(__dirname, 'chrome-prof-swe');
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
  const ok = [];
  const check = (name, cond, info) => { ok.push([name, !!cond]); console.log((cond ? 'PASS ' : 'FAIL ') + name + (info ? ' :: ' + info : '')); };

  try {
    await sleep(2500);
    // 菜单 5 项
    const menu = await ev(`[...document.querySelectorAll('#perMenu button')].map(b=>b.dataset.per)`);
    check('per 菜单五项', JSON.stringify(menu) === JSON.stringify(['fc','guest','pair','pervm','swe']), JSON.stringify(menu));

    // ===== 负载总览 =====
    await ev(`window.scopeDebug.openMemSwe()`);
    await sleep(6000);
    let v = await ev(`window.scopeDebug.sweView()`);
    check('总览面板打开', v.open, JSON.stringify({open:v.open, n:v.n}));
    check('总览 48 episode / 42 采样 / 12 issue', v.n === 48 && v.nMem === 42 && v.nIssue === 12,
      JSON.stringify({n:v.n, nMem:v.nMem, nIssue:v.nIssue}));
    check('默认按 issue 12 行', v.rows.length === 12, 'rows=' + v.rows.length);
    check('每行有堆叠段', v.rows.every(r => r.segs.length >= 2), JSON.stringify(v.rows[0] && v.rows[0].segs));
    check('行读数含 MB/步/秒', v.rows.every(r => /MB/.test(r.txt) && /步/.test(r.txt) && /s/.test(r.txt)), v.rows[0] && v.rows[0].txt);
    console.log('  样例行:', v.rows[0] && v.rows[0].k, v.rows[0] && v.rows[0].txt);
    console.log('  样例段:', v.rows[0] && JSON.stringify(v.rows[0].segs.slice(0,4)));

    // 切 episode 视图
    await ev(`window.scopeDebug.sweSetMode('episode')`);
    await sleep(500);
    v = await ev(`window.scopeDebug.sweView()`);
    check('按 episode 48 行', v.rows.length === 48, 'rows=' + v.rows.length);
    check('episode 行含 stop_reason', v.rows.some(r => /done|timeout|limit|error/i.test(r.txt)), v.rows[0] && v.rows[0].txt);

    // 002980 s1：页缓存是主要成分，堆叠条必须出现页缓存段且宽度不溢出
    const t = v.rows.find(r => r.k === 'format-code-task-002980#1');
    check('002980 s1 行存在', !!t, t && t.txt);
    check('002980 s1 显示页缓存段', !!t && t.segs.some(s => /页缓存 \d/.test(s)), t && JSON.stringify(t.segs));
    check('002980 s1 堆叠不溢出', !!t && t.segw.reduce((a, b) => a + b, 0) <= 100.5,
      t && JSON.stringify(t.segw));
    check('细项提示包含 Shmem/Mapped/可回收 Slab', !!t && /共享内存/.test(t.detail || '') && /Mapped/.test(t.detail || '') && /可回收/.test(t.detail || ''),
      t && t.detail);
    await send('Page.captureScreenshot', { format: 'png' }, sessionId).then(r => {
      fs.writeFileSync(path.join(__dirname, 'shot_swe_episode.png'), Buffer.from(r.data, 'base64'));
    });

    // 排序切换
    await ev(`window.scopeDebug.sweSetSort('steps')`);
    await sleep(300);
    const s1 = await ev(`window.scopeDebug.sweView().rows.slice(0,3).map(r=>r.txt)`);
    await ev(`window.scopeDebug.sweSetSort('used')`);
    await sleep(300);
    const s2 = await ev(`window.scopeDebug.sweView().rows.slice(0,3).map(r=>r.txt)`);
    check('排序切换改变顺序', JSON.stringify(s1) !== JSON.stringify(s2), JSON.stringify({steps:s1, used:s2}));

    // 截图（issue 视图）
    await ev(`window.scopeDebug.sweSetMode('issue'); window.scopeDebug.sweSetSort('used')`);
    await sleep(400);
    await send('Page.captureScreenshot', { format: 'png' }, sessionId).then(r => {
      fs.writeFileSync(path.join(__dirname, 'shot_swe.png'), Buffer.from(r.data, 'base64'));
    });

    // ===== 逐 VM episode 对照 =====
    await ev(`document.querySelector('#memSwe #sweClose').click()`);
    await ev(`window.scopeDebug.openMemPerVm()`);
    await sleep(6000);
    const pvm = await ev(`window.scopeDebug.pvmState()`);
    check('逐VM 面板打开且有 VM', pvm.open && pvm.vms > 0, JSON.stringify({open:pvm.open, vms:pvm.vms}));
    // 找一个有 episode 配对的 sandbox：pvmData 的 label 含 issue 号，逐个切直到读数里出现「第 N 步/episode」
    const epHit = await ev(`(async () => {
      const D = window.scopeDebug;
      for (let i = 0; i < 90; i++) {
        await D.pvmSetVm(i);
        const note = document.querySelector('#pvmLegend').textContent;
        if (/01a20e46|000122/.test(note)) return { i, note };
      }
      return null;
    })()`);
    console.log('  episode 配对 VM:', JSON.stringify(epHit));
    // 把游标移到画布中部，验证读数出现 step 信息
    await ev(`(() => {
      const cv = document.querySelector('#pvmCv');
      const r = cv.getBoundingClientRect();
      cv.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + r.width * 0.55, clientY: r.top + r.height * 0.3, bubbles: true }));
    })()`);
    await sleep(400);
    const r0 = await ev(`window.scopeDebug.pvmState().read`);
    console.log('  逐VM 读数(游标):', r0);
    check('逐VM episode 对照可读', /步|episode|guest 峰值/.test(r0), r0);
    await send('Page.captureScreenshot', { format: 'png' }, sessionId).then(r => { fs.writeFileSync(path.join(__dirname, 'shot_swe_pervm.png'), Buffer.from(r.data, 'base64')); });

    check('无运行时错误', rtErrors.length === 0, rtErrors.slice(0,3).join(' | '));
  } catch (e) {
    console.log('ERROR:', e.message);
    check('测试流程无异常', false, e.message);
  } finally {
    console.log('\n结果: ' + ok.filter(x=>x[1]).length + '/' + ok.length + ' 通过');
    ws.close(); chrome.kill();
    process.exit(ok.every(x=>x[1]) ? 0 : 1);
  }
})();
