import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.NEON_DATABASE_URL!;
const sql = neon(DATABASE_URL);

async function main() {
  const rows = await sql`
    SELECT DISTINCT city FROM artists
    WHERE source_type = 'maps_scrape' AND import_region = 'WA'
    ORDER BY city
  `;
  const cities = rows.map((r: any) => r.city);
  console.log(`count: ${cities.length}`);
  console.log(JSON.stringify(cities));
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
