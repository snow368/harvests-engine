/**
 * Discover supply brands on IG — search, scrape related accounts
 * Uses CDP Chrome (port 9222)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const OUTPUT = 'data/found_supply_brands.json';

// Search terms to find supply brands
const SEARCH_TERMS = [
  'tattoo supply',
  'tattoo needle cartridge',
  'tattoo machine',
  'tattoo ink',
  'tattoo equipment',
  'tattoo aftercare',
  'tattoo supply brand',
  'tattoo artist supply',
  'tattoo needles',
  'tattoo cartridge',
  'tattoo pigm',
  'tattoo stencil',
  'tattoo grip',
  'tattoo power supply',
  'rotary tattoo machine',
  'tattoo pen machine',
  'permanent makeup supply',
];
const MAX_RESULTS_PER_TERM = 20;

// Known brands to exclude (already have)
const EXISTING = new Set([
  'fkirons','cheyennetattoo','kwadron','worldfamousink','stigmarotary','bishoprotary',
  'eztattoosupply','dynamiccolor','intenzetattoo','tatsoul','silverbacktattoo','eternalink',
  'fusiontattoo','criticaltattoo','workhorseirons','neotat','inkjet','hustlebutter',
  'dragonhawktattoo','masttattoo','solongtattoo','peachtattoosupplies',
  'intenzetattooink','solidink','kurosumi_ink','radiantcolorsink','wickedink','dermaglo',
  'inkmachines_official','hkmachines','zeus_tattoo_machines','valhailajr','wand_tattoo',
  'cartridges_tattoo','empire_tattoo_supply','bnbtattoo','truetattoosupply',
  'painfulpleasures','killertattoosupply',
  'drmpickle','tattoogoo','madrabbit','recoverytattoo',
  'tommys_supplies','berlintattoosupply','monstersupplies','barberdtssupply',
  'vetus_tattoo','crown_tattoo_supply','element_tattoo_supply',
  'warthog_tattoo_supply','bishopsupply','electrum_tattoo',
  'nextgen_tattoo','keestone_tattoo','starling_tattoo_supply',
]);

async function main() {
  // Load existing
  let allFound: { handle: string; name: string; searchedBy: string; category: string }[] = [];
  if (fs.existsSync(OUTPUT)) {
    try { allFound = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch {}
  }
  console.log(`Existing: ${allFound.length} brands`);

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });

  const seen = new Set([...EXISTING, ...allFound.map(b => b.handle)]);

  for (const term of SEARCH_TERMS) {
    console.log(`\n=== Searching: "${term}" ===`);
    let got = 0;

    try {
      // Search
      await page.goto(`https://www.instagram.com/search?q=${encodeURIComponent(term)}`, {
        waitUntil: 'domcontentloaded', timeout: 30000
      });
      await sleep(3000);

      // Click on "Accounts" tab if visible
      try {
        const accountsTab = page.locator('a[href*="/search?q="][role="tab"]').filter({ hasText: /Accounts|账号/i }).first();
        if (await accountsTab.count() > 0) {
          await accountsTab.click();
          await sleep(2000);
        }
      } catch {}

      // Scroll to load more
      for (let s = 0; s < 5; s++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(1500);
      }

      // Extract account links
      const links = await page.$$eval('a[href*="/"]', els =>
        els.map(e => (e as HTMLAnchorElement).href)
          .filter(h => {
            const m = h.match(/instagram\.com\/([^/?]+)/);
            return m && !m[1].startsWith('explore') && !m[1].startsWith('search') && !m[1].startsWith('accounts') && !m[1].startsWith('direct');
          })
      );
      const uniqueHandles = [...new Set(links.map(h => {
        const m = h.match(/instagram\.com\/([^/?]+)/);
        return m ? m[1].toLowerCase() : '';
      }).filter(Boolean))];

      console.log(`  Found ${uniqueHandles.length} unique accounts in search`);

      for (const handle of uniqueHandles) {
        if (seen.has(handle)) continue;
        if (handle.length > 30 || handle.includes('_') && handle.split('_').length > 4) continue;

        seen.add(handle);
        got++;

        // Get account name/display name
        try {
          await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await sleep(2000);

          const displayName = await page.$eval('h2', el => el.textContent || '').catch(() => '');
          const bio = await page.$eval('span[dir="auto"]', el => el.textContent || '').catch(() => '');

          // Determine if it's supply-related by checking bio
          const bioLower = (bio || '').toLowerCase();
          const isSupply = /tattoo.?supply|needle|cartridge|tattoo.?machine|tattoo.?ink|tattoo.?equipment|tattoo.?product|tattoo.?tool|tattoo.?aftercare|permanent.?makeup|pmu.?supply|rotary|tattoo.?stencil/i.test(bioLower);
          const isArtist = /tattoo.?artist|tattooer|tattooist/i.test(bioLower) && !isSupply;

          if (!isSupply || isArtist) {
            console.log(`  ✗ ${handle}: ${displayName?.slice(0, 30)} (not supply)`);
            continue;
          }

          // Determine category
          let category = 'other_supply';
          if (/needle|cartridge/i.test(bioLower)) category = 'needle_cartridge';
          else if (/machine|rotary|pen|power supply/i.test(bioLower)) category = 'machine';
          else if (/ink|pigment|color/i.test(bioLower)) category = 'ink';
          else if (/aftercare|cream|ointment|heal/i.test(bioLower)) category = 'aftercare';
          else if (/stencil|transfer|paper/i.test(bioLower)) category = 'stencil';
          else if (/grip|tube|tip/i.test(bioLower)) category = 'accessory';

          allFound.push({ handle, name: displayName || '', searchedBy: term, category });
          console.log(`  ✓ ${handle} [${category}]: ${displayName?.slice(0, 40)}`);
          fs.writeFileSync(OUTPUT, JSON.stringify(allFound, null, 2), 'utf8');
        } catch (err: any) {
          console.log(`  ? ${handle}: ${err.message?.slice(0, 50)}`);
        }

        if (got >= MAX_RESULTS_PER_TERM) break;
        await sleep(2000 + Math.random() * 2000);
      }
    } catch (err: any) {
      console.log(`  Search error: ${err.message?.slice(0, 60)}`);
    }
  }

  console.log('\n=== Done ===');
  console.log(`Total found: ${allFound.length}`);
  const byCat: Record<string, number> = {};
  allFound.forEach(b => { byCat[b.category] = (byCat[b.category] || 0) + 1; });
  console.log('By category:'); Object.entries(byCat).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`));
  console.log('\nAll handles:'); allFound.forEach(b => console.log(`  ${b.handle} [${b.category}]`));

  await page.close();
  await browser.disconnect();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
