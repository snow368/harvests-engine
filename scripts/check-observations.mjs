import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, '..', 'data', 'deep_scan_tasks.db'));

// Look at full profile_facts_json
const rows = db.prepare('SELECT * FROM bot_observations ORDER BY id DESC LIMIT 5').all();
rows.forEach(r => {
  console.log(`\n=== id=${r.id} bot=${r.bot_id} handle=@${r.artist_handle} ===`);
  try {
    const facts = JSON.parse(r.profile_facts_json);
    console.log('  title:', facts.title?.slice(0, 80));
    console.log('  bio:', facts.bio?.slice(0, 120));
    console.log('  followers:', facts.followers);
    console.log('  following:', facts.following);
    console.log('  postCount:', facts.postCount);
    console.log('  category:', facts.categoryLabel);
    console.log('  email:', facts.email);
    console.log('  externalUrl:', facts.externalUrl);
    if (facts.imageAltHints) console.log('  altHints:', facts.imageAltHints.slice(0, 5));
    if (facts.statTexts) console.log('  stats:', facts.statTexts);
  } catch(e) {}
  try {
    const summary = JSON.parse(r.summary_json);
    console.log('  summary:', JSON.stringify(summary));
  } catch(e) {}
});

// Check how many observations each bot has
const bots = db.prepare('SELECT bot_id, mode, COUNT(*) as cnt FROM bot_observations GROUP BY bot_id, mode').all();
console.log('\n=== OBSERVATIONS BY BOT/MODE ===');
bots.forEach(b => console.log(`  ${b.bot_id} / ${b.mode}: ${b.cnt}`));

db.close();
