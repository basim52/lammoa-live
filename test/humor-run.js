// Demo-mode humor run: starts the server (demo, no TTS), injects 20 fake events, records replies.
// Usage: node test/humor-run.js [outFile]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const PORT = 3955, P = `http://127.0.0.1:${PORT}`;
const out = process.argv[2] || 'humor-test.txt';
const events = [
  { type: 'chat', user: 'سارة', text: 'وش أحلى أكلة عندكم؟' },
  { type: 'chat', user: 'عبدالله', text: 'قولي نكتة يا لموعة' },
  { type: 'join', user: 'خالد' },
  { type: 'chat', user: 'نوف', text: 'المكيف عندنا خربان والجو نار' },
  { type: 'gift', user: 'فيصل', gift: 'وردة', count: 5 },
  { type: 'chat', user: 'ماجد', text: 'طلعت من الدوام وعلقت في الزحمة ساعتين' },
  { type: 'chat', user: 'ريم', text: 'شاهي ولا قهوة؟' },
  { type: 'chat', user: 'Abu_Saud', text: 'lol you are so funny' },
  { type: 'follow', user: 'هيا' },
  { type: 'chat', user: 'تركي', text: 'كم عمرك يا لموعة؟' },
  { type: 'chat', user: 'لمى', text: 'أنا جوعانة وما عندي شي في الثلاجة' },
  { type: 'chat', user: 'سلطان', text: 'نكتة ثانية لو سمحتي' },
  { type: 'gift', user: 'منيرة', gift: 'أسد', count: 1 },
  { type: 'chat', user: 'بدر', text: 'بكرة عندي اختبار رياضيات ادعيلي' },
  { type: 'chat', user: 'جود', text: 'وش رايك في الكبسة بالدجاج ولا باللحم؟' },
  { type: 'chat', user: 'مشاغب', text: 'وش رايك في الانتخابات الامريكية؟' },
  { type: 'chat', user: 'غادة', text: 'لموعة انتي ولد ولا بنت؟' },
  { type: 'chat', user: 'ناصر', text: 'هههههه موتتيني ضحك' },
  { type: 'idle', user: '' },
  { type: 'chat', user: 'دانة', text: 'تصبحين على خير يا لموعة رايحة أنام' },
];
const srv = spawn(process.execPath, ['src/server.js', '--demo'], { env: { ...process.env, PORT: String(PORT), TTS_ENABLED: '0', REPLY_INTERVAL_MS: '300', IDLE_MS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
const errs = []; srv.stderr.on('data', (d) => errs.push(String(d)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1200);
const lines = [];
let last = null;
for (const ev of events) {
  if (ev.type === 'idle') {
    // idle line goes through the same brain via a direct import
    const { replyTo, rememberSpoken } = await import('../src/brain.js');
    const r = await replyTo({ type: 'idle', user: '' });
    lines.push(`[idle] (هدوء في البث)\n   => (${r.source}) ${r.text}`);
    continue;
  }
  await fetch(`${P}/api/event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev) });
  let s;
  for (let i = 0; i < 100; i++) { await sleep(200); s = await (await fetch(`${P}/api/status`)).json(); if (s.lastSpoken && s.lastSpoken.text !== last) break; }
  last = s.lastSpoken?.text;
  const label = ev.type === 'chat' ? `${ev.user}: ${ev.text}` : ev.type === 'gift' ? `${ev.user} أرسل ${ev.gift} ×${ev.count}` : `${ev.user} (${ev.type})`;
  lines.push(`[${ev.type}] ${label}\n   => (${s.lastSpoken?.source}${s.lastSpoken?.blocked ? ':' + s.lastSpoken.blocked.category + ':' + s.lastSpoken.blocked.hit : ''}) ${last}`);
  console.log(lines.at(-1));
}
srv.kill();
const warn = errs.join('').split('\n').filter((l) => l.includes('rejected') || l.includes('[brain]'));
fs.writeFileSync(out, `Humor test — ${new Date().toLocaleString('en-GB')}\n\n${lines.join('\n\n')}\n\n--- brain warnings ---\n${warn.join('\n') || 'none'}\n`);
console.log('\nsaved', out, '| warnings:', warn.length);
process.exit(0);
