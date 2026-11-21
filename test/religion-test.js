// Run: node test/religion-test.js — her own replies must never carry religious references.
import { checkReply, checkText } from '../src/filter.js';
import fs from 'node:fs';
let pass = 0, fail = 0;
const t = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`); };
const bad = ['الصوت واضح كأنه أذان المغرب في رمضان', 'صوتك يجنن مثل المؤذن', 'بعد الصلاة نكمل السالفة', 'رمضان كريم يا جماعة', 'خلونا نروح المسجد', 'اقرا القرآن', 'دعواتكم لي', 'ادعي لك من قلبي', 'وقت السحور أحلى', 'صايمة اليوم ههه', 'كأنك في التراويح', 'رحنا العمرة', 'هذا حرام عليك', 'يا الله الجنة', 'مثل الشيطان ههه', 'بس الإفطار جاهز', 'صلاتك قبل البث'];
for (const b of bad) t('blocks: ' + b, !!checkReply(b));
const ok = ['والله إنك فنان', 'إن شاء الله البث يكون حلو', 'ما شاء الله عليك', 'الحمدلله بخير', 'نبي نسوي تحدي الليلة', 'قدام الشاشة الكل متحمس', 'عمره ما فاز في التحدي', 'يوم الجمعة نطلع كشتة', 'صدقني الكبسة أحلى', 'جامعتي كانت بعيدة', 'عيد ميلادك سعيد', 'إذن نبدأ التحدي', 'جيب السجادة للكشتة', 'دعوة عشاء عند خالي'];
for (const o of ok) t('allows: ' + o, !checkReply(o), JSON.stringify(checkReply(o)));
t('viewer/host input saying رمضان is not deflected by the input filter', !checkText('رمضان كريم'));
const man = JSON.parse(fs.readFileSync(new URL('../public/filler/manifest.json', import.meta.url)));
const badFiller = man.clips.filter((c) => checkReply(c.t));
t('pre-recorded filler has no religious references', badFiller.length === 0, badFiller.slice(0, 5).map((c) => c.f + ': ' + c.t + ' ' + JSON.stringify(checkReply(c.t))).join('\n'));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
