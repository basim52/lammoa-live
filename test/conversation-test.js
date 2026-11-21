// Run: npm test   (no network) — streamer speech gate, queue priority, conversation memory, filters on heard speech.
import { HearGate, cleanTranscript } from '../src/hear.js';
import { EventQueue } from '../src/queue.js';
import { buildHostPrompt, rememberTurn, rememberComment, conversationState, resetConversation, replyTo } from '../src/brain.js';

let ok = 0, fail = 0;
function t(name, cond, info = '') { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  -> ' + info : ''}`); cond ? ok++ : fail++; }

// 1) noise / filler / duplicate gate
const g = new HearGate({ minIntervalMs: 0 });
let now = 1e6;
t('ignore empty', !g.check('', now).ok);
t('ignore too short', g.check('اه', now).reason === 'too-short');
t('ignore filler', g.check('امم طيب', now).reason === 'filler');
t('ignore noise letters', !g.check('ههههههه', now).ok);
t('accept real speech', g.check('لموعة وش رايك نسوي تحدي الليلة؟', now).ok);
t('dedupe same sentence', g.check('لموعة وش رايك نسوي تحدي الليلة', now + 3000).reason === 'duplicate');
t('allow repeat after window', g.check('لموعة وش رايك نسوي تحدي الليلة', now + 20000).ok);
t('accept short greeting', g.check('هلا لموعة', now + 21000).ok);
const g2 = new HearGate({ minIntervalMs: 1200 });
g2.check('أول جملة طويلة شوي', now);
t('rate limit too-fast', g2.check('جملة ثانية مختلفة', now + 300).reason === 'too-fast');
t('transcript <empty> -> ""', cleanTranscript('<empty>') === '' && cleanTranscript(' «هلا والله» ') === 'هلا والله');

// 2) queue: host speech jumps ahead of comments/gifts, merges if he keeps talking
const q = new EventQueue();
q.push({ type: 'chat', user: 'سارة', text: 'وش أحلى أكلة؟' });
q.push({ type: 'gift', user: 'نوف', gift: 'وردة' });
q.push({ type: 'host', user: '', text: 'لموعة اسمعي' });
const m = q.push({ type: 'host', user: '', text: 'عندي لك سؤال' });
t('host merged while pending', m.reason === 'merged-host');
const first = q.next();
t('host first in queue', first.type === 'host' && first.text === 'لموعة اسمعي عندي لك سؤال', first.text);
t('gift next', q.next().type === 'gift');

// 3) conversation memory goes into the prompt
resetConversation();
rememberTurn('host', 'وش أكثر شي تحبينه؟');
rememberTurn('lammoa', 'الشاهي الحار طبعاً! وأنت وش مشروبك؟');
rememberComment('سارة', 'مساء الخير', 'مساء النور يا سارة');
const p = buildHostPrompt('أنا أحب القهوة السوداء');
t('prompt has previous host turn', p.includes('وش أكثر شي تحبينه؟'));
t('prompt has previous Lammoa turn', p.includes('الشاهي الحار طبعاً'));
t('prompt has comment context', p.includes('مساء الخير'));
t('prompt has current speech', p.includes('أنا أحب القهوة السوداء'));
for (let i = 0; i < 15; i++) rememberTurn(i % 2 ? 'lammoa' : 'host', 'سطر ' + i);
t('memory capped at 10 turns', conversationState().convo.length === 10);

// 4) forbidden topics in heard speech are deflected locally (no model call)
resetConversation();
const r1 = await replyTo({ type: 'host', text: 'لموعة وش رايك في الانتخابات والحكومة؟' });
t('politics speech -> prefilter', r1.source === 'prefilter' && r1.blocked?.category === 'politics', r1.text);
const r2 = await replyTo({ type: 'host', text: 'وش مذهبك يا لموعة' });
t('religion speech -> prefilter', r2.source === 'prefilter' && r2.blocked?.category === 'religion', r2.text);
t('deflection remembered in memory', conversationState().convo.length === 4);

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
