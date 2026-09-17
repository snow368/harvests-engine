// 验证 bot-worker 新增的两个 CDP 判据（mock 一个 CDP 端点，不碰真实 Chrome）
// 1) healer：3 个 page target + 1 个 service_worker → 应只关掉 2 个非 IG 的 page，保留 IG 页，不动 sw
// 2) protocol probe：WS 握手成功但不回 Browser.getVersion → 应判为 protocol_frozen_5s
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = 19222;
const BASE = `http://127.0.0.1:${PORT}`;
const closed = [];
let wsUpgrades = 0;
let replyToCdp = false; // 由测试控制：是否回 Browser.getVersion

const server = http.createServer((req, res) => {
  const u = req.url || '';
  if (u === '/json/version') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ Browser: 'Chrome/mock-153', webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/browser/mock` }));
  }
  if (u === '/json/list') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify([
      { id: 'a', type: 'page', url: 'about:blank', title: '' },
      { id: 'b', type: 'page', url: 'https://www.instagram.com/', title: 'Instagram' },
      { id: 'c', type: 'page', url: 'https://example.com/whatever', title: 'x' },
      { id: 'd', type: 'service_worker', url: 'https://www.instagram.com/sw.js', title: 'sw' },
    ]));
  }
  if (u.startsWith('/json/close/')) {
    closed.push(u.split('/').pop());
    return res.end('Target is closing');
  }
  res.statusCode = 404;
  res.end('');
});

// 手写最小 WS 握手：接受 upgrade，但不回任何数据帧（模拟"协议冻结"）
server.on('upgrade', (req, socket) => {
  wsUpgrades++;
  const key = req.headers['sec-websocket-key'] || '';
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  if (replyToCdp) {
    // 回一个最小的文本帧（unmasked）：{"id":1,"result":{}}
    const payload = Buffer.from(JSON.stringify({ id: 1, result: { protocolVersion: '1.3' } }));
    const head = Buffer.from([0x81, payload.length]);
    socket.write(Buffer.concat([head, payload]));
  }
  // 否则：故意什么都不回
});

// ── 被测逻辑（与 bot-worker-real.ts 中 healCdpTargets 等价）──
const healCdpTargets = async () => {
  const r = await fetch(`${BASE}/json/list`);
  const list = (await r.json()) || [];
  const pages = list.filter((t) => t?.type === 'page' && t?.id);
  if (pages.length <= 1) return 'skip(<=1 page)';
  const keep = pages.find((t) => String(t.url || '').includes('instagram.com')) || pages[0];
  const extra = pages.filter((t) => t.id !== keep.id);
  let n = 0;
  for (const t of extra.slice(0, 12)) {
    try { const cr = await fetch(`${BASE}/json/close/${t.id}`); if (cr.ok) n++; } catch {}
  }
  return `kept=${keep.id} closed=${n}`;
};

// ── 被测逻辑（与 probeCdpProtocol 等价）──
const probeCdpProtocol = async () => {
  let wsUrl = '';
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(`${BASE}/json/version`, { signal: ctl.signal });
    clearTimeout(t);
    wsUrl = String((await r.json())?.webSocketDebuggerUrl || '');
  } catch (e) { return { ok: false, reason: `http_unreachable:${e?.message || e}` }; }
  if (!wsUrl) return { ok: false, reason: 'no_webSocketDebuggerUrl' };
  return await new Promise((resolve) => {
    let done = false; let ws = null;
    const finish = (ok, reason) => { if (done) return; done = true; try { ws?.close?.(); } catch {} resolve({ ok, reason }); };
    const timer = setTimeout(() => finish(false, 'protocol_frozen_5s'), 5000);
    ws = new WebSocket(wsUrl);
    ws.onopen = () => { try { ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); } catch {} };
    ws.onmessage = (m) => { try { const j = JSON.parse(String(m?.data || '')); if (j && j.id === 1) { clearTimeout(timer); finish(true, 'ok'); } } catch {} };
    ws.onerror = () => { clearTimeout(timer); finish(false, 'ws_error'); };
    ws.onclose = () => { clearTimeout(timer); finish(false, 'ws_closed_before_reply'); };
  });
};

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  PASS  ${name} ${extra}`); } else { fail++; console.log(`  FAIL  ${name} ${extra}`); } };

console.log('=== T1: healCdpTargets 清理僵尸标签 ===');
const healOut = await healCdpTargets();
console.log('  heal →', healOut);
check('保留 IG 页 b', healOut.includes('kept=b'));
check('关掉恰好 2 个 page (a,c)', closed.length === 2 && closed.includes('a') && closed.includes('c'), `closed=[${closed.join(',')}]`);
check('service_worker d 未被关', !closed.includes('d'));

console.log('=== T2: 协议冻结（WS 握手成功但不回命令）===');
replyToCdp = false;
const t0 = Date.now();
const frozen = await probeCdpProtocol();
const dt = Date.now() - t0;
console.log('  probe →', JSON.stringify(frozen), `耗时 ${dt}ms`);
check('判为 protocol_frozen_5s', frozen.reason === 'protocol_frozen_5s', frozen.reason);
check('确实建立了 WS 连接', wsUpgrades >= 1, `upgrades=${wsUpgrades}`);
check('5s 左右返回（未卡到 20s）', dt >= 4500 && dt < 7000, `${dt}ms`);

console.log('=== T3: 协议健康（回 Browser.getVersion）===');
replyToCdp = true;
const healthy = await probeCdpProtocol();
console.log('  probe →', JSON.stringify(healthy));
check('判为 ok', healthy.ok === true && healthy.reason === 'ok');

console.log('=== T4: 端点不通（HTTP 层就挂）===');
server.close();
await new Promise((r) => setTimeout(r, 120));
const dead = await probeCdpProtocol();
console.log('  probe →', JSON.stringify(dead));
check('判为 http_unreachable', String(dead.reason).startsWith('http_unreachable'), dead.reason);
check('不误报 frozen', dead.reason !== 'protocol_frozen_5s');

console.log(`\n结果: PASS=${pass}  FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
