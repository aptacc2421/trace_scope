// 真机验证：①基线默认取录制目录；②手选基线能持久化；③元数据对比默认按波形差异选字段
// 用「新开标签页」代替 reload：reload 会让已 attach 的 CDP 会话收不到回包。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9223;
const PROF = path.join(__dirname, 'chrome-prof-base');
const BASE = 'http://127.0.0.1:8791';
const DISP = 'C:\\Users\\MECHREVO\\Desktop\\develop_sandox\\display';
const DENSITY = DISP + '\\density2-20261123\\density2-20261123';
const MEM_RUN = DENSITY + '\\density2-dsec-mem-0515';
const CPU_MEMLOG = DENSITY + '\\density2-dsec-cpu-0015\\memlog.jsonl';
const MEM_MEMLOG = MEM_RUN + '\\memlog.jsonl';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fails = [];
const ok = (cond, msg, extra) => {
  if (cond) console.log('  ok  ' + msg + (extra === undefined ? '' : '  ' + JSON.stringify(extra)));
  else { fails.push(msg + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); console.log('  FAIL ' + msg + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
};

if (fs.existsSync(PROF)) fs.rmSync(PROF, { recursive: true, force: true });
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROF,
  '--window-size=1680,1000', 'about:blank',
], { stdio: 'ignore' });
setTimeout(() => { console.log('WATCHDOG 超时退出'); try { chrome.kill(); } catch (e) { } process.exit(3); }, 300000);

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.wait = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.wait.has(m.id)) {
        const { res, rej } = c.wait.get(m.id);
        c.wait.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
    return c;
  }
  send(method, params, sessionId, timeoutMs) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.wait.delete(id);
        rej(new Error('CDP 超时 ' + method));
      }, timeoutMs || 30000);
      this.wait.set(id, {
        res: (v) => { clearTimeout(timer); res(v); },
        rej: (e) => { clearTimeout(timer); rej(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
    });
  }
}

(async () => {
  let ver = null;
  for (let i = 0; i < 60; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch (e) { await sleep(250); }
  }
  if (!ver) throw new Error('chrome 调试端口未就绪');
  const cdp = await CDP.connect(ver.webSocketDebuggerUrl);
  let S = null;

  async function newPage() {
    const { targetId } = await cdp.send('Target.createTarget', { url: BASE + '/' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    S = sessionId;
    return sessionId;
  }
  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true }, S, 45000);
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  };
  const waitFor = async (expr, ms, label) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 30000)) {
      try { if (await evalJs(expr)) return true; } catch (e) { /* 页面切换中 */ }
      await sleep(250);
    }
    throw new Error('超时: ' + label);
  };
  const pinDensity = `(async () => {
    const j = await (await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: ${JSON.stringify(DENSITY)} }) })).json();
    scopeDebug.applyPayload(scopeDebug.state.lanes[0], j);
    return true;
  })()`;

  try {
    // 让服务端 CURRENT_ROOT 先指向 density2 根目录：首页 boot 才会默认选中 cpu-0015
    await fetch(BASE + '/api/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: DENSITY }),
    });
    await newPage();
    await waitFor('!!(window.scopeDebug && scopeDebug.state.lanes[0] && scopeDebug.state.lanes[0].payload)', 60000, 'boot');
    console.log('== boot');
    await evalJs(pinDensity);
    let st = await evalJs(`({ lanes: scopeDebug.state.lanes.length,
      runId: scopeDebug.state.lanes[0].runId,
      runs: scopeDebug.state.lanes[0].payload.runs.map(r => r.id) })`);
    ok(st.runs.length === 2, '根目录解析出两个 run', st.runs);
    ok(st.runId === 'density2-dsec-cpu-0015', '默认 run', st.runId);

    console.log('== 进入对比：自动加录制基线');
    await evalJs(`scopeDebug.setScreen('compare'); true`);
    await waitFor(`scopeDebug.state.lanes.length >= 2 && scopeDebug.state.lanes.some(l => l.autoBase && l.payload)`, 60000, 'auto record lane');
    st = await evalJs(`(() => {
      const ls = scopeDebug.state.lanes;
      const rec = ls.find(l => l.autoBase);
      const cols = scopeDebug.cmpLaneCols();
      const bi = scopeDebug.baseCiOf(cols);
      const bars = scopeDebug.chartRunBars(cols, bi);
      const sel = document.querySelector('#cmpBase');
      return {
        nLane: ls.length, recRoot: rec.payload.root, recCmpRun: rec.cmpRun,
        recShare: +scopeDebug.laneRecShare(rec).toFixed(3),
        replayShare: +scopeDebug.laneRecShare(ls[0]).toFixed(3),
        recRuns: rec.payload.runs.length,
        baseIdx: cols[bi].idx, baseName: cols[bi].name,
        bar0: { name: bars[0].name, isBase: bars[0].isBase, rec: bars[0].rec },
        nBars: bars.length, selVal: sel.value, selText: sel.options[sel.selectedIndex].textContent,
        hint: document.querySelector('#cmpHint').textContent
      };
    })()`);
    console.log('   ' + JSON.stringify(st));
    ok(st.nLane === 2, '自动加了一路（原有 1 路）', st.nLane);
    ok(/mimo-swe-12[\\\/]traj$/.test(st.recRoot), '录制目录定位正确', st.recRoot);
    ok(st.recCmpRun === '*', '录制路合并全部 run', st.recCmpRun);
    ok(st.recShare === 1, '录制标记 rec=1', st.recShare);
    ok(st.replayShare === 0, '回放路 rec=0', st.replayShare);
    ok(st.recRuns === 12, '逐 issue 12 个 run', st.recRuns);
    ok(st.baseIdx === 1 && st.baseName.indexOf('录制') >= 0, '基线自动落在录制路', st.baseName);
    ok(st.bar0.isBase && st.bar0.rec, '首柱是录制基线', st.bar0);
    ok(st.selVal === '1', '基线下拉选中录制路', st.selVal + ' ' + st.selText);
    ok(/自动：录制数据/.test(st.hint), '提示写明自动录制基线', st.hint);

    console.log('== 切回示波：录制基线不占波形带、时间窗不被拉到录制日期');
    await evalJs(`scopeDebug.setScreen('scope'); true`);
    await sleep(400);
    st = await evalJs(`(() => {
      const rec = scopeDebug.state.lanes.find(l => l.autoBase);
      const v = scopeDebug.state.view;
      return { disp: getComputedStyle(rec.el.root).display, only: !!rec.cmpOnly,
        spanH: v ? +((v.t1 - v.t0) / 3.6e6).toFixed(1) : null };
    })()`);
    ok(st.only === true && st.disp === 'none', '录制路在示波里隐藏', st);
    ok(st.spanH != null && st.spanH < 48, '时间窗没被录制日期撑大', st.spanH);
    await evalJs(`scopeDebug.setScreen('compare'); true`);
    await sleep(400);

    console.log('== 手选基线 A → 应持久化');
    await evalJs(`(() => { const s = document.querySelector('#cmpBase'); s.value = '0';
      s.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(300);
    st = await evalJs(`(() => {
      const cols = scopeDebug.cmpLaneCols();
      const bi = scopeDebug.baseCiOf(cols);
      const bars = scopeDebug.chartRunBars(cols, bi);
      const saved = JSON.parse(localStorage.getItem('trace_scope.setup') || '{}');
      return { cmpBase: scopeDebug.state.cmpBase, user: scopeDebug.state.cmpBaseUser,
        baseName: cols[bi].name, rec: bars[0].rec,
        hint: document.querySelector('#cmpHint').textContent,
        savedBase: saved.cmpBase, savedUser: saved.cmpBaseUser };
    })()`);
    ok(st.baseName.indexOf('录制') < 0, '基线切到 A 路', st.baseName);
    ok(st.user === true && st.savedUser === true && st.savedBase === 0, '手选标记与索引已存', st);
    ok(/手选/.test(st.hint), '提示写明手选', st.hint);

    console.log('== 新开页面：手选基线保持');
    await sleep(500);
    await newPage();
    await waitFor(`!!(window.scopeDebug && scopeDebug.state.lanes.length >= 2 && scopeDebug.state.lanes[0].payload)`, 90000, 'restore page');
    await waitFor(`scopeDebug.state.screen === 'compare'`, 30000, 'compare after restore');
    await sleep(500);
    st = await evalJs(`({ lanes: scopeDebug.state.lanes.length,
      val: document.querySelector('#cmpBase').value,
      name: document.querySelector('#cmpBase').selectedOptions[0].textContent,
      user: scopeDebug.state.cmpBaseUser })`);
    ok(st.lanes === 2, '两路都在', st.lanes);
    ok(st.val === '0' && st.user === true, '基线仍是手选的 A', st);

    console.log('== 清空 localStorage 后新开页面：基线回到录制自动');
    await evalJs(`localStorage.clear(); true`);
    await newPage();
    await waitFor('!!(window.scopeDebug && scopeDebug.state.lanes[0] && scopeDebug.state.lanes[0].payload)', 60000, 'fresh boot');
    await evalJs(pinDensity);
    await evalJs(`scopeDebug.setScreen('compare'); true`);
    await waitFor(`scopeDebug.state.lanes.length >= 2 && scopeDebug.state.lanes.some(l => l.autoBase && l.payload)`, 60000, 'auto again');
    await sleep(500);
    st = await evalJs(`(() => {
      const cols = scopeDebug.cmpLaneCols(); const bi = scopeDebug.baseCiOf(cols);
      return { val: document.querySelector('#cmpBase').value, name: cols[bi].name,
        hint: document.querySelector('#cmpHint').textContent };
    })()`);
    ok(st.name.indexOf('录制') >= 0 && st.val === '1', '自动基线回到录制路', st);
    ok(/自动：录制数据/.test(st.hint), '提示仍是自动', st.hint);

    console.log('== 元数据对比：默认字段 = 两路波形差异最大的 6 个');
    await evalJs(`(async () => {
      const j = await (await fetch('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: ${JSON.stringify(MEM_RUN)} }) })).json();
      const lane = scopeDebug.addLane(null);
      scopeDebug.applyPayload(lane, j);
      return true;
    })()`);
    await waitFor(`scopeDebug.state.lanes.length === 3 && !!scopeDebug.state.lanes[2].payload`, 30000, 'mem run lane');
    await evalJs(`(async () => {
      await scopeDebug.loadMemlogFile(0, ${JSON.stringify(CPU_MEMLOG)});
      await scopeDebug.loadMemlogFile(2, ${JSON.stringify(MEM_MEMLOG)});
      return true;
    })()`);
    await waitFor(`!!(scopeDebug.state.lanes[0].mem && scopeDebug.state.lanes[2].mem)`, 90000, 'memlogs');
    await evalJs(`scopeDebug.openMemCmp(); true`);
    await sleep(600);
    st = await evalJs(`(() => {
      const sel = [...scopeDebug.memCmpSelRef()];
      const score = scopeDebug.memCmpScoreRef();
      return {
        n: sel.length, sel,
        top: [...score.values()].sort((a, b) => b.score - a.score).slice(0, 8).map(x => [x.f, +x.score.toFixed(2)]),
        read: document.querySelector('#mcRead').textContent,
        badges: document.querySelectorAll('#mcFields .mcd').length,
        fields: document.querySelectorAll('#mcFields input[data-f]').length
      };
    })()`);
    console.log('   sel=' + JSON.stringify(st.sel));
    console.log('   top=' + JSON.stringify(st.top));
    console.log('   read=' + st.read);
    ok(st.n === 6, '默认选中 6 个字段', st.n);
    ok(st.badges > 0, '字段面板有 Δ 徽标', st.badges);
    ok(/差异最大/.test(st.read), '读数行说明默认口径', st.read);
    ok(st.sel.includes('psi.cpu.some.avg10'), '排到 CPU PSI 压力', st.sel);

    console.log('== 手改字段后「按差异重选」可复原');
    await evalJs(`(() => {
      const cb = document.querySelector('#mcFields input[data-f]');
      cb.checked = !cb.checked;
      cb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const afterToggle = await evalJs(`document.querySelector('#mcRead').textContent`);
    await evalJs(`document.querySelector('#mcRank').click(); true`);
    await sleep(400);
    st = await evalJs(`({ n: scopeDebug.memCmpSelRef().size,
      read: document.querySelector('#mcRead').textContent })`);
    ok(st.n === 6 && /差异最大/.test(st.read), '重选回到 6 个差异字段', st);
    console.log('   toggle 后读数: ' + afterToggle);
  } catch (e) {
    fails.push('异常: ' + e.message);
    console.log('EXCEPTION ' + e.message);
  } finally {
    console.log('\n== 结果: ' + (fails.length ? fails.length + ' 项失败' : '全部通过'));
    fails.forEach(f => console.log(' - ' + f));
    try { chrome.kill(); } catch (e) { /* 已退出 */ }
    await sleep(300);
    process.exit(fails.length ? 1 : 0);
  }
})();
