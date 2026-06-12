/**
 * Quick test for comment-generator.ts
 * Tests: basic generation, dedup, fallback, language detection
 */
import 'dotenv/config';
import { generateComment, warmupCommentPool, clearRecentHistory } from './comment-generator';

async function main() {
  console.log('=== Comment Generator Test ===\n');

  // Test 1: Basic generation (English, tattoo caption)
  console.log('--- Test 1: Basic tattoo comment ---');
  const r1 = await generateComment({
    caption: 'Finished this black and grey realism piece today. 8 hours of work. @client',
    style: 'black_and_grey',
    styleConfidence: 'high',
    likeCount: 120,
    commentCount: 8,
  });
  console.log(`[${r1.style}] ${r1.text}`);
  console.log();

  // Test 2: Short praise (casual post)
  console.log('--- Test 2: Short praise ---');
  const r2 = await generateComment({
    caption: 'New flash sheet available',
    style: 'various',
    likeCount: 45,
    commentCount: 3,
  });
  console.log(`[${r2.style}] ${r2.text}`);
  console.log();

  // Test 3: Reel
  console.log('--- Test 3: Reel comment ---');
  const r3 = await generateComment({
    caption: 'Quick process video of this sleeve progress #tattoo #sleeve',
    isReel: true,
    likeCount: 340,
    commentCount: 22,
  });
  console.log(`[${r3.style}] ${r3.text}`);
  console.log();

  // Test 4: Dedup check (generate multiple, should be different)
  console.log('--- Test 4: Multi-generate dedup ---');
  for (let i = 0; i < 5; i++) {
    const r = await generateComment({
      caption: 'New traditional style piece, bold lines and solid color.',
      style: 'traditional',
      styleConfidence: 'high',
      likeCount: 200,
      commentCount: 15,
    });
    console.log(`  [${i}] [${r.style}] ${r.text}`);
  }
  console.log();

  // Test 5: Pool warmup
  console.log('--- Test 5: Warmup comment pool ---');
  const pool = await warmupCommentPool(3);
  console.log(`Pool size: ${pool.length}`);
  pool.forEach((c, i) => console.log(`  [${i}] ${c}`));
  console.log();

  // Test 6: No style confidence (low)
  console.log('--- Test 6: Low style confidence ---');
  const r6 = await generateComment({
    caption: 'New tattoo flash available in shop. Walk-ins welcome!',
    styleConfidence: 'low',
    likeCount: 30,
    commentCount: 2,
  });
  console.log(`[${r6.style}] ${r6.text}`);
  console.log();

  console.log('=== All tests completed ===');
}

main().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
