import { neon } from '@neondatabase/serverless';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';

// Load .env for Neon URL
const envRaw = fs.readFileSync('.env', 'utf-8');
for (const line of envRaw.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    process.env[key] = val;
  }
}

const sql = neon(process.env.NEON_DATABASE_URL || process.env.VITE_NEON_DATABASE_URL || '');
const FIRESTORE_DB_ID = 'ai-studio-fdd43a35-6e73-47fa-8125-b804dd3f9ad5';
const PROJECT_ID = 'gen-lang-client-0029855360';

async function main() {
  // 1. Get all valid Neon artist IDs
  console.log('Fetching Neon artist IDs...');
  const neonRows = await sql`SELECT id FROM artists`;
  const neonIds = new Set(neonRows.map((r: any) => String(r.id)));
  console.log(`Neon has ${neonIds.size} artists`);

  // 2. Initialize Firestore
  const app = initializeApp({
    projectId: PROJECT_ID,
  });
  const db = getFirestore(app, FIRESTORE_DB_ID);

  // 3. Scan Firestore artists collection
  console.log('Scanning Firestore artists collection...');
  let totalFs = 0;
  let deleted = 0;
  let batch: any[] = [];
  const BATCH_SIZE = 500;

  const snapshot = await db.collection('artists').get();
  totalFs = snapshot.size;
  console.log(`Firestore has ${totalFs} artist docs`);

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const docId = data?.id ? String(data.id) : doc.id;

    // Delete if not in Neon
    if (!neonIds.has(docId)) {
      batch.push(doc.ref);
    }
  }

  // Also delete all docs from other collections (pure Firestore data)
  const otherCollections = ['interactions', 'orders', 'accounts', 'assignments'];
  for (const colName of otherCollections) {
    const colSnap = await db.collection(colName).get();
    console.log(`Firestore ${colName}: ${colSnap.size} docs`);
    for (const doc of colSnap.docs) {
      batch.push(doc.ref);
    }
  }

  console.log(`Total docs to delete: ${batch.length}`);

  // Execute batch deletes
  for (let i = 0; i < batch.length; i += BATCH_SIZE) {
    const chunk = batch.slice(i, i + BATCH_SIZE);
    const writeBatch = db.batch();
    chunk.forEach(ref => writeBatch.delete(ref));
    await writeBatch.commit();
    console.log(`  Deleted ${Math.min(i + BATCH_SIZE, batch.length)} / ${batch.length}`);
  }

  console.log(`\nDone! Deleted ${batch.length} docs total.`);
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
