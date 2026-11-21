// Run: npm test (no network) — Arabic-only guard, TTS sentence split, filler pack sanity.
import fs from 'node:fs';
import path from 'node:path';
import { latinRatio, stripLatin } from '../src/brain.js';
import { splitForTts } from '../src/tts.js';
import { checkText } from '../src/filter.js';
let ok = 0, fail = 0;
function t(name, cond, info = '') { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  -> ' + info : ''}`); cond ? ok++ : fail++; }

t('arabic reply passes', latinRatio('هلا والله، كيفك اليوم؟') === 0);
t('english reply caught', latinRatio('Hello my friend, how are you?') > 0.12);
t('mixed english-heavy caught', latinRatio('أوكي so funny lol يا بطل') > 0.12);
t('stripLatin removes english', !/[A-Za-z]/.test(stripLatin('هلا OMG والله lol حلو')), stripLatin('هلا OMG والله lol حلو'));

const s1 = splitForTts('هلا والله! كيفك اليوم؟ وش سويت بالدوام؟');
t('split into sentences, first short', s1.length >= 2 && s1[0].split(' ').length <= 6, JSON.stringify(s1));
t('tiny first sentence merged', splitForTts('هلا! كيفك اليوم يا بطل؟')[0].includes('كيفك'));
t('max 3 chunks', splitForTts('أ ب ج. د ه و. ز ح ط. ي ك ل. م ن س.').length <= 3);
t('long single sentence split at comma', splitForTts('هذي جملة طويلة شوي وفيها كلام كثير، وبعدها يكمل الكلام لين آخر الجملة الطويلة').length === 2);

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'filler');
const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const total = man.clips.reduce((a, c) => a + c.d, 0);
t('filler ≈30 min of speech', total > 28 * 60000 && total < 40 * 60000, (total / 60000).toFixed(1) + ' min');
t('filler files exist', man.clips.every((c) => fs.existsSync(path.join(dir, c.f))));
t('filler text all Arabic', man.clips.every((c) => !/[A-Za-z]/.test(c.t)));
t('filler passes topic filter', man.clips.every((c) => !checkText(c.t)), (man.clips.find((c) => checkText(c.t)) || {}).t || '');
t('filler covers 6+ categories', new Set(man.clips.map((c) => c.cat)).size >= 6);

const { hedge } = await import('../src/hedge.js');
const sleep = (ms, v, fail) => () => new Promise((r, j) => setTimeout(() => (fail ? j(new Error(v)) : r(v)), ms));
let t0 = Date.now(); let v = await hedge([sleep(1500, 'slow'), sleep(100, 'fast')], 200);
t('hedge: backup wins when first is slow', v === 'fast' && Date.now() - t0 < 600, `${v} ${Date.now() - t0}ms`);
t0 = Date.now(); v = await hedge([sleep(50, 'first'), sleep(10, 'second')], 300);
t('hedge: no backup when first is quick', v === 'first' && Date.now() - t0 < 200);
t0 = Date.now(); v = await hedge([sleep(20, 'boom', true), sleep(30, 'ok')], 2000);
t('hedge: failure starts backup at once', v === 'ok' && Date.now() - t0 < 300, `${Date.now() - t0}ms`);
v = await hedge([sleep(10, 'a', true), sleep(10, 'b', true)], 50).catch((e) => 'rejected:' + e.message);
t('hedge: rejects when all fail', v === 'rejected:b' || v === 'rejected:a', v);
console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
