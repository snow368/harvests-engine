import fs from 'node:fs';

const raw = JSON.parse(
  fs.readFileSync('data/geonames_us_places_by_state.json', 'utf-8')
);

const states = raw.states || raw;
const wa = (states['WA'] || states['Washington'] || []) as { name: string; population: number }[];

console.log(`WA cities total: ${wa.length}`);

// Already scraped
const done = new Set(['Seattle']);
const remaining = wa
  .map((c: { name: string }) => c.name)
  .filter((n: string) => !done.has(n));

console.log(`Remaining: ${remaining.length}`);
console.log('First 30:', remaining.slice(0, 30));
console.log('\n=== JSON array ===');
console.log(JSON.stringify(remaining));
