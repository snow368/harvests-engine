/**
 * bot-stealth.ts — Multi-browser fingerprint protection for Playwright Chromium
 *
 * 对标紫鸟/比特浏览器的指纹伪装层，每次启动注入：
 *   - navigator.webdriver 抹除
 *   - Canvas 指纹随机化（确定性种子 per bot）
 *   - WebGL 指纹随机化
 *   - WebRTC 禁用（防真实 IP 泄漏）
 *   - 时区/语言/UA 匹配代理 IP
 *   - navigator.hardwareConcurrency / plugins 伪造
 *
 * 用法：
 *   import { getStealthLaunchArgs, applyStealthPatches } from './bot-stealth';
 *   const args = getStealthLaunchArgs(botId, viewport, timezone);
 *   const context = await chromium.launchPersistentContext(userDataDir, { args, ... });
 *   await applyStealthPatches(context, page, botId, timezone);
 */

import type { BrowserContext, Page } from 'playwright';

// ============================================================
// 确定性种子 (per bot, 每次启动指纹一致)
// ============================================================
function seedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 简单的确定性伪随机 (mulberry32) */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// Launch args — Chromium CLI 级别
// ============================================================
export function getStealthLaunchArgs(
  botId: string,
  viewport: { width: number; height: number },
  timezone?: string,
  headless?: boolean,
): string[] {
  const args: string[] = [];

  // 禁用自动化检测标志
  args.push('--disable-blink-features=AutomationControlled');

  // WebRTC 防泄漏（核心！避免绕过代理暴露真实 IP）
  args.push('--disable-webrtc');
  args.push('--enforce-webrtc-ip-permission-check');
  args.push('--webrtc-ip-handling-policy=disable_non_proxied_udp');

  // 禁用 User-Agent Client Hints (避免 UA 不一致泄漏)
  args.push('--disable-features=UserAgentClientHint');

  // 禁用自动化 infobar
  args.push('--disable-infobars');

  // 禁用 chrome://welcome 页
  args.push('--no-first-run');
  args.push('--disable-search-engine-choice-screen');

  // 禁用闪屏
  args.push('--disable-features=ChromeWhatsNewUI');

  // 窗口大小
  if (!headless) args.push(`--window-size=${viewport.width},${viewport.height}`);

  // 语言 (默认 en-US)
  args.push('--lang=en-US');

  // 时区 (通过 TZ 环境变量更可靠，但 CLI 也设一下)
  if (timezone) args.push(`--timezone-for-testing=${timezone}`);

  return args;
}

// ============================================================
// JIT 随机噪点生成 (用到 Canvas / WebGL)
// ============================================================
function generateNoiseData(rand: () => number, count: number): number[] {
  const data: number[] = [];
  for (let i = 0; i < count; i++) data.push(Math.floor(rand() * 256));
  return data;
}

// ============================================================
// addInitScript — JS 级别的指纹注入
// 每个新页面/iframe 都会执行
// ============================================================
function buildStealthInitScript(botId: string, timezone?: string): string {
  const seed = seedFromId(botId);
  const rand = mulberry32(seed);
  const canvasNoise = generateNoiseData(rand, 64); // 64 byte 噪点
  const webglNoise = generateNoiseData(rand, 32);

  return `
(() => {
  // ===================================================================
  // 1. navigator.webdriver 抹除 (核心！)
  // ===================================================================
  try {
    delete navigator.__proto__.webdriver;
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  } catch (e) {}

  // ===================================================================
  // 2. navigator.plugins 伪造 (真实 Chrome 最少 3-5 个 plugin)
  // ===================================================================
  try {
    const pluginData = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', filename: 'internal-nacl-plugin' },
    ];
    const plugins = pluginData.map(p => {
      const pl = new MimeType();
      Object.defineProperties(pl, {
        name: { get: () => p.name },
        filename: { get: () => p.filename },
        length: { get: () => 0 },
      });
      return pl;
    });
    Object.defineProperty(navigator, 'plugins', {
      get: () => ({
        item: (i) => plugins[i] || null,
        namedItem: (n) => plugins.find(p => p.name === n) || null,
        length: plugins.length,
        [Symbol.iterator]: function*() { for (const p of plugins) yield p; },
      }),
      configurable: true,
    });
  } catch (e) {}

  // ===================================================================
  // 3. navigator.languages 匹配代理 (en-US)
  // ===================================================================
  try {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
  } catch (e) {}

  // ===================================================================
  // 4. navigator.hardwareConcurrency 常见值 (4/8/12)
  // ===================================================================
  try {
    const cores = [4, 8, 12, 16];
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => cores[Math.floor(Math.random() * cores.length)],
      configurable: true,
    });
  } catch (e) {}

  // ===================================================================
  // 5. Canvas 指纹随机化 —— toDataURL / toBlob 注入噪点
  // ===================================================================
  const _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const _origToBlob = HTMLCanvasElement.prototype.toBlob;
  const _origGetContext = HTMLCanvasElement.prototype.getContext;

  const noiseBase = [${canvasNoise.join(',')}];

  HTMLCanvasElement.prototype.getContext = function(...args) {
    const ctx = _origGetContext.apply(this, args);
    if (!ctx || args[0] !== '2d') return ctx;

    const _origGetImageData = ctx.getImageData;
    const _origPutImageData = ctx.putImageData;

    // 在 getImageData 时注入噪点
    ctx.getImageData = function(x, y, w, h) {
      const imageData = _origGetImageData.call(this, x, y, w, h);
      const data = imageData.data;
      for (let i = 0; i < data.length && i < noiseBase.length * 4; i++) {
        data[i] = Math.max(0, Math.min(255, data[i] + noiseBase[i % noiseBase.length]));
      }
      return imageData;
    };

    ctx.putImageData = function(imageData, dx, dy) {
      const d = imageData.data;
      for (let i = 0; i < d.length && i < noiseBase.length * 4; i++) {
        d[i] = Math.max(0, Math.min(255, d[i] - noiseBase[i % noiseBase.length]));
      }
      return _origPutImageData.call(this, imageData, dx, dy);
    };

    return ctx;
  };

  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    const ctx = this.getContext('2d');
    if (ctx && ctx.getImageData) {
      try {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        // already noised by getImageData
      } catch (e) {}
    }
    return _origToDataURL.apply(this, args);
  };

  // ===================================================================
  // 6. WebGL 指纹随机化 —— 篡改关键的 UNMASKED_RENDERER/VENDOR
  // ===================================================================
  const webglNoise = [${webglNoise.join(',')}];

  const patchWebGL = (gl) => {
    if (!gl || gl.__stealthed) return;
    const _origGetParameter = gl.getParameter.bind(gl);
    gl.getParameter = function(pname) {
      const result = _origGetParameter(pname);
      // UNMASKED_VENDOR_WEBGL
      if (pname === 0x9245) return 'Intel Inc.';
      // UNMASKED_RENDERER_WEBGL
      if (pname === 0x9246) return 'Intel Iris OpenGL Engine';
      // VERSION
      if (pname === 0x1f02 && typeof result === 'string') {
        return result.replace(/WebGL.*/, 'WebGL 2.0 (OpenGL ES 3.0)');
      }
      return result;
    };
    gl.__stealthed = true;
  };

  HTMLCanvasElement.prototype.getContext = (function(orig) {
    return function(type, attrs) {
      const ctx = orig.call(this, type, attrs);
      if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
        patchWebGL(ctx);
      }
      return ctx;
    };
  })(HTMLCanvasElement.prototype.getContext);

  // WebGLRenderingContext getParameter 补丁 (备用)
  try {
    const _origGLGetParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(pname) {
      if (pname === 0x9245) return 'Intel Inc.';
      if (pname === 0x9246) return 'Intel Iris OpenGL Engine';
      return _origGLGetParameter ? _origGLGetParameter.call(this, pname) : null;
    };
  } catch (e) {}

  // ===================================================================
  // 7. chrome.runtime 伪装 (部分站点检测)
  // ===================================================================
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      connect: () => null,
      sendMessage: () => null,
    };
  }

  // ===================================================================
  // 8. Permissions 欺骗 (避免暴露自动化特征)
  // ===================================================================
  try {
    const _origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (desc) => {
      if (desc.name === 'clipboard-read' || desc.name === 'clipboard-write') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return _origQuery(desc);
    };
  } catch (e) {}

  // ===================================================================
  // 9. Screen 属性匹配 viewport
  // ===================================================================
  try {
    Object.defineProperties(screen, {
      availWidth: { get: () => screen.width },
      availHeight: { get: () => screen.height - 40 },
      colorDepth: { get: () => 24 },
      pixelDepth: { get: () => 24 },
    });
  } catch (e) {}

  console.log('[stealth] fingerprint protection applied for', '${botId}');
})();
`;
}

// ============================================================
// 主入口 — 应用所有 stealth patches
// 在 context 创建后调用，每次页面创建时自动注入
// ============================================================
export async function applyStealthPatches(
  context: BrowserContext,
  page: Page,
  botId: string,
  timezone?: string,
): Promise<void> {
  const script = buildStealthInitScript(botId, timezone);

  // 所有已有页面
  const pages = context.pages();
  for (const p of pages) {
    try {
      await p.addInitScript(script);
      await p.evaluate(script).catch(() => {});
    } catch {}
  }

  // 未来新页面自动注入
  await context.addInitScript(script).catch(() => {});

  // CDP: 额外抹除 webdriver 痕迹
  try {
    const cdp = await context.newCDPSession(page).catch(() => null);
    if (cdp) {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,
      }).catch(() => {});
    }
  } catch {}
}

// ============================================================
// 获取推荐 TZ 基于代理 IP (简单映射, 可扩展)
// 生产环境应根据代理出口 IP 的地理位置自动匹配
// ============================================================
export function proxyToTimezone(_proxy: string): string | undefined {
  // 简单 heuristic: 根据代理地址猜测时区
  const proxy = _proxy.toLowerCase();
  if (proxy.includes('us') || proxy.includes('america') || proxy.includes('newyork')) return 'America/New_York';
  if (proxy.includes('uk') || proxy.includes('london') || proxy.includes('gb-')) return 'Europe/London';
  if (proxy.includes('de') || proxy.includes('frankfurt') || proxy.includes('germany')) return 'Europe/Berlin';
  if (proxy.includes('sg') || proxy.includes('singapore')) return 'Asia/Singapore';
  if (proxy.includes('jp') || proxy.includes('japan') || proxy.includes('tokyo')) return 'Asia/Tokyo';
  if (proxy.includes('kr') || proxy.includes('korea') || proxy.includes('seoul')) return 'Asia/Seoul';
  if (proxy.includes('au') || proxy.includes('australia') || proxy.includes('sydney')) return 'Australia/Sydney';
  return undefined; // 保持系统默认
}
