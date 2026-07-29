import fs from 'node:fs';

const file = 'data/brand_captions_dataset.json';
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
let fixes = 0;

for (const item of d) {
  if (item.content && item.content.includes('\\n')) {
    // Replace literal backslash-n with actual newlines
    item.content = item.content.replace(/\\n/g, '\n');
    fixes++;
  }
}

fs.writeFileSync(file, JSON.stringify(d, null, 2));
console.log(`Fixed: ${fixes} captions`);
console.log(`Total: ${d.length} posts, ${d.reduce((s, x) => s + (x.commentCount || 0), 0)} comments`);
