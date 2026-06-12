/**
 * Verify supply brand IG handles — check which ones exist
 * Uses CDP Chrome (port 9222)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const OUTPUT = 'data/verified_supply_brands.json';

// Comprehensive list of potential tattoo supply IG handles to verify
const CANDIDATES = [
  // === Needle/Cartridge specific (HIGH priority) ===
  'cheyennetattooequipment', 'cheyennetattoo', 'cheyenne_professional',
  'fkirons', 'fkironsofficial', 'fk_irons',
  'bishoprotary', 'bishop_rotary', 'bishop_tattoo',
  'kwadron', 'kwadronofficial',
  'intenzetattoo', 'intenzetattooink', 'intenze_ink',
  'stigmarotary', 'stigmatattoosupply', 'stigma_tattoo',
  'dragonhawktattoo', 'dragonhawkofficial', 'dragonhawk_global',
  'workhorseirons', 'workhorse_irons',
  'masttattoo', 'mast_tattoo_supply', 'masttattoosupply',
  'solongtattoo', 'solong_tattoo',
  'eikondevice', 'eikontattoo', 'eikon_tattoo',
  'elitetattoo', 'elite_tattoo_supply',
  'viciousink', 'vicious_ink',
  'inkjecta', 'inkjecta_tattoo',
  'young_tattoo_supply', 'youngtatt',
  'neotat', 'neotat_official',
  'criticaltattoo', 'critical_tattoo',
  'fusiontattoo', 'fusion_tattoo_supply',
  'tatsoul', 'tatsoul_official',
  'eternalink', 'eternal_tattoo_ink', 'eternaltattoosupply',
  'solidinktattoo', 'solid_ink_tattoo',
  'radiantcolorsink', 'radiant_colors_ink',
  'worldfamousink', 'worldfamoustattoosupply', 'worldfamous_tattoo',
  'dynamiccolortattoo', 'dynamicstattoosupply', 'dynamic_tattoo_supply',
  'silverbacktattoo', 'silverback_tattoo',
  'hustlebutter', 'hustle_butter',
  'tattoogoo', 'tattoo_goo',
  'drmpickle', 'dr_pickle',
  'madrabbit', 'mad_rabbit_tattoo',
  'recoverytattoo', 'tattoo_recovery',

  // === Additional brands ===
  'peachtattoosupplies', 'peach_tattoo',
  'ace_tattoo_supply', 'acetattoosupply',
  'zoraypt', 'zoray_tattoo',
  'electrum_tattoo', 'electrum_supply',
  'bnbtattoo', 'bnb_tattoo_supply',
  'truetattoosupply', 'true_tattoo_supply',
  'painfulpleasures', 'painful_pleasures',
  'killertattoosupply', 'killer_ink',
  'empire_tattoo_supply', 'empiretattoo',
  'kingpintattoosupply', 'kingpin_tattoo',
  'alliancetattoosupply', 'alliance_tattoo_supply',
  'onyxtattoosupply', 'onyx_tattoo_supply',
  'elementtattoosupply', 'element_tattoo_supply',
  'crown_tattoo_supply',
  'warthog_tattoo_supply', 'warthogtattoo',
  'nextgen_tattoo', 'nextgentattoosupply',
  'keestone_tattoo', 'keestonetattoo',
  'starling_tattoo_supply', 'starlingtattoo',
  'berlintattoosupply', 'berlin_tattoo_supply',
  'tommys_supplies', 'tommys_tattoo_supply',
  'monstersupplies', 'monster_tattoo_supply',
  'barberdtssupply', 'barberdts',
  'tattoosupply24_7', 'tattoosupply247',
  'vetus_tattoo', 'vetustattoo',
  'ace_tattoo_supply', 'acetattoo',
  'inkjet', 'ink_jet_tattoo',
  'hkmachines', 'hk_machines',
  'zeus_tattoo_machines', 'zeustattoo',
  'valhailajr', 'valhaila_jr',
  'wand_tattoo', 'wandtattoo',
  'dermaglo', 'derma_glo',
  'wickedink', 'wicked_ink',
  'kurosumi_ink', 'kurosumi_official',
  'cartridges_tattoo',
  'eztattoosupply', 'ez_tattoo_supply',
  'inkmachines_official',

  // === Chinese OEM/Manufacturers (PEACH competitors) ===
  'inksoultattoosupply', 'inksoul_tattoo',
  'inkintattoosupply', 'inkin_tattoo_supply',
  'tattooneedledragon', 'needle_dragon',
  'shanghaitattoopro', 'shanghai_tattoo',
  'shenzheninkmaster', 'inkmaster_tattoo',
  'guangzhoutattoogear', 'tattoogear',
  'beijingtattoosupply', 'beijing_tattoo',
  'hangzhoutattoosolution', 'hztattoo',
  'nantatt', 'nantattoo',
  'tianjintattoo', 'tianjin_tattoo',
  'wuhantattoo', 'wuhan_tattoo_supply',
  'chengdutattoo', 'chengdu_tattoo',
  'lotustattoo_supply', 'lotus_tattoo',
  'eagletattoosupply', 'eagle_tattoo',
  'sun_tattoo_supply', 'suntattoo',
  'jztattoo', 'jz_tattoo_supply',
  'ht_tattoo_supply', 'httattoo',
  'tattoo_star', 'tattoostar',
  'cn_tattoo_supply', 'cntattoo',
  'fjtattoo', 'fj_tattoo_supply',
  'gdtattoo', 'gd_tattoo_supply',
  'king_tattoo_supply', 'kingtattoo_supply',
  'best_tattoo_supply', 'besttattoo',
  'top_tattoo_supply', 'toptattoo',
  'pro_tattoo_supply', 'protattoo',
  'new_tattoo_supply', 'newtattoo',
  'one_tattoo_supply', 'onetattoo',
  'btfl_tattoo', 'btfltattoo',
  'tattoomart', 'tattoo_mart',
  'tattoo_wholesale', 'tattoowholesale',

  // === European brands ===
  'mickey_sharps', 'mickeysharps',
  'barb_tattoo_supply', 'barbsupply',
  'lion_tattoo_supply', 'liontattoo',
  'euro_tattoo_supply', 'eurotattoo',
  'south_tattoo_supply', 'southtattoo',
  'north_tattoo_supply', 'northtattoo',
  'tattooworld_supply', 'tattooworld',
  'tattoo_studio_supply', 'tattoostudiosupply',
  'ink_empire', 'inkempire',
  'tattoo_center', 'tattoocenter',

  // === Aftercare specific ===
  'aftercare_tattoo', 'tattoo_aftercare',
  'healing_tattoo', 'tattoo_healing',
  'second_skin_tattoo', 'secondskin',

  // === Machine specific ===
  'coil_machine', 'coiltattoo',
  'rotary_machine_tattoo', 'rotarytattoo',
  'pen_machine_tattoo', 'pentattoo',
  'tattoo_machine_shop', 'tattoomachineshop',
  'machine_tattoo_supply', 'machinetattoo',
];

async function main() {
  let verified: { handle: string; exists: boolean; name: string; bio: string; category: string }[] = [];
  if (fs.existsSync(OUTPUT)) {
    try { verified = JSON.parse(fs.readFileSync(OUTPUT, 'utf8')); } catch {}
  }
  const done = new Set(verified.map(v => v.handle));
  const remaining = CANDIDATES.filter(h => !done.has(h));
  console.log(`Existing: ${verified.length}, Remaining: ${remaining.length}`);

  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = await context.newPage();

  let checked = 0;
  for (const handle of remaining) {
    try {
      await page.goto(`https://www.instagram.com/${handle}/`, {
        waitUntil: 'domcontentloaded', timeout: 15000
      });
      await sleep(2000);

      const url = page.url();
      const exists = !url.includes('/404/') && !url.includes('/notfound/') && url.includes(handle);

      let name = '', bio = '';
      if (exists) {
        name = await page.$eval('h2', el => el.textContent || '').catch(() => '') || '';
        const bioEls = await page.$$('span[dir="auto"]').catch(() => []);
        for (const el of bioEls) {
          const t = await el.textContent().catch(() => '') || '';
          if (t.length > 10) { bio = t; break; }
        }
      }

      // Auto-categorize
      const lower = (name + ' ' + bio).toLowerCase();
      let category = 'other';
      if (/needle|cartridge|tip|taper/i.test(lower)) category = 'needle_cartridge';
      else if (/machine|rotary|pen|iron|pencil|driver/i.test(lower) && !/stencil|transfer|aftercare|ink/i.test(lower)) category = 'machine';
      else if (/ink|pigment|color/i.test(lower) && !/machine|needle|cartridge/i.test(lower)) category = 'ink';
      else if (/aftercare|cream|ointment|heal|balm|moisturizer|soap|wash/i.test(lower)) category = 'aftercare';
      else if (/stencil|transfer|paper|printer/i.test(lower)) category = 'stencil';
      else if (/grip|tube|holder|clip|cord|pedal|power/i.test(lower)) category = 'accessory';
      else if (/supply|equipment|product|shop|store|distributor|wholesale/i.test(lower)) category = 'general_supply';

      verified.push({ handle, exists, name, bio: bio.slice(0, 200), category });
      if (exists) {
        console.log(`✓ ${handle} [${category}]: ${name.slice(0, 40)}`);
      } else {
        console.log(`✗ ${handle}`);
      }
      checked++;

      if (checked % 20 === 0) {
        fs.writeFileSync(OUTPUT, JSON.stringify(verified, null, 2), 'utf8');
        console.log(`  [saved ${verified.length}]`);
      }

      await sleep(1000 + Math.random() * 1500);
    } catch (err: any) {
      console.log(`? ${handle}: ${err.message?.slice(0, 50)}`);
      verified.push({ handle, exists: false, name: '', bio: '', category: 'error' });
      await sleep(3000);
    }
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(verified, null, 2), 'utf8');

  // Stats
  const existing = verified.filter(v => v.exists);
  const byCat: Record<string, number> = {};
  existing.forEach(v => { byCat[v.category] = (byCat[v.category] || 0) + 1; });
  console.log(`\n=== Done ===`);
  console.log(`Verified: ${verified.length}`);
  console.log(`Existing: ${existing.length}`);
  console.log('By category:');
  Object.entries(byCat).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => console.log(`  ${k}: ${v}`));
  console.log('\nExisting handles:');
  existing.sort((a,b) => a.category.localeCompare(b.category)).forEach(v =>
    console.log(`  ${v.handle} [${v.category}] — ${v.name.slice(0, 40)}`)
  );

  await page.close();
  await browser.disconnect();
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
