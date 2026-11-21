// Pre-recorded filler talk: plays when nothing live is happening, stops instantly for live replies, resumes after.
// ?filler=off disables; ?fillerwait=12 = seconds of quiet before filler starts; the server can switch it on/off live.
(() => {
  const urlOff = (qs.get('filler') || '').toLowerCase() === 'off';
  const WAIT = Math.max(3, Number(qs.get('fillerwait')) || 12) * 1000;
  const GAP = 2500; // pause between clips: Lammoa listens to the streamer here
  let audience = true; let all = [], clips = [], order = [], pos = 0, enabled = !urlOff, started = false, playing = false, lastLive = Date.now(), lastEnd = 0;
  const KEY = 'lammoa-filler-v2';
  const CHOICE = 'lammoa-filler-choice'; // 'all' or a list of keys: 'a' (the mixed 30 min) and/or set-B topic ids
  // ?set=a | ?set=b | ?set=football,pets overrides the saved choice (handy for testing)
  function loadChoice() {
    const q = (qs.get('set') || '').trim();
    if (q) return q === 'all' ? 'all' : q === 'b' ? topicIds() : q.split(',');
    try { const v = JSON.parse(localStorage.getItem(CHOICE) || '"all"'); return Array.isArray(v) && v.length ? v : 'all'; } catch { return 'all'; }
  }
  function topicIds() { return [...new Set(all.filter((c) => c.set === 'b').map((c) => c.cat))]; }
  const keyOf = (c) => (c.set === 'b' ? c.cat : 'a');

  fetch('/filler/manifest.json').then((r) => r.json()).then((m) => {
    all = (m.clips || []).map((c) => ({ set: 'a', ...c }));
    const topics = []; const seen = new Set();
    for (const c of all) if (c.set === 'b' && !seen.has(c.cat)) { seen.add(c.cat); topics.push({ id: c.cat, title: c.title, ms: 0 }); }
    for (const c of all) if (c.set === 'b') topics.find((t) => t.id === c.cat).ms += c.d;
    window.__fillerInfo = { aMs: all.filter((c) => c.set === 'a').reduce((x, c) => x + c.d, 0), topics };
    applyChoice(loadChoice(), false);
    dispatchEvent(new CustomEvent('lammoa:filler-ready', { detail: window.__fillerInfo }));
  }).catch((e) => console.warn('filler manifest', e));

  function applyChoice(choice, persist = true) {
    if (persist) try { localStorage.setItem(CHOICE, JSON.stringify(choice)); } catch {}
    const keys = choice === 'all' ? null : new Set(choice);
    clips = all.filter((c) => !keys || keys.has(keyOf(c)));
    if (!clips.length) clips = all;
    const sig = choice === 'all' ? 'all' : [...keys].sort().join(',');
    const segs = [...new Set(clips.map((c) => c.s))];
    let saved = null; try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    if (saved && saved.sig === sig && saved.n === clips.length && Array.isArray(saved.segs)) { order = buildOrder(saved.segs); pos = saved.pos % Math.max(1, order.length); }
    else { const shuffled = segs.sort(() => Math.random() - 0.5); order = buildOrder(shuffled); pos = 0; curSig = sig; save(shuffled); }
    curSig = sig;
    window.__filler = { clips: clips.length, totalMs: clips.reduce((a, c) => a + c.d, 0), choice };
  }
  window.getFillerChoice = loadChoice;
  window.setFillerChoice = (choice) => { gen++; if (playing) stopAudio(); applyChoice(choice); };
  let segOrder = [], curSig = 'all', gen = 0;
  function buildOrder(segs) { segOrder = segs; const o = []; for (const s of segs) clips.forEach((c, i) => { if (c.s === s) o.push(i); }); return o; }
  function save(segs = segOrder) { try { localStorage.setItem(KEY, JSON.stringify({ sig: curSig, n: clips.length, segs, pos })); } catch {} }

  const markLive = () => { lastLive = Date.now(); };
  addEventListener('lammoa:live', markLive);          // a live reply (comment, gift, his speech) arrived
  addEventListener('lammoa:heard-start', markLive);   // he started talking
  addEventListener('lammoa:heard', markLive);
  addEventListener('lammoa:hello', (e) => { if (typeof e.detail.filler === 'boolean') enabled = e.detail.filler && !urlOff; if (typeof e.detail.audience === 'boolean') audience = e.detail.audience; });
  // during a TikTok live with nobody watching she stays quiet (server decides; offline = always on)
  addEventListener('lammoa:audience', (e) => { audience = !!e.detail; window.__audience = audience; if (!audience && playing) stopAudio(); });
  addEventListener('lammoa:filler', (e) => { enabled = !!e.detail && !urlOff; if (!enabled && playing) stopAudio(); });
  // tap the screen while she's doing filler: she stops and listens for a while
  addEventListener('pointerdown', (e) => { if (e.target.closest && e.target.closest('#start')) return; if (playing) { stopAudio(); lastLive = Date.now() + 20000; } });

  window.startFiller = () => { started = true; };
  setInterval(() => { if (started && enabled && window.__ws && window.__ws.readyState === 1) window.__ws.send(JSON.stringify({ type: 'filler-on' })); }, 20000);

  const ready = () => started && enabled && audience && order.length && !playing && !window.__speaking && !window.__micBusy &&
    Date.now() - lastLive > WAIT && Date.now() - lastEnd > GAP && document.visibilityState === 'visible';
  async function tick() {
    if (ready()) {
      const c = clips[order[pos]];
      playing = true; window.__fillerPlaying = c.f;
      let done = false; const g = gen;
      try { done = await speak({ text: c.t, audioUrl: '/filler/' + c.f, durationMs: c.d, filler: true }); } catch (e) { console.warn('filler', e); done = true; }
      playing = false; window.__fillerPlaying = null; lastEnd = Date.now();
      if (done && g === gen && Date.now() - lastLive > 0) { pos = (pos + 1) % order.length; save(); } // interrupted clips replay later
      window.__fillerPos = pos;
    }
    setTimeout(tick, 400);
  }
  tick();
})();
