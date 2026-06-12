/**
 * 生成品牌核对表 — 品牌名称、IG链接、官网、简介
 *
 * 用法: npx tsx scripts/_brand_verification_table.ts
 * 输出: data/brand_verification_table.csv
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import 'dotenv/config';

const PROFILE_DIR = 'F:/inkflow/bot_profiles/bot_publish_01_chrome_data';
const OUTPUT = 'data/brand_verification_table.csv';

const TARGET_BRANDS: Record<string, string[]> = {
  needles_cartridges: [
    'kwadron', 'kwadronofficial',
    'neotat', 'neotat_official',
    'mickeysharps', 'mickey_sharps',
    'tatsoul', 'tatsoul_official',
    'lotustattoo_supply',
  ],
  machines_pens: [
    'fkirons', 'fkironsofficial',
    'bishoprotary',
    'stigmarotary', 'stigmatattoosupply',
    'workhorseirons',
    'eikondevice', 'eikontattoo',
    'dragonhawktattoo', 'dragonhawkofficial', 'dragonhawk_global',
    'masttattoo', 'mast_tattoo_supply', 'masttattoosupply',
    'cheyennetattooequipment',
    'zeustattoo', 'zeus_tattoo_machines',
    'pentattoo', 'rotarytattoo',
  ],
  ink: [
    'worldfamousink',
    'intenzetattooink', 'intenze_ink',
    'eternalink', 'eternal_tattoo_ink',
    'dynamiccolortattoo',
    'radiantcolorsink', 'radiant_colors_ink',
    'kurosumi_ink', 'kurosumi_official',
    'killer_ink', 'viciousink',
    'inkjecta', 'inkjecta_tattoo',
    'solidinktattoo', 'wickedink',
  ],
  aftercare: [
    'hustlebutter', 'hustle_butter',
    'tattoogoo', 'tattoo_goo',
    'madrabbit', 'mad_rabbit_tattoo',
    'recoverytattoo', 'tattoo_recovery',
    'drmpickle', 'dr_pickle',
    'secondskin', 'second_skin_tattoo',
    'tattoo_healing', 'healing_tattoo',
  ],
};

function jitter(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function main() {
  console.log('=== Brand Verification Table Generator ===');

  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-infobars'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = browser.pages()[0] || await browser.newPage();

  // Login
  await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  if (page.url().includes('accounts/login')) {
    console.log('⚠️  Log in manually, then press Enter.');
    await new Promise<void>(r => { process.stdin.once('data', () => r()); });
    await page.waitForTimeout(3000);
  }

  // CSV header
  const rows: string[] = ['Category,Brand Handle,IG URL,Display Name,Bio (first 120),Website,Lang,Followers,Follower Text,Status'];

  for (const [category, brands] of Object.entries(TARGET_BRANDS)) {
    for (const brand of brands) {
      process.stdout.write(`\n  @${brand} ... `);
      let name = '', bio = '', website = '', followers = '', lang = '', status = 'ok';

      try {
        await page.goto(`https://www.instagram.com/${brand}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForSelector('main', { state: 'visible', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(jitter(3000, 5000));

        const info = await page.evaluate(() => {
          // Display name: first h2 or h1 in header
          const nameEl = document.querySelector('header h2, header h1, section h2');
          const dName = nameEl?.textContent?.trim() || '';

          // Bio: first span or div with bio content
          const spans = document.querySelectorAll('header span, section span');
          let bioText = '';
          for (const s of spans) {
            const t = s.textContent?.trim() || '';
            if (t.length > 15 && !t.includes(' followers') && !t.includes(' following') && !t.includes(' posts')) {
              bioText = t;
              break;
            }
          }

          // Website: look for a link in bio area
          const links = document.querySelectorAll('header a[href^="http"], section a[href^="http"]');
          let site = '';
          for (const a of links) {
            const h = (a as HTMLAnchorElement).href;
            if (!h.includes('instagram.com') && !h.includes('facebook.com') && !h.includes('twitter.com') && !h.includes('tiktok.com') && !h.includes('youtube.com')) {
              site = h;
              break;
            }
          }

          // Follower count text (raw)
          const followerEls = document.querySelectorAll<HTMLElement>('a[href*="/followers"] span, a[href*="followers"] span');
          let flw = '';
          for (const el of followerEls) {
            const t = el.getAttribute('title') || el.textContent || '';
            if (/\d/.test(t)) { flw = t.trim(); break; }
          }

          // Language detection: check for Chinese chars in bio
          const hasChinese = /[一-鿿]/.test(bioText + dName);
          const detectedLang = hasChinese ? 'zh' : 'en';

          return { name: dName, bio: bioText.slice(0, 120), website: site, followers: flw, lang: detectedLang };
        });

        name = info.name;
        bio = info.bio.replace(/,/g, '，'); // avoid CSV comma issues
        website = info.website;
        followers = info.followers;
        lang = info.lang;

        // If no website, check if the bio contains a domain
        if (!website) {
          const dm = info.bio.match(/(?:https?:\/\/)?([\w-]+\.\w{2,})(?:\/\S*)?/);
          if (dm) website = dm[1];
        }

        process.stdout.write(`${followers}粉, lang=${lang}`);
      } catch (e: any) {
        status = 'error: ' + e.message.slice(0, 40);
        process.stdout.write(`❌ ${status}`);
      }

      // Escape fields for CSV
      const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
      const igUrl = `https://www.instagram.com/${brand}/`;
      rows.push([category, brand, igUrl, name, esc(bio), esc(website), lang, followers, esc(followers), status].join(','));

      await new Promise(r => setTimeout(r, jitter(2000, 4000)));
    }
  }

  // Write CSV
  fs.writeFileSync(OUTPUT, '﻿' + rows.join('\n'), 'utf8'); // BOM for Excel
  console.log(`\n\nDone! Saved ${rows.length-1} brands to ${OUTPUT}`);
  console.log('Open in Excel or Google Sheets to review.');

  await browser.close();
}

main().catch(e => { console.error('Fatal:', e?.message || e); process.exit(1); });
