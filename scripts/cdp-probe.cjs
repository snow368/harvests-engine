// CDP 假死探针 —— 检测 Chrome 是否"连得上但协议冻结"（端口通、WS 握手成功，但主线程死了不响应 CDP 命令）
// 退出码: 0 = 健康 / 1 = 假死或 CDP 不通 / 2 = 无法判断（当前 node 无全局 WebSocket 支持）
const http = require('http');
const PORT = 9222;

function getVersion() {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 3000 },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('http timeout')); });
    req.on('error', reject);
  });
}

async function probe() {
  if (typeof WebSocket === 'undefined') { process.exit(2); }
  const ver = await getVersion();            // 端口层 OK -> 取浏览器级 WS 地址
  const wsUrl = ver.webSocketDebuggerUrl;
  if (!wsUrl) process.exit(1);

  const ws = new WebSocket(wsUrl);
  const timer = setTimeout(() => { try { ws.close(); } catch (_) {} process.exit(1); }, 5000);

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      // 发一个最轻量的 CDP 命令，看浏览器是否还活着能回
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
    });
    ws.on('message', (m) => {
      try {
        const msg = JSON.parse(m);
        if (msg && msg.id === 1) {
          clearTimeout(timer);
          try { ws.close(); } catch (_) {}
          process.exit(0); // 收到响应 = 健康
        }
      } catch (_) {}
    });
    ws.on('error', () => { clearTimeout(timer); process.exit(1); });
  });
}

probe().catch(() => process.exit(1));
