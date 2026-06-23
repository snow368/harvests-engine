/**
 * Bot Setup — 一次性账号配置
 *
 * 连接到运行中的 Chrome CDP，执行以下操作：
 *   1. 更换头像（profile photo）
 *   2. 修改显示名称 / 简介
 *   3. 发一篇帖子（图片 + 文案）
 *
 * 用法：
 *   set BOT_CDP_URL=http://localhost:9222
 *   set AVATAR_PATH=C:\path\to\avatar.jpg
 *   set POST_IMAGE_PATH=C:\path\to\post.jpg
 *   set POST_CAPTION=Tattoo inspiration  # 可选
 *   set DISPLAY_NAME=Rhys  Ink           # 可选
 *   set BIO_TEXT=Tattoo enthusiast        # 可选
 *   npx tsx scripts/bot-setup-once.ts
 *
 * 注意：脚本执行后重启 bot-worker（pm2 restart bot-worker）
 */

import { chromium } from 'playwright';

const CDP_URL = process.env.BOT_CDP_URL || 'http://localhost:9222';
const IG_BASE = 'https://www.instagram.com';

// ── 配置（通过环境变量覆盖） ──
const AVATAR = process.env.AVATAR_PATH || '';          // 头像图片路径（必需）
const DISPLAY_NAME = process.env.DISPLAY_NAME || '';    // 显示名称（可选，留空不修改）
const BIO_TEXT = process.env.BIO_TEXT || '';            // 简介（可选，留空不修改）
const POST_IMAGE = process.env.POST_IMAGE_PATH || '';   // 帖子图片路径（可选）
const POST_CAPTION = process.env.POST_CAPTION || '🎨 Tattoo inspiration #tattoo #ink #art';

// ── 工具函数 ──
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('=== Bot 账号配置 ===');
  console.log(`CDP: ${CDP_URL}`);
  if (AVATAR) console.log(`头像: ${AVATAR}`);
  if (DISPLAY_NAME) console.log(`名称: ${DISPLAY_NAME}`);
  if (BIO_TEXT) console.log(`简介: ${BIO_TEXT}`);
  if (POST_IMAGE) console.log(`帖子图片: ${POST_IMAGE}`);
  console.log('');

  // 1. 连接 CDP
  console.log('[1] 连接 Chrome...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] || await browser.newContext();
  let page = context.pages().find(p => {
    try { return p.url()?.includes('instagram.com'); } catch { return false; }
  });
  if (!page) {
    page = await context.newPage();
    await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  await page.bringToFront();
  await sleep(3000);
  console.log('   ✅ 已连接');

  // 2. 编辑资料
  if (DISPLAY_NAME || BIO_TEXT || AVATAR) {
    console.log('[2] 编辑资料...');
    await page.goto(`${IG_BASE}/accounts/edit/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);

    // 2a. 更换头像
    if (AVATAR) {
      console.log('   → 更换头像...');
      // 点击当前头像
      const avatarEl = page.locator('img[alt*="profile" i], img[alt*="avatar" i], img[data-visualcompletion="media-vc-image"]').first();
      if (await avatarEl.count() > 0) {
        await avatarEl.click();
        await sleep(1500);
      }

      // 找 "Change photo" 或 "更换照片" 按钮
      const changePhotoBtn = page.locator('button:has-text("Change"), button:has-text("上传"), button:has-text("photo")').first();
      if (await changePhotoBtn.count() > 0) {
        await changePhotoBtn.click();
        await sleep(1000);
      }

      // 找文件上传 input
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.count() > 0) {
        await fileInput.setInputFiles(AVATAR);
        console.log('   ✅ 头像已上传');
        await sleep(3000);

        // 点确认/裁剪按钮
        const confirmBtn = page.locator('button:has-text("确定"), button:has-text("Done"), button:has-text("保存"), button[type="submit"]').first();
        if (await confirmBtn.count() > 0) {
          await confirmBtn.click();
          await sleep(2000);
        }
      } else {
        console.log('   ⚠️ 未找到文件上传 input，可能需要手动操作');
      }
    }

    // 2b. 修改显示名称
    if (DISPLAY_NAME) {
      console.log(`   → 设置显示名称: ${DISPLAY_NAME}`);
      const nameInput = page.locator('input#pepName, input[name="name"], input[name="first_name"]').first();
      if (await nameInput.count() > 0) {
        await nameInput.click({ clickCount: 3 });
        await nameInput.fill(DISPLAY_NAME);
        await sleep(1000);
        console.log('   ✅ 名称已修改');
      } else {
        console.log('   ⚠️ 未找到名称输入框');
      }
    }

    // 2c. 修改简介
    if (BIO_TEXT) {
      console.log(`   → 设置简介: ${BIO_TEXT}`);
      const bioInput = page.locator('textarea[name="biography"], textarea#pepBio').first();
      if (await bioInput.count() > 0) {
        await bioInput.click({ clickCount: 3 });
        await bioInput.fill(BIO_TEXT);
        await sleep(1000);
        console.log('   ✅ 简介已修改');
      } else {
        console.log('   ⚠️ 未找到简介输入框');
      }
    }

    // 提交修改
    const submitBtn = page.locator('button[type="submit"], button:has-text("提交"), button:has-text("保存")').first();
    if (await submitBtn.count() > 0) {
      await submitBtn.click();
      await sleep(3000);
      console.log('   ✅ 资料已保存');
    }
  }

  // 3. 发帖
  if (POST_IMAGE) {
    console.log('[3] 发帖...');
    await page.goto(IG_BASE, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await sleep(3000);

    // 点 + 号（创建）
    const createBtn = page.locator('svg[aria-label="创建"], svg[aria-label="New post"], svg[aria-label="New"], a[href="/create"]').first();
    if (await createBtn.count() > 0) {
      await createBtn.click();
      await sleep(2000);
    } else {
      // 直接导航到创建页面
      await page.goto(`${IG_BASE}/create/select/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(2000);
    }

    // 上传图片
    const postFileInput = page.locator('input[type="file"]').first();
    if (await postFileInput.count() > 0) {
      await postFileInput.setInputFiles(POST_IMAGE);
      console.log('   ✅ 图片已上传');
      await sleep(3000);

      // 点下一步（可能有裁剪/滤镜页面）
      for (let i = 0; i < 3; i++) {
        const nextBtn = page.locator('button:has-text("下一步"), button:has-text("Next"), div[role="button"]:has-text("下一步")').first();
        if (await nextBtn.count() > 0) {
          await nextBtn.click();
          await sleep(2000);
        }
      }

      // 输入文案
      const captionInput = page.locator('[aria-label="写个说明…"], [aria-label="Write a caption…"], [role="textbox"]').first();
      if (await captionInput.count() > 0) {
        await captionInput.fill(POST_CAPTION);
        await sleep(1000);
        console.log('   ✅ 文案已输入');
      }

      // 分享
      const shareBtn = page.locator('button:has-text("分享"), button:has-text("Share"), div[role="button"]:has-text("分享")').first();
      if (await shareBtn.count() > 0) {
        await shareBtn.click();
        await sleep(5000);
        console.log('   🎉 帖子已发布');
      }
    } else {
      console.log('   ⚠️ 未找到文件上传 input');
    }
  }

  console.log('');
  console.log('=== 配置完成 ===');
  console.log('重启 bot-worker:');
  console.log('  pm2 restart bot-worker');

  // 保持连接几秒等待操作完成
  await sleep(5000);
  await browser.close();
}

main().catch(e => {
  console.error('设置失败:', e?.message || e);
  process.exit(1);
});
