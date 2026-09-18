// CDP 假死探针 —— 检测 Chrome 是否"连得上但协议冻结"（端口通、WS 握手成功，但主线程死了不响应 CDP 命令）
//
// 退出码（v2，2026-09-18 修订）：
//   0 = 健康
//   1 = 假死模糊判定（握手成功但 Browser.getVersion 无响应）
//   2 = 无法判断（当前 node 无全局 WebSocket 支持，需 node >= 22）
//   3 = 探针自身失败（HTTP 不通 / WS 根本连不上）—— ⚠️ 这不是冻结的证据！
//
// 🔴 v1 的致命缺陷（2026-09-18 实锤）：exit 1 同时代表「握手成功但无响应」和
//    「ws.on('error')」两种完全不同的情况。于是 Chrome 明明健康（同一秒 bot 还在
//    正常点赞），探针却报 frozen ⇒ 依赖该退出码的 chrome-keeper 会每 5 分钟杀掉
//    一个健康的 Chrome，每轮打断一次浏览会话，比不装守护更糟。
//    v2 把「连不上」单独归到 exit 3，并且：
//      * 换 host 重试（localhost 可能解析到 ::1，而 Chrome 只监听 127.0.0.1）
//      * 对"无响应"再给一次机会（单次丢帧是调度抖动，不是冻结）
//      * 任何异常都把原因打到 stderr，不再吞掉
const http = require('http');
const PORT = 9222;
const WS_BUDGET_MS = 6000;

function getVersion(timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/json/version', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad JSON from /json/version')); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('http timeout on /json/version')); });
    req.on('error', reject);
  });
}

// -> { verdict: 'ok' | 'frozen' | 'error', detail }
function probeWs(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    const finish = (verdict, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      resolve({ verdict, detail });
    };
    const timer = setTimeout(() => finish('frozen', 'no reply to Browser.getVersion within ' + timeoutMs + 'ms'), timeoutMs);

    try {
      ws = new WebSocket(url);
    } catch (e) {
      clearTimeout(timer);
      return resolve({ verdict: 'error', detail: 'constructor threw: ' + e.message });
    }

    ws.addEventListener('open', () => {
      try { ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); }
      catch (e) { finish('error', 'send failed: ' + e.message); }
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
      catch (_) { return; } // 分片/杂质帧，忽略
      if (msg && msg.id === 1) finish('ok', 'Browser.getVersion replied');
    });
    ws.addEventListener('error', (ev) => {
      const m = (ev && (ev.message || (ev.error && ev.error.message))) || 'unknown';
      finish('error', 'websocket error: ' + m);
    });
    ws.addEventListener('close', (ev) => {
      finish('error', 'socket closed before any reply (code ' + ((ev && ev.code) | 0) + ')');
    });
  });
}

async function main() {
  if (typeof WebSocket === 'undefined') {
    console.error('UNSUPPORTED: this node has no global WebSocket (need node >= 22)');
    process.exit(2);
  }

  let ver;
  try { ver = await getVersion(); }
  catch (e) { console.error('PROBE_ERROR http: ' + e.message); process.exit(3); }

  const wsUrl = ver.webSocketDebuggerUrl;
  if (!wsUrl) {
    console.error('PROBE_ERROR: /json/version returned no webSocketDebuggerUrl');
    process.exit(3);
  }

  // localhost may resolve to ::1 while Chrome listens on 127.0.0.1 only -> try both.
  // NOTE: the host variants are deduped, so an explicit trailing copy of the primary
  // URL is appended for the retry. (v2.0 listed a duplicate primary inside the array
  // and the dedup swallowed it, which silently disabled the retry its commit message
  // promised - a 1-in-N dropped frame then still reported 'frozen'.)
  const variants = [];
  for (const u of [
    wsUrl,
    wsUrl.replace('://localhost:', '://127.0.0.1:'),
    wsUrl.replace('://127.0.0.1:', '://localhost:'),
  ]) {
    if (u && !variants.includes(u)) variants.push(u);
  }
  const urls = variants.concat([wsUrl]); // trailing = deliberate second chance

  const attempts = [];
  let sawFrozen = false;
  for (const u of urls) {
    const t0 = Date.now();
    const r = await probeWs(u, WS_BUDGET_MS);
    attempts.push({ u, ms: Date.now() - t0, ...r });
    if (r.verdict === 'ok') {
      console.log('OK ' + ver.Browser + ' | ' + u + ' | ' + r.detail + ' | ' + (Date.now() - t0) + 'ms');
      process.exit(0);
    }
    if (r.verdict === 'frozen') sawFrozen = true;
  }

  for (const a of attempts) console.error('  ' + a.verdict + '  ' + a.u + '  ' + a.ms + 'ms  (' + a.detail + ')');

  if (sawFrozen) {
    console.error('FROZEN: websocket handshake succeeded but the browser never answered Browser.getVersion');
    process.exit(1);
  }
  console.error('PROBE_ERROR: no CDP websocket could be established at all -- this is NOT evidence of a freeze');
  process.exit(3);
}

main().catch((e) => { console.error('PROBE_ERROR unexpected: ' + (e && e.message)); process.exit(3); });
