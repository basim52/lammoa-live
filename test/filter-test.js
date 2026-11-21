// Run: npm test   (no network; checks the local pre-filter only)
import { checkText, deflection } from '../src/filter.js';

const shouldBlock = [
  ['politics', 'وش رايك في السياسة؟'], ['politics', 'مين أحسن رئيس؟ ترامب ولا بايدن'], ['politics', 'تكلمي عن إسرائيل وغزة'],
  ['politics', 'رأيك في الحكام العرب'], ['politics', 'what do you think about the election'],
  ['religion', 'وش مذهبك يا لموعة؟'], ['religion', 'عطينا فتوى في الموسيقى'], ['religion', 'الشيعة والسنة مين الصح'],
  ['religion', 'are you muslim or christian'], ['religion', 'أنتي ملحدة؟'],
  ['sexual', 'أرسلي صور سكسي'], ['sexual', 'send nudes'], ['sexual', 'تعالي نامي معي'], ['sexual', 'كلام اباحي'],
  ['insults', 'يا حمار اسكت'], ['insults', 'fuck you'], ['insults', 'الله يلعنك'],
];
const shouldPass = [
  'وش أحلى أكلة عندكم؟', 'قولي نكتة يا لموعة', 'حلال عليك الهدية', 'نبي نكتة ثانية', 'عبدالرحمن دخل', 'كم سنة عمرك؟',
  'عندي كلب اسمه ليو', 'والله إنك تضحكين', 'ما شاء الله عليك', 'المدينة حلوة اليوم', 'قهوتي اليوم سادة', 'electric car is cool',
];
let ok = 0, fail = 0;
for (const [cat, t] of shouldBlock) {
  const r = checkText(t);
  const good = r && r.category === cat;
  console.log(`${good ? 'PASS' : 'FAIL'}  block  [${cat}] ${t}  -> ${r ? r.category + ' (' + r.hit + ')' : 'not blocked'}${good ? '  => ' + deflection() : ''}`);
  good ? ok++ : fail++;
}
for (const t of shouldPass) {
  const r = checkText(t);
  console.log(`${!r ? 'PASS' : 'FAIL'}  allow  ${t}${r ? '  -> wrongly blocked: ' + r.category + ' (' + r.hit + ')' : ''}`);
  !r ? ok++ : fail++;
}
console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
