/**
 * 评论测试 — 让 bot 在指定帖子下打一条评论
 *
 * 用法：
 *   set BOT_CDP_URL=http://localhost:9222
 *   set POST_URL=https://www.instagram.com/p/xxxxx/
 *   set COMMENT_TEXT=Clean work
 *   npx tsx scripts/comment-test.ts
 *
 * 你可以在旁边看着 bot 打字、发评论。
 * 建议不用 emoji（Win CMD 可能不显示），纯英文最稳。
 */

import { chromium } from 'playwright';

const CDP_URL = process.env.BOT_CDP_URL || 'http://localhost:9222';
const POST_URL = process.env.POST_URL || '';
const COMMENT_TEXT = process.env.COMMENT_TEXT || 'Clean work';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function typeLikeHuman(page: any, text: string) {
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    if (Math.random() < 0.08) {
      await sleep(300 + Math.random() * 600);
    } else {
      await sleep(80 + Math.random() * 170);
    }
  }
}

async function main() {
  if (!POST_URL) {
    console.error('请设置 POST_URL 环境变量');
    process.exit(1);
  }

  console.log('=== 评论测试 ===');
  console.log(`帖子: ${POST_URL}`);
  console.log(`评论: ${COMMENT_TEXT}`);

  // 1. 连接 CDP Chrome
  console.log('\n[1] 连接 Chrome...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] || await browser.newContext();
  let page = context.pages().find(p => {
    try { return p.url()?.includes('instagram.com'); } catch { return false; }
  });
  if (!page) {
    page = await context.newPage();
  }
  await page.bringToFront();
  console.log('   ✅ 已连接');

  // 2. 打开帖子
  console.log('\n[2] 打开帖子...');
  await page.goto(POST_URL, { waitUntil: 'load', timeout: 45000 });
  await sleep(4000);
  console.log('   ✅ 页面加载完成');

  // 3. 定位评论框
  console.log('\n[3] 定位评论框...');
  const selectors = [
    '[aria-label="添加评论…"]', '[aria-label="Add a comment…"]',
    'textarea[placeholder*="comment" i]', 'textarea[placeholder*="评论" i]',
    'form input[type="text"]', 'div[role="textbox"]',
  ];

  let commentBox: any = null;
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
      commentBox = el;
      console.log(`   ✅ 找到: ${sel}`);
      break;
    }
  }

  if (!commentBox) {
    // 点评论图标先
    const icon = page.locator('svg[aria-label="评论"], svg[aria-label="Comment"]').first();
    if (await icon.count() > 0) {
      await icon.click();
      await sleep(2000);
      for (const sel of selectors) {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          commentBox = el; break;
        }
      }
    }
  }

  if (!commentBox) {
    console.error('❌ 找不到评论框');
    await browser.close();
    process.exit(1);
  }

  // 4. 打字
  console.log('\n[4] 输入评论...');
  await commentBox.click();
  await sleep(500);
  await typeLikeHuman(page, COMMENT_TEXT);
  console.log(`   ✅ 已输入: "${COMMENT_TEXT}"`);

  // 5. 发送 — 回车最稳，IG 原生支持
  console.log('\n[5] 发送...');
  await sleep(1000);
  await page.keyboard.press('Enter');
  await sleep(3000);

  // 验证：评论框是否清空
  let sent = false;
  try {
    const val = await commentBox.inputValue();
    if (!val || val.trim() === '') sent = true;
  } catch { sent = true; }

  if (!sent) {
    // fallback: 点 submit
    const btn = page.locator('button[type="submit"]').first();
    if (await btn.count() > 0) {
      await btn.click();
      await sleep(2000);
      sent = true;
    }
  }

  console.log('');
  if (sent) {
    console.log(`   🎉 评论已发送！`);
    console.log(`      "${COMMENT_TEXT}"`);
  } else {
    console.log('   ⚠️ 请查看浏览器窗口确认是否发送成功');
  }

  await browser.close();
}

main().catch(e => {
  console.error('失败:', e?.message || e);
  process.exit(1);
});
