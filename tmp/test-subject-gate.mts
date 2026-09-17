// 主题闸门（tattoo / piercing）回归测试
//   node --import tsx tmp/test-subject-gate.mts
//
// 背景：`like_skip_piercing` 把整场 like session 打成 liked:0（09-17 实测 8 连跳、liked 0）。
// 真因 = STRONG_PIERCING 用 text.includes() 做子串匹配，`stud` 命中 `studio`、`rook` 命中
// `Brooklyn` ⇒ 纹身工作室的正常文案被误判成穿孔 ⇒ 该候选被整个跳过。
// 本测试用「纹身场景必然出现」的文案做假阳性护栏，同时保证真穿孔仍被拦下。

import { detectSubject, isPiercingHandle } from '../scripts/tattoo-voice.ts';

type Row = { text: string; expect: 'piercing' | 'not_piercing' };

const TATTOO_TEXTS: string[] = [
  'Fresh piece for Alyssa, done at the studio today #fineline #tattoo',
  'Bookings open for October. Studied under a great mentor. #tattooartist',
  'Healed at 6 weeks, single pass, no blowouts',
  'Custom blackwork sleeve in progress',
  'Traditional rose, bold will hold',
  'Student work day — first ever tattoo on real skin',
  'Brooklyn based tattoo artist — flash drop Friday',
  'New set of needle cartridges came in, testing grouping',
  'Thank you for the trust, first tattoo for this client',
  'Industrial style blackwork piece finished today',
  'Used a 12 gauge liner on the fine lines',
  'Snug healed result, client is happy',
  'Hooped a rose with dotwork, super clean',
  'Plugged away at this back piece for 3 sessions',
  'Stretching a coverup over old ink',
  'Body art showcase — full sleeve today',
  'Studio open, walk-ins welcome',
  'Linework day. Studs of the machine hummed along nicely',
];

const PIERCING_TEXTS: string[] = [
  'Septum piercing with implant grade titanium',
  'Nostril hoop fresh today ✨ #piercing',
  'Daith + tragus combo healed nicely',
  'body jewellery restock — barbell sets',
  'ear piercing studio, appointments only',
];

const rows: Row[] = [
  ...TATTOO_TEXTS.map((text) => ({ text, expect: 'not_piercing' as const })),
  ...PIERCING_TEXTS.map((text) => ({ text, expect: 'piercing' as const })),
];

let pass = 0;
let fail = 0;
console.log('--- 主题闸门回归 ---');
for (const r of rows) {
  const res = detectSubject(r.text, [], 'sometattoostudio');
  const isP = res.subject === 'piercing';
  const ok = r.expect === 'piercing' ? isP : !isP;
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  expect=${r.expect.padEnd(13)} got=${String(res.subject).padEnd(8)} src=${String(res.source).padEnd(8)} sig=[${res.signals.join('|')}]  «${r.text.slice(0, 58)}»`
  );
}

// handle 级判据（穿孔号必须直接拦下，与文案无关）
const handleCases: Array<[string, boolean]> = [
  ['bodypiercingbykayla', true],
  ['dermal.decor.piercing', true],
  ['pierc_and_ink', false],
  ['inkbombtattoos', false],
  ['studio_piercer', true],
  ['tattoostudio', false],
];
console.log('--- handle 判据 ---');
for (const [h, want] of handleCases) {
  const got = isPiercingHandle(h);
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  handle=@${h.padEnd(22)} want=${want} got=${got}`);
}

console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail > 0) {
  console.log('❌ 闸门仍会误杀纹身帖（liked 会继续为 0）');
  process.exit(1);
} else {
  console.log('✅ 纹身帖 0 假阳性，真穿孔仍被拦下');
}
