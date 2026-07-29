import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

/**
 * Probe v11 — 精确提取评论每条字段
 */
import 'dotenv/config';
import { chromium } from 'playwright';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  await page.goto('https://www.instagram.com/miguelnatantattoo/p/DYhTttblgQm/', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await sleep(3000);

  const comments = await page.evaluate(() => {
    const results: any[] = [];

    document.querySelectorAll('span').forEach(span => {
      if (span.textContent?.trim() !== 'Reply') return;

      const container = span.parentElement?.parentElement?.parentElement;
      if (!container || container.children.length < 2) return;
      // 只有真正的评论容器才有 _ap3a (用户名)
      if (!container.querySelector('._ap3a')) return;

      const c0 = container.children[0];
      const c1 = container.children[1];

      // Username
      const usernameEl = c0.querySelector('._ap3a');
      const username = usernameEl?.textContent?.trim() || '';

      // Timestamp from <time> element
      const timeEl = c0.querySelector('time');
      const timestamp = timeEl?.textContent?.trim() || '';

      // Comment text: everything in c0 minus username
      const c0Text = c0.textContent || '';
      const afterUsername = c0Text.replace(username, '').replace('Verified', '').trim();
      // afterUsername = "3dBeautiful 🔥" or "3d Foda demais meu irmão 🔥🙌❤️"
      // Remove leading timestamp
      const commentText = afterUsername.replace(/^\d+[dwmyh]\s*/, '').trim();

      // Likes count from c1
      const c1Text = c1.textContent || '';
      const likesMatch = c1Text.match(/(\d+)\s+likes|1\s+like/);
      let likes = 0;
      if (c1Text.includes('1 like')) likes = 1;
      else if (likesMatch) likes = parseInt(likesMatch[1]) || 0;

      // Also extract the full text for debug
      results.push({
        username,
        timestamp,
        comment: commentText,
        likes,
        hasVerified: c0Text.includes('Verified'),
      });
    });

    return results;
  });

  console.log(`Found ${comments.length} comments`);
  comments.slice(0, 10).forEach((c, i) => {
    console.log(`\n[${i}] @${c.username} (${c.timestamp}) ${c.hasVerified ? '✓ ' : ''}`);
    console.log(`    "${c.comment.slice(0, 100)}"`);
    console.log(`    ❤️ ${c.likes}`);
  });

  // Count verification rate
  const verified = comments.filter(c => c.hasVerified).length;
  console.log(`\nVerified: ${verified}/${comments.length}`);
  console.log(`Sample with comment text > 0: ${comments.filter(c => c.comment.length > 0).length}/${comments.length}`);

  await page.close();
  await browser.close();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
