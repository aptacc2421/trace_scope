// 探针：连上正在跑的浏览器，看两个 page target 的状态
const PORT = 9223;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const wait = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && wait.has(m.id)) { const { res, rej } = wait.get(m.id); wait.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  const send = (method, params, sessionId) => {
    const i = ++id;
    return new Promise((res, rej) => { wait.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });
  };
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  for (const t of list.filter(x => x.type === 'page')) {
    const { sessionId } = await send('Target.attachToTarget', { targetId: t.id, flatten: true });
    try {
      const r = await Promise.race([
        send('Runtime.evaluate', { expression: `JSON.stringify({url: location.href, ready: document.readyState, old: window.__oldDoc,
          dbg: typeof window.scopeDebug, lanes: window.scopeDebug ? scopeDebug.state.lanes.length : -1,
          screen: window.scopeDebug ? scopeDebug.state.screen : '-',
          canvas: !!document.querySelector('#cmpChart')})`, returnByValue: true }, sessionId),
        sleep(5000).then(() => ({ timeout: true })),
      ]);
      console.log(t.url, '=>', JSON.stringify(r));
    } catch (e) { console.log(t.url, 'ERR', e.message); }
  }
  process.exit(0);
})();
