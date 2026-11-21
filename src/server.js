// لمّوعة — local server: overlay + control page + websocket + TikTok + Gemini.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ROOT, config } from './config.js';
import { EventQueue } from './queue.js';
import { replyTo, rememberSpoken, rememberTurn, conversationState, resetConversation } from './brain.js';
import { HearGate, transcribe } from './hear.js';
import { synthesize, ttsState, splitForTts, warmEdge } from './tts.js';
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
{ const push = queue.push.bind(queue); queue.push = (ev) => { const r = push(ev); if (r.ok) setImmediate(nudge); return r; }; }
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
// Stage pages get this key over the websocket so the tablet can send the streamer's speech without the control token.
const STAGE_KEY = crypto.randomBytes(12).toString('base64url');
function stageAuthed(req) {
  const t = String(req.headers['x-stage-key'] || '');
  const a = Buffer.from(t), b = Buffer.from(STAGE_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const hearGate = new HearGate();
let sttInFlight = 0; const sttTimes = [];
let micMode = null; // 'server' | 'web' | 'off' (null = config default)
let fillerOn = true; let fillerSeenAt = 0; // stage reports while it plays pre-recorded filler
const IDLE_MS = Number(process.env.IDLE_MS ?? 90000);
let lastActivity = Date.now();
let tiktokStatus = config.tiktokUsername ? 'connecting' : 'not-configured';

// ---------- HTTP ----------
const MIME = { '.mp3': 'audio/mpeg', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml' };
function readBody(req) {
  return new Promise((res) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } }); });
}
function readRaw(req, max = 1.5e6) {
  return new Promise((res, rej) => { const parts = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > max) { req.destroy(); rej(new Error('too large')); } else parts.push(c); }); req.on('end', () => res(Buffer.concat(parts))); req.on('error', rej); });
}
function heard(text, via) {
  const g = hearGate.check(text);
  if (!g.ok) { log(`[mic] ignored (${g.reason}): ${String(text || '').slice(0, 80)}`); return { ok: false, reason: g.reason }; }
  lastActivity = Date.now();
  const r = queue.push({ type: 'host', user: '', text: g.text, via });
  log(`[mic] heard (${via}): ${g.text}${r.ok ? '' : ' (' + r.reason + ')'}`);
  return { ok: r.ok || r.reason === 'merged-host', text: g.text, merged: r.reason === 'merged-host' };
}
function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/api/ping') { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end(); }
  if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (p === '/') { res.writeHead(302, { location: '/stage' }); return res.end(); }
  if (p === '/overlay' || p === '/stage') return sendFile(res, path.join(PUBLIC, p.slice(1) + '.html'));
  const stageOk = req.method === 'POST' && (p === '/api/hear' || p === '/api/hear-audio') && stageAuthed(req);
  const needsAuth = p === '/control' || p === '/api/status' || req.method === 'POST';
  if (needsAuth && !stageOk && !authed(req, url)) { res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('401: رابط لوحة التحكم يحتاج المفتاح السري ?token=...'); }
  if (p === '/control') return sendFile(res, path.join(PUBLIC, 'control.html'));
  if (p === '/api/config') return json(res, 200, { name: config.characterName, open: config.characterOpen, closed: config.characterClosed });
  if (p === '/api/status') return json(res, 200, { fillerOn, fillerPlayingRecently: Date.now() - fillerSeenAt < 60000, micMode: currentMicMode(), conversation: conversationState(), demo: DEMO, paused, queue: queue.length, stats: queue.stats, tiktok: tiktokStatus, tiktokUser: currentTikTok, hasKey: config.hasKey, tts: config.ttsEnabled, voice: config.voice, ttsEngine: config.ttsEngine, ttsLastEngine: ttsState.lastEngine, geminiTtsCooldownS: Math.max(0, Math.round((ttsState.geminiCooldownUntil - Date.now()) / 1000)), lastGeminiTtsError: ttsState.lastGeminiError, logs: logs.slice(-40), lastSpoken });
  if (p.startsWith('/audio/')) {
    const id = p.slice(7).replace(/\.(wav|mp3)$/, '');
    const a = audioStore.get(id);
    if (!a) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': a.mime, 'content-length': a.buf.length, 'cache-control': 'no-store' });
    return res.end(a.buf);
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
  if (req.method === 'POST' && p === '/api/hear') {
    // the streamer's speech as text (Web Speech on the tablet, or a test)
    const b = await readBody(req);
    return json(res, 200, heard(String(b.text || ''), String(b.via || 'text').slice(0, 12)));
  }
  if (req.method === 'POST' && p === '/api/hear-audio') {
    // one utterance as WAV from the tablet mic -> Gemini speech-to-text -> conversation
    const now = Date.now();
    while (sttTimes.length && now - sttTimes[0] > 60000) sttTimes.shift();
    if (sttInFlight >= 2 || sttTimes.length >= 30) return json(res, 429, { ok: false, reason: 'busy' });
    let wav;
    try { wav = await readRaw(req); } catch { return json(res, 413, { ok: false, reason: 'too-large' }); }
    if (wav.length < 2000 || wav.toString('ascii', 0, 4) !== 'RIFF') return json(res, 400, { ok: false, reason: 'bad-audio' });
    sttTimes.push(now); sttInFlight++;
    try {
      const t0 = Date.now();
      const text = await transcribe(wav);
      const ms = Date.now() - t0;
      if (!text) { log(`[mic] no clear speech (${Math.round(wav.length / 32)}ms audio, stt ${ms}ms)`); return json(res, 200, { ok: false, reason: 'no-speech' }); }
      return json(res, 200, { ...heard(text, 'mic'), sttMs: ms });
    } catch (e) {
      log('[mic] stt failed:', e.message);
      return json(res, 200, { ok: false, reason: 'stt-error' });
    } finally { sttInFlight--; }
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
    if (b.action === 'forget') resetConversation();
    if (b.action === 'filler' && typeof b.on === 'boolean') { fillerOn = b.on; saveState({ ...loadState(), fillerOn }); broadcast({ type: 'filler', on: fillerOn }); }
    if (b.action === 'mic' && ['server', 'web', 'off', 'default'].includes(b.mode)) {
      micMode = b.mode === 'default' ? null : b.mode;
      saveState({ ...loadState(), micMode });
      broadcast({ type: 'mic', mode: currentMicMode() });
    }
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
function currentMicMode() { return micMode || config.micMode; }
wss.on('connection', (ws) => {
  if (config.ttsEngine === 'edge') warmEdge();
  ws.send(JSON.stringify({ type: 'hello', name: config.characterName, stageKey: STAGE_KEY, micMode: currentMicMode(), filler: fillerOn }));
  ws.on('message', (d) => { try { const m = JSON.parse(String(d).slice(0, 200)); if (m.type === 'filler-on') fillerSeenAt = Date.now(); } catch {} });
});

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
let wake = null; // resolves the worker's idle wait as soon as something is queued
function nudge() { if (wake) { const w = wake; wake = null; w(); } }
const idleWait = (ms) => new Promise((r) => { wake = r; setTimeout(() => { if (wake === r) wake = null; r(); }, ms); });

async function worker() {
  for (;;) {
    if (!paused && queue.length === 0 && IDLE_MS > 0 && Date.now() - lastActivity > IDLE_MS && wss.clients.size > 0 && Date.now() - fillerSeenAt > 60000) {
      lastActivity = Date.now();
      queue.push({ type: 'idle', user: '', text: '' });
    }
    if (paused || queue.length === 0) { await idleWait(250); continue; }
    const ev = queue.next();
    if (!ev) continue;
    const started = Date.now();
    try {
      let reply;
      if (ev.type === 'say' && ev.direct) { reply = { text: ev.text, source: 'host' }; rememberTurn('lammoa', ev.text); }
      else reply = await replyTo(ev);
      const tBrain = Date.now() - started;
      let audioUrl = null; let durationMs = Math.max(2500, reply.text.length * 70); let ttsErr = null;
      const sid = crypto.randomBytes(4).toString('hex');
      const chunks = config.ttsEnabled ? splitForTts(reply.text) : [];
      const synths = chunks.map((t) => synthesize(t).catch((e) => ({ error: e })));
      const store = (r) => {
        const id = crypto.randomBytes(6).toString('hex');
        audioStore.set(id, { buf: r.audio, mime: r.mime });
        if (audioStore.size > 40) audioStore.delete(audioStore.keys().next().value);
        if (SAVE_AUDIO) fs.writeFileSync(path.join(ROOT, 'audio', `${id}.${r.ext}`), r.audio);
        return { audioUrl: `/audio/${id}.${r.ext}`, audioB64: r.audio.length < 300000 ? r.audio.toString('base64') : undefined, mime: r.mime };
      };
      let first = null;
      if (synths.length) {
        const r = await synths[0];
        if (r.error) { ttsErr = r.error.message; log('[tts] failed, text-only:', r.error.message); }
        else { first = store(r); audioUrl = first.audioUrl; durationMs = r.durationMs; }
      }
      const firstText = chunks[0] || reply.text;
      const estTotal = first ? Math.round(durationMs * reply.text.length / Math.max(1, firstText.length)) : durationMs;
      skipCurrent = false;
      const msg = { type: 'speak', sid, eventType: ev.type, heard: ev.type === 'host' ? ev.text : undefined, user: (ev.type === 'say' || ev.type === 'idle' || ev.type === 'host') ? '' : ev.user, comment: ev.type === 'chat' ? ev.text : (ev.type === 'gift' ? `🎁 ${ev.gift || ''}${ev.count > 1 ? ' ×' + ev.count : ''}` : ''), text: reply.text, source: reply.source, audioUrl, audioB64: first?.audioB64, mime: first?.mime, durationMs, estTotalMs: estTotal, parts: first ? chunks.length : 1 };
      const tFirst = Date.now() - started;
      rememberSpoken(reply.text);
      broadcast(msg);
      const speakAt = Date.now();
      let total = durationMs;
      if (first) {
        for (let i = 1; i < synths.length; i++) {
          const r = await synths[i];
          if (r.error) { broadcast({ type: 'speak-part', sid, index: i, durationMs: 0 }); continue; }
          const a = store(r); total += r.durationMs;
          broadcast({ type: 'speak-part', sid, index: i, ...a, durationMs: r.durationMs });
        }
      }
      durationMs = total;
      lastSpoken = { ...msg, audioB64: undefined, durationMs: total, brainMs: tBrain, firstAudioMs: tFirst, totalMs: tFirst, ttsError: ttsErr, blocked: reply.blocked || null };
      log(`[out] (${reply.source}${reply.blocked ? ':' + reply.blocked.category : ''}, brain ${tBrain}ms, first audio ${tFirst}ms, parts ${msg.parts}, audio ${audioUrl ? Math.round(total / 100) / 10 + 's' : 'none'}) ${reply.text}`);
      // wait for speech to finish + breathing gap, honoring min interval
      const speechEnd = speakAt + durationMs + (ev.type === 'host' ? 500 : 1200);
      const waitUntil = Math.max(started + config.replyIntervalMs, speechEnd);
      // a conversation turn from the streamer doesn't wait for the comment interval
      while (Date.now() < waitUntil && !skipCurrent && !(Date.now() >= speechEnd && queue.items[0]?.type === 'host')) await sleep(100);
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
  micMode = loadState().micMode || null;
  if (typeof loadState().fillerOn === 'boolean') fillerOn = loadState().fillerOn;
  log(`Mic (streamer conversation): ${currentMicMode()}`);
  const saved = loadState().tiktokUsername;
  if (DEMO) { tiktokStatus = 'demo-mode'; log('Demo mode: TikTok not connected; use the control page.'); }
  else if (saved || config.tiktokUsername) startTikTok(saved || config.tiktokUsername);
  else { tiktokStatus = 'not-configured'; log('TikTok username not set: set it from the control page.'); }
  worker();
  if (config.ttsEngine === 'edge') { warmEdge(); setInterval(() => { if (wss.clients.size > 0) warmEdge(); }, 150000); }
});
