/**
 * login-ig.ts — 一次性「可见」IG 登录脚本（仅手动跑一次，不是常驻进程）
 *
 * 为什么需要它：
 *   pm2 把 bot 跑在 Windows session 0（非交互服务会话），即使 HEADLESS=false，
 *   你在 RDP 桌面也看不到浏览器窗口，因此无法在登录闸门上手动登录。
 *   本脚本在你「当前 RDP 交互会话」里用同一个 playwright/chromium + 同一个
 *   profile 目录打开一个你能看见的真实浏览器，你登录一次后，会话（cookies/
 *   localStorage）就永久写进 profile；之后 pm2 的 persistent 模式自动复用。
 *
 * 用法（在 VPS 的 RDP 桌面里，PowerShell，cwd = C:\harvests\harvests-engine）：
 *   1) pm2 stop bot-worker            # 必须先停 bot，否则 profile 被锁（SingletonLock）
 *   2) node --import tsx scripts/login-ig.ts            # 默认 profile = C:\harvests\profiles\bot_ig_01
 *      # 或指定别的号： node --import tsx scripts/login-ig.ts C:\harvests\profiles\bot_ig_02
 *   3) 弹出的 Chrome 窗口里登录 IG（含 2FA/挑战页也照常完成）
 *   4) 看到终端打印 "✅ LOGIN CONFIRMED — 会话已保存" 后，直接关窗口 / Ctrl+C
 *   5) pm2 start ecosystem.matrix.config.cjs --only bot-worker && pm2 save
 *
 * 注意：本脚本不会 kill 任何 chrome，也不会删任何文件，纯粹打开浏览器等你登录。
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const IG_BASE = 'https://www.instagram.com';

const profileArg = process.argv[2];
const PROFILE_DIR = profileArg
  ? path.resolve(profileArg)
  : path.resolve(process.cwd(), process.env.BOT_PROFILE_DIR || 'C:\\harvests\\profiles\\bot_ig_01');

const MAX_WAIT_MS = 60 * 60 * 1000; // 最多等 1 小时，避免人走开一直挂着

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 与 bot-worker-real.ts 完全一致的判定（保证"登录态"定义一致）
const isOnLoginPage = async (page: any): Promise<boolean> => {
  try {
    const url = (page.url() || '').toLowerCase();
    if (url.includes('/accounts/login')) return true;
    if (url.includes('/challenge/')) return true;
    if (url.includes('/accounts/onetap')) return true;
    if (url.includes('/accounts/emailsignup')) return true;
    if ((await page.locator('input[name="username"]').count()) > 0) return true;
    if ((await page.locator('input[name="security_code"], input[name="email"]').count()) > 0) return true;
  } catch {}
  return false;
};

const isLoggedInPositive = async (page: any): Promise<boolean> => {
  try {
    const n = await page
      .locator('svg[aria-label="Home"], a[href="/direct/inbox/"], a[href="/"]')
      .count();
    if (n > 0) return true;
  } catch {}
  return false;
};

async function main() {
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log(`\n=== IG 可见登录助手 ===`);
  console.log(`profile: ${PROFILE_DIR}`);
  console.log(`将在你的 RDP 会话里打开一个真实 Chrome 窗口，请在那里登录 IG。`);
  console.log(`（如果下面报 SingletonLock / ProcessSingleton，说明 bot-worker 没停，先 pm2 stop bot-worker）\n`);

  let context: any;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false, // 关键：可见窗口
      viewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('ProcessSingleton') || msg.includes('SingletonLock') || msg.toLowerCase().includes('already in use')) {
      console.error(`\n❌ profile 被占用：${msg.split('\n')[0]}`);
      console.error(`→ 请先执行： pm2 stop bot-worker   （或对应号的 worker），再重跑本脚本。`);
    } else {
      console.error(`\n❌ 启动浏览器失败：${msg}`);
    }
    process.exit(2);
  }

  const page = context.pages()[0] || (await context.newPage());
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  const deadline = Date.now() + MAX_WAIT_MS;
  let lastHint = '';

  while (Date.now() < deadline) {
    if (await isLoggedInPositive(page)) {
      console.log(`\n✅ LOGIN CONFIRMED — 会话已保存到 profile：${PROFILE_DIR}`);
      console.log(`现在可以关掉这个浏览器窗口，然后： pm2 start ecosystem.matrix.config.cjs --only bot-worker && pm2 save`);
      await context.close().catch(() => {});
      process.exit(0);
    }

    // 给用户的实时提示
    let hint = '请在弹出的 Chrome 窗口里登录 IG（输入用户名/密码，必要时完成 2FA）。';
    if (await isOnLoginPage(page)) {
      hint = '检测到在登录/挑战页 —— 请完成登录（含短信/邮箱验证码），登录成功后会自动跳转。';
    }
    if (hint !== lastHint) {
      console.log(`⏳ ${hint}`);
      lastHint = hint;
    }

    await sleep(3000);
  }

  console.error(`\n⌛ 等待超时（1 小时）。如已登录但脚本未识别，请确认浏览器确实停在 IG 首页（非登录页）。`);
  console.error(`会话通常已在登录瞬间自动保存，可直接关窗口并启动 bot 验证。`);
  await context.close().catch(() => {});
  process.exit(3);
}

main().catch((e) => {
  console.error('login-ig 异常：', e);
  process.exit(1);
});
