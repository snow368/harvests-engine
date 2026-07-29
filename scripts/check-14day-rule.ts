/**
 * 14天规则查询 — 查未付款网站
 *
 * 查询 site_configs 中 publishedAt 超过 3/7/14 天
 * 且没有对应 active subscription 的记录
 *
 * 用法:
 *   先登录 snow368 的 Cloudflare 账号:
 *     wrangler login
 *   然后运行:
 *     npx tsx scripts/check-14day-rule.ts
 *
 *   或者用 wrangler d1 直接查:
 *     wrangler d1 execute inkflow-db --remote --command="$(cat scripts/check-14day-rule.sql)"
 */
import 'dotenv/config';

const API_BASE = 'https://ink-flow-api.inkflowapp.workers.dev';

interface SiteConfig {
  id: string;
  artistId: string;
  slug: string;
  studioName: string;
  template: string;
  city: string;
  state: string;
  publishedAt: number;
  updatedAt: number;
}

interface Subscription {
  userId: string;
  planTier: string;
  status: string;
  expiresAt: number;
}

async function main() {
  console.log('Fetching site configs...');
  // Note: This API endpoint may not exist publicly.
  // If it fails, use wrangler d1 execute instead.
  const resp = await fetch(`${API_BASE}/api/sites/all`);
  if (!resp.ok) {
    console.log('API not accessible. Use wrangler d1 execute instead:');
    console.log('');
    console.log('  wrangler d1 execute inkflow-db --remote --command="');
    console.log("    SELECT s.id, s.slug, s.studioName, s.city, s.state, s.publishedAt,");
    console.log("      CASE");
    console.log("        WHEN (CAST(strftime('%s','now') AS INTEGER) - s.publishedAt/1000) < 3*86400 THEN 'under_3d'");
    console.log("        WHEN (CAST(strftime('%s','now') AS INTEGER) - s.publishedAt/1000) < 7*86400 THEN '3_7d'");
    console.log("        WHEN (CAST(strftime('%s','now') AS INTEGER) - s.publishedAt/1000) < 14*86400 THEN '7_14d'");
    console.log("        ELSE 'over_14d'");
    console.log("      END as period,");
    console.log("      (SELECT COUNT(*) FROM subscriptions sub WHERE sub.userId = s.artistId AND sub.status = 'active') as active_subs");
    console.log("    FROM site_configs s");
    console.log("    WHERE s.publishedAt IS NOT NULL");
    console.log("    ORDER BY s.publishedAt ASC;");
    console.log('  "');
    return;
  }

  const sites: SiteConfig[] = await resp.json();
  const now = Math.floor(Date.now() / 1000);

  console.log(`Total sites: ${sites.length}\n`);

  const buckets = { under_3d: [] as any[], days_3_7: [] as any[], days_7_14: [] as any[], over_14d: [] as any[] };

  for (const site of sites) {
    if (!site.publishedAt) continue;

    // Check subscription
    const subResp = await fetch(`${API_BASE}/api/subscription/status?userId=${site.artistId}`);
    const subData = await subResp.json();
    const hasActiveSub = subData.active === true;

    if (hasActiveSub) continue; // Skip if has active subscription

    const ageSec = now - (site.publishedAt / 1000);
    const days = ageSec / 86400;

    if (days < 3) buckets.under_3d.push({ ...site, daysAgo: days.toFixed(1) });
    else if (days < 7) buckets.days_3_7.push({ ...site, daysAgo: days.toFixed(1) });
    else if (days < 14) buckets.days_7_14.push({ ...site, daysAgo: days.toFixed(1) });
    else buckets.over_14d.push({ ...site, daysAgo: days.toFixed(1) });
  }

  console.log('=== 14天规则查询结果 ===\n');
  console.log(`📊 未付款网站统计:`);
  console.log(`   3天内: ${buckets.under_3d.length} 个`);
  console.log(`   3-7天: ${buckets.days_3_7.length} 个（需发第3天提醒）`);
  console.log(`   7-14天: ${buckets.days_7_14.length} 个（需发第7天提醒）`);
  console.log(`   超过14天: ${buckets.over_14d.length} 个（应自动删除）`);
  console.log(`   总计: ${buckets.under_3d.length + buckets.days_3_7.length + buckets.days_7_14.length + buckets.over_14d.length} 个\n`);

  if (buckets.days_3_7.length > 0) {
    console.log('🔔 第3天提醒（需发邮件）:');
    buckets.days_3_7.forEach((s: any) => console.log(`   ${s.slug} | ${s.studioName || '?'} | ${s.city} | ${s.daysAgo}天`));
  }

  if (buckets.days_7_14.length > 0) {
    console.log('\n⚠️ 第7天提醒（7天后将删除）:');
    buckets.days_7_14.forEach((s: any) => console.log(`   ${s.slug} | ${s.studioName || '?'} | ${s.city} | ${s.daysAgo}天`));
  }

  if (buckets.over_14d.length > 0) {
    console.log('\n🗑️ 超过14天（应自动删除）:');
    buckets.over_14d.forEach((s: any) => console.log(`   ${s.slug} | ${s.studioName || '?'} | s.city} | ${s.daysAgo}天`));
  }
}

main().catch(e => console.error(e));
