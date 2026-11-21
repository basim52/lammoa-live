// لمّوعة — local server: overlay + control page + websocket + TikTok + Gemini.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ROOT, config } from './config.js';
import { EventQueue } from './queue.js';
import { replyTo, rememberSpoken } from './brain.js';
import { synthesize } from './tts.js';
import { connectTikTok } from './tiktok.js';

const DEMO = process.argv.includes('--demo') || process.env.DEMO === '1';
const SAVE_AUDIO = process.env.SAVE_AUDIO === '1';
const PUBLIC = path.join(ROOT, 'public');
const logs = [];
function log(...a) {
  const line = `[${new Date().toLocaleTimeString('en-GB')}] ${a.join(' ')}`;
  console.log(line);
  logs.push(line); if (logs.length > 200) logs.shift();
  broadcast({ type: 'log', line });
}

const queue = new EventQueue({ welcomeIntervalMs: config.welcomeIntervalMs });
const audioStore = new Map(); // id -> wav buffer (last 30)
let paused = false;
let skipCurrent = false;
let lastSpoken = null;
// Control token: required for /control and all write/status APIs when set (always set when listening publicly).
const CONTROL_TOKEN = process.env.CONTROL_TOKEN || (config.host !== '127.0.0.1' && config.host !== 'localhost' ? crypto.randomBytes(9).toString('base64url') : '');
function authed(req, url) {
  if (!CONTROL_TOKEN) return true;
  const t = url.searchParams.get('token') || req.headers['x-control-token'] || '';
  const a = Buffer.from(String(t)), b = Buffer.from(CONTROL_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const IDLE_MS = Number(process.env.IDLE_MS ?? 90000);
let lastActivity = Date.now();
let tiktokStatus = config.tiktokUsername ? 'connecting' : 'not-configured';

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };
function readBody(req) {
  return new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } }); });
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/api/ping') { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (p === '/') { res.writeHead(302, { location: '/stage' }); return res.end(); }
  if (p === '/overlay' || p === '/stage') return sendFile(res, path.join(PUBLIC, p.slice(1) + '.html'));
  const needsAuth = p === '/control' || p === '/api/status' || req.method === 'POST';
  if (needsAuth && !authed(req, url)) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('401: رابط لوحة التحكم يحتاج المفتاح السري ?token=...'); }
  if (p === '/control') return sendFile(res, path.join(PUBLIC, 'control.html'));
  if (p === '/api/config') return json(res, 200, { name: config.characterName, open: config.characterOpen, closed: config.characterClosed });
  if (p === '/api/status') return json(res, 200, { demo: DEMO, paused, queue: queue.length, stats: queue.stats, tiktok: tiktokStatus, tiktokUser: currentTikTok, hasKey: config.hasKey, tts: config.ttsEnabled, voice: config.voice, logs: logs.slice(-40), lastSpoken });
  if (p.startsWith('/audio/')) {
    const id = p.slice(7).replace(/\.wav$/, '');
    const buf = audioStore.get(id);
    if (!buf) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': buf.length, 'cache-control': 'no-store' });
    return res.end(buf);
  }
  if (req.method === 'POST' && p === '/api/event') {
    const b = await readBody(req);
    const ev = { type: String(b.type || 'chat'), user: String(b.user || 'ضيف').slice(0, 40), text: String(b.text || '').slice(0, 300), gift: b.gift ? String(b.gift).slice(0, 40) : undefined, count: Number(b.count || 1), source: 'manual' };
    if (!['chat', 'gift', 'join', 'follow', 'like'].includes(ev.type)) return json(res, 400, { ok: false });
    lastActivity = Date.now();
    const r = queue.push(ev);
    log(`[in] ${ev.type} ${ev.user}: ${ev.text || ev.gift || ''} -> ${r.ok ? 'queued' : 'skipped (' + r.reason + ')'}`);
    return json(res, 200, r);
  }
  if (req.method === 'POST' && p === '/api/say') {
    const b = await readBody(req);
    const text = String(b.text || '').trim().slice(0, 300);
    if (!text) return json(res, 400, { ok: false });
    // host's own words: spoken as-is, jumps the queue
    queue.push({ type: 'say', user: '', text, direct: true });
    log(`[in] say: ${text}`);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/tiktok') {
    const b = await readBody(req);
    const u = String(b.username || '').replace(/^@/, '').trim().slice(0, 40);
    if (u && !/^[A-Za-z0-9._]+$/.test(u)) return json(res, 400, { ok: false, error: 'bad username' });
    saveState({ ...loadState(), tiktokUsername: u });
    if (u) { log(`[control] TikTok -> @${u}`); startTikTok(u); } else { if (tt) tt.stop(); tt = null; currentTikTok = ''; tiktokStatus = 'stopped'; log('[control] TikTok stopped'); }
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && p === '/api/control') {
    const b = await readBody(req);
    if (b.action === 'pause') paused = true;
    if (b.action === 'resume') paused = false;
    if (b.action === 'skip') { skipCurrent = true; broadcast({ type: 'stop' }); }
    if (b.action === 'clear') queue.items = [];
    log(`[control] ${b.action}`);
    return json(res, 200, { ok: true, paused });
  }
  // static
  const f = path.normalize(path.join(PUBLIC, p));
  if (!f.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  return sendFile(res, f);
});
function sendFile(res, f) {
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of wss?.clients || []) if (c.readyState === 1) c.send(s);
}
wss.on('connection', (ws) => { ws.send(JSON.stringify({ type: 'hello', name: config.characterName })); });

// ---------- TikTok (can be changed at runtime from the control page) ----------
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'state.json');
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(st) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(st)); } catch {} }
let tt = null; let currentTikTok = '';
function startTikTok(username) {
  if (tt) { tt.stop(); tt = null; }
  currentTikTok = username.replace(/^@/, '').trim();
  if (!currentTikTok) { tiktokStatus = 'not-configured'; return; }
  tiktokStatus = 'connecting';
  tt = connectTikTok(currentTikTok, (ev) => {
    if (!ev.user && ev.type !== 'like') ev.user = 'ضيف';
    lastActivity = Date.now();
    const r = queue.push(ev);
    if (ev.type !== 'like' && ev.type !== 'join') log(`[tiktok] ${ev.type} ${ev.user}: ${ev.text || ev.gift || ''}${r.ok ? '' : ' (skip ' + r.reason + ')'}`);
  }, log, (st) => { tiktokStatus = st; });
}

// ---------- Worker ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function worker() {
  for (;;) {
    if (!paused && queue.length === 0 && IDLE_MS > 0 && Date.now() - lastActivity > IDLE_MS && wss.clients.size > 0) {
      lastActivity = Date.now();
      queue.push({ type: 'idle', user: '', text: '' });
    }
    if (paused || queue.length === 0) { await sleep(250); continue; }
    const ev = queue.next();
    if (!ev) continue;
    const started = Date.now();
    try {
      let reply;
      if (ev.type === 'say' && ev.direct) reply = { text: ev.text, source: 'host' };
      else reply = await replyTo(ev);
      const tBrain = Date.now() - started;
      let audioUrl = null; let durationMs = Math.max(2500, reply.text.length * 70); let ttsErr = null;
      if (config.ttsEnabled && config.hasKey) {
        try {
          const { wav, durationMs: d } = await synthesize(reply.text);
          const id = crypto.randomBytes(6).toString('hex');
          audioStore.set(id, wav);
          if (audioStore.size > 30) audioStore.delete(audioStore.keys().next().value);
          if (SAVE_AUDIO) fs.writeFileSync(path.join(ROOT, 'audio', `${id}.wav`), wav);
          audioUrl = `/audio/${id}.wav`; durationMs = d;
        } catch (e) { ttsErr = e.message; log('[tts] failed, text-only:', e.message); }
      }
      skipCurrent = false;
      const msg = { type: 'speak', eventType: ev.type, user: (ev.type === 'say' || ev.type === 'idle') ? '' : ev.user, comment: ev.type === 'chat' ? ev.text : (ev.type === 'gift' ? `🎁 ${ev.gift || ''}${ev.count > 1 ? ' ×' + ev.count : ''}` : ''), text: reply.text, source: reply.source, audioUrl, durationMs };
      rememberSpoken(reply.text);
      lastSpoken = { ...msg, brainMs: tBrain, totalMs: Date.now() - started, ttsError: ttsErr, blocked: reply.blocked || null };
      broadcast(msg);
      log(`[out] (${reply.source}${reply.blocked ? ':' + reply.blocked.category : ''}, brain ${tBrain}ms, total ${Date.now() - started}ms, audio ${audioUrl ? Math.round(durationMs / 100) / 10 + 's' : 'none'}) ${reply.text}`);
      // wait for speech to finish + breathing gap, honoring min interval
      const waitUntil = Math.max(started + config.replyIntervalMs, Date.now() + durationMs + 1200);
      while (Date.now() < waitUntil && !skipCurrent) await sleep(100);
      lastActivity = Date.now();
    } catch (e) {
      log('[worker] error:', e.message);
      await sleep(1000);
    }
  }
}

server.listen(config.port, config.host, () => {
  const base = process.env.PUBLIC_URL || `http://localhost:${config.port}`;
  log(`لمّوعة شغالة: stage ${base}/stage  overlay ${base}/overlay  control ${base}/control${CONTROL_TOKEN ? '?token=' + CONTROL_TOKEN : ''}`);
  log(`Gemini key: ${config.hasKey ? 'loaded' : 'MISSING (text fallback only)'} | text=${config.textModels.join('|')} tts=${config.ttsModels.join('|')} voice=${config.voice}`);
  const saved = loadState().tiktokUsername;
  if (DEMO) { tiktokStatus = 'demo-mode'; log('Demo mode: TikTok not connected; use the control page.'); }
  else if (saved || config.tiktokUsername) startTikTok(saved || config.tiktokUsername);
  else { tiktokStatus = 'not-configured'; log('TikTok username not set: set it from the control page.'); }
  worker();
});
