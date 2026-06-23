/**
 * 评论测试 — 让 bot 在指定帖子下打一条评论
 *
 * 用法：
 *   set BOT_CDP_URL=http://localhost:9222
 *   set POST_URL=https://www.instagram.com/p/xxxxx/
 *   set COMMENT_TEXT=Love the work! 🔥
 *   npx tsx scripts/comment-test.ts
 *
 * 你可以在旁边看着 bot 打字、点 Post。
 */

import { chromium } from 'playwright';

const CDP_URL = process.env.BOT_CDP_URL || 'http://localhost:9222';
const POST_URL = process.env.POST_URL || '';
const COMMENT_TEXT = process.env.COMMENT_TEXT || 'Clean work 🔥';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function typeLikeHuman(page: any, text: string) {
  // 像真人一样逐字打字，每字间隔随机 80~250ms
  // 偶尔停顿模拟思考
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i]);
    if (Math.random() < 0.08) {
      // 8% 概率假装卡顿思考
      await sleep(300 + Math.random() * 600);
    } else {
      await sleep(80 + Math.random() * 170);
    }
  }
}

async function main() {
  if (!POST_URL) {
    console.error('请设置 POST_URL 环境变量');
    console.error('例: set POST_URL=https://www.instagram.com/p/xxxxx/');
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

  // 3. 点击评论输入框
  console.log('\n[3] 定位评论框...');
  // Instagram 的评论框有多种可能的选择器
  const commentSelectors = [
    '[aria-label="添加评论…"]',
    '[aria-label="Add a comment…"]',
    'textarea[placeholder*="comment" i]',
    'textarea[placeholder*="评论" i]',
    'form input[type="text"]',
    'div[role="textbox"]',
  ];

  let commentBox: any = null;
  for (const sel of commentSelectors) {
    const el = page.locator(sel).first();
    if (await el.count() > 0) {
      commentBox = el;
      console.log(`   ✅ 找到评论框: ${sel}`);
      break;
    }
  }

  if (!commentBox) {
    // 尝试点击评论图标先打开评论栏
    console.log('   → 尝试点评论图标打开输入框...');
    const commentIcon = page.locator('svg[aria-label="评论"], svg[aria-label="Comment"]').first();
    if (await commentIcon.count() > 0) {
      await commentIcon.click();
      await sleep(2000);
      // 再找一次
      for (const sel of commentSelectors) {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          commentBox = el;
          console.log(`   ✅ 找到评论框: ${sel}`);
          break;
        }
      }
    }
  }

  if (!commentBox) {
    console.error('   ❌ 找不到评论输入框，可能需要手动定位');
    console.log('   URL:', page.url());
    await browser.close();
    process.exit(1);
  }

  // 4. 打字（模拟真人）
  console.log('\n[4] 正在输入评论...');
  await commentBox.click();
  await sleep(500);
  await typeLikeHuman(page, COMMENT_TEXT);
  console.log(`   ✅ 已输入: "${COMMENT_TEXT}"`);

  // 5. 点 Post 按钮
  console.log('\n[5] 点击 Post...');
  await sleep(800);

  const postBtnSelectors = [
    'button:has-text("发布")',
    'button:has-text("Post")',
    'div[role="button"]:has-text("发布")',
    'div[role="button"]:has-text("Post")',
    'button[type="submit"]',
  ];

  let posted = false;
  for (const sel of postBtnSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.count() > 0 && await btn.isVisible()) {
      await btn.click();
      posted = true;
      console.log(`   ✅ 点击了: ${sel}`);
      break;
    }
  }

  if (!posted) {
    // 尝试回车发送
    console.log('   → 尝试回车发送...');
    await page.keyboard.press('Enter');
    posted = true;
  }

  await sleep(3000);
  console.log('');
  if (posted) {
    console.log('   🎉 评论已发送！');
    console.log(`      帖子: ${POST_URL}`);
    console.log(`      评论: "${COMMENT_TEXT}"`);
  } else {
    console.log('   ⚠️ 不确定是否发送成功，请查看浏览器窗口');
  }

  await browser.close();
}

main().catch(e => {
  console.error('测试失败:', e?.message || e);
  process.exit(1);
});
