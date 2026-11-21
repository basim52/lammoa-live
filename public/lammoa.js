// Shared character logic for /overlay and /stage
const qs = new URLSearchParams(location.search);
if (qs.get('bg')) document.body.classList.add(qs.get('bg'));
if (qs.get('side') === 'right') document.body.classList.add('right');
if (qs.get('scale')) document.documentElement.style.setProperty('--s', qs.get('scale'));
const $ = (id) => document.getElementById(id);
const imgOpen = $('imgOpen'), imgClosed = $('imgClosed'), bodyEl = $('body');

fetch('/api/config').then(r => r.json()).then(c => { imgOpen.src = c.open; imgClosed.src = c.closed; $('tag').textContent = c.name; });

// ---- audio ----
let ctx, analyser, limiter, data, currentSrc = null, level = 0, talkingUntil = 0, fakeTalk = false;
function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)(); analyser = ctx.createAnalyser(); analyser.fftSize = 1024; data = new Uint8Array(analyser.fftSize);
    // soft limiter so louder voice never clips on the tablet speaker
    limiter = ctx.createDynamicsCompressor(); limiter.threshold.value = -3; limiter.knee.value = 6; limiter.ratio.value = 8; limiter.attack.value = 0.003; limiter.release.value = 0.15;
    analyser.connect(limiter); limiter.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
  return ctx;
}
ensureCtx();
if ($('hint')) {
  setTimeout(() => { if (ctx.state !== 'running' && !window.obsstudio) $('hint').style.display = 'block'; }, 800);
  $('hint').onclick = () => { ensureCtx(); $('hint').style.display = 'none'; };
}
window.unlockAudio = () => { ensureCtx(); try { const b = ctx.createBuffer(1, 1, 22050); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0); } catch {} };
document.addEventListener('click', ensureCtx);

function stopAudio() { try { currentSrc && currentSrc.stop(); } catch {} currentSrc = null; }

function b64ToBuf(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
async function playUrl(url, b64) {
  ensureCtx();
  const buf = b64 ? b64ToBuf(b64) : await (await fetch(url)).arrayBuffer();
  const audio = await ctx.decodeAudioData(buf);
  stopAudio();
  const src = ctx.createBufferSource(); src.buffer = audio;
  // Edge voice comes out quieter than Gemini's: lift it a bit (filler files are already loudness-normalized)
  const gain = ctx.createGain(); gain.gain.value = (/\.mp3$/.test(url || '') && !/^\/filler\//.test(url || '')) ? 1.6 : 1;
  src.connect(gain); gain.connect(analyser); src.start();
  currentSrc = src;
  window.__lastAudio = { url, duration: audio.duration, startedAt: Date.now(), ctxState: ctx.state };
  return new Promise(res => { src.onended = () => res(); });
}

// ---- bubble ----
let hideTimer, wordTimer;
function showBubble(m) {
  clearTimeout(hideTimer); clearInterval(wordTimer);
  const who = $('who');
  if (m.heard) { who.classList.add('on'); $('user').textContent = '🎤'; $('comment').textContent = m.heard; }
  else if (m.user) { who.classList.add('on'); $('user').textContent = '@' + m.user; $('comment').textContent = m.comment || ''; }
  else who.classList.remove('on');
  const words = m.text.split(/\s+/);
  $('text').innerHTML = words.map(w => `<span class="w">${w.replace(/[<&>]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</span>`).join(' ');
  $('bubble').classList.add('show');
  const spans = [...document.querySelectorAll('#text .w')];
  const per = Math.max(90, (m.estTotalMs || m.durationMs || 3000) / Math.max(1, spans.length));
  let i = 0; spans[0] && spans[0].classList.add('on');
  wordTimer = setInterval(() => { i++; if (i >= spans.length) return clearInterval(wordTimer); spans[i].classList.add('on'); }, per);
}
function hideBubbleSoon(ms = 2500) { clearTimeout(hideTimer); hideTimer = setTimeout(() => $('bubble').classList.remove('show'), ms); }

function setSpeaking(v) { window.__speaking = v; dispatchEvent(new CustomEvent('lammoa:speaking', { detail: v })); }
let speakSeq = 0;
const partStore = new Map(), partWaiters = new Map();
function gotPart(p) { const k = p.sid + ':' + p.index; partStore.set(k, p); if (partStore.size > 30) partStore.delete(partStore.keys().next().value); const w = partWaiters.get(k); if (w) { partWaiters.delete(k); w(p); } }
function waitPart(sid, i, ms) { const k = sid + ':' + i; if (partStore.has(k)) return Promise.resolve(partStore.get(k)); return new Promise((res) => { partWaiters.set(k, res); setTimeout(() => { if (partWaiters.get(k) === res) { partWaiters.delete(k); res(null); } }, ms); }); }
async function speak(m) {
  const my = ++speakSeq;
  setSpeaking(true);
  showBubble(m);
  burst(28);
  if (m.audioUrl) {
    try { fakeTalk = false; await playUrl(m.audioUrl, m.audioB64); }
    catch (e) { console.warn('audio failed, text-only', e); fakeTalk = true; await new Promise(r => setTimeout(r, m.durationMs)); }
    // remaining sentences (synthesized in parallel on the server) arrive as speak-part messages
    for (let i = 1; i < (m.parts || 1); i++) {
      if (my !== speakSeq) return false;
      const part = await waitPart(m.sid, i, 12000);
      if (my !== speakSeq) return false;
      if (part && part.audioUrl) { await new Promise((r) => setTimeout(r, 120)); try { await playUrl(part.audioUrl, part.audioB64); } catch (e) { console.warn('part failed', e); } }
    }
  } else { fakeTalk = true; await new Promise(r => setTimeout(r, m.durationMs || 3000)); }
  if (my !== speakSeq) return false; // a newer line took over
  fakeTalk = false;
  setSpeaking(false);
  document.querySelectorAll('#text .w').forEach(s => s.classList.add('on'));
  hideBubbleSoon();
  return true;
}

// ---- websocket ----
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  window.__ws = ws;
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'speak') { window.__lastMsg = m; dispatchEvent(new CustomEvent('lammoa:live')); speak(m); } if (m.type === 'speak-part') gotPart(m); if (m.type === 'stop') { stopAudio(); hideBubbleSoon(300); } if (m.type === 'hello') dispatchEvent(new CustomEvent('lammoa:hello', { detail: m })); if (m.type === 'mic') dispatchEvent(new CustomEvent('lammoa:mic', { detail: m.mode })); if (m.type === 'filler') dispatchEvent(new CustomEvent('lammoa:filler', { detail: m.on })); };
  ws.onopen = () => document.body.classList.add('online');
  ws.onclose = () => { document.body.classList.remove('online'); setTimeout(connect, 1500); };
}
connect();

// ---- animation loop: mouth + squash + sparkles ----
const fx = $('fx'), g = fx.getContext('2d');
function resize() { fx.width = innerWidth * devicePixelRatio; fx.height = innerHeight * devicePixelRatio; }
addEventListener('resize', resize); resize();
const parts = [];
const COLORS = ['#3FC1C9', '#1E5EFF', '#FFC93C', '#FF8A1E', '#FF4D6D'];
function charCenter() { const r = imgOpen.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * .45, w: r.width, h: r.height }; }
function spawn(n = 1) {
  const c = charCenter(); if (!c.w) return;
  for (let k = 0; k < n; k++) {
    const a = Math.random() * Math.PI * 2, r = c.w * (.35 + Math.random() * .3);
    parts.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * 1.1, vx: (Math.random() - .5) * .6, vy: -(.4 + Math.random() * 1.2), life: 1, size: (4 + Math.random() * 7) * devicePixelRatio, star: Math.random() < .35, col: COLORS[(Math.random() * COLORS.length) | 0] });
  }
}
function burst(n) { spawn(n); }
function drawStar(x, y, s) { g.beginPath(); for (let i = 0; i < 8; i++) { const r = i % 2 ? s * .35 : s; const a = i * Math.PI / 4 - Math.PI / 2; g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } g.closePath(); g.fill(); }
let t0 = performance.now(), mouthOpen = false, lastFlip = 0;
function frame(now) {
  // audio level
  let lv = 0;
  if (analyser && currentSrc) { analyser.getByteTimeDomainData(data); let s = 0; for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; s += v * v; } lv = Math.min(1, Math.sqrt(s / data.length) * 3.2); }
  else if (fakeTalk) lv = .35 + .35 * Math.abs(Math.sin(now / 90)) * (Math.sin(now / 370) > -.6 ? 1 : 0);
  level += (lv - level) * .35; window.__level = Math.max(window.__level||0, lv);
  const talking = level > .08;
  if (now - lastFlip > 70) { const want = level > .14 && (lv > .5 * level || Math.sin(now / 65) > -.2); if (want !== mouthOpen) { mouthOpen = want; lastFlip = now; } }
  imgClosed.style.opacity = mouthOpen ? 0 : 1;
  const sq = 1 + level * .09; bodyEl.style.transform = `scale(${2 - sq}, ${sq})`;
  bodyEl.style.filter = `drop-shadow(0 1vh 1.6vh rgba(0,0,0,.35)) drop-shadow(0 0 ${level * 3}vh rgba(255,138,30,${.3 + level * .6}))`;
  // particles
  if (Math.random() < (talking ? .5 : .06)) spawn(1);
  g.clearRect(0, 0, fx.width, fx.height);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]; p.x += p.vx; p.y += p.vy; p.life -= .012;
    if (p.life <= 0) { parts.splice(i, 1); continue; }
    g.globalAlpha = Math.min(1, p.life * 1.5); g.fillStyle = p.col;
    const X = p.x * devicePixelRatio, Y = p.y * devicePixelRatio;
    if (p.star) drawStar(X, Y, p.size * 1.3); else { g.beginPath(); g.arc(X, Y, p.size * .55, 0, Math.PI * 2); g.fill(); }
  }
  g.globalAlpha = 1;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// keep-alive: free hosts (e.g. Render) sleep after ~15 min without HTTP requests; ping while a page is open
setInterval(() => { fetch('/api/ping', { cache: 'no-store' }).catch(() => {}); }, 4 * 60 * 1000);
