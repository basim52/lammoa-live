// Pre-recorded filler talk: plays when nothing live is happening, stops instantly for live replies, resumes after.
// ?filler=off disables; ?fillerwait=12 = seconds of quiet before filler starts; the server can switch it on/off live.
(() => {
  const urlOff = (qs.get('filler') || '').toLowerCase() === 'off';
  const WAIT = Math.max(3, Number(qs.get('fillerwait')) || 12) * 1000;
  const GAP = 2500; // pause between clips: Lammoa listens to the streamer here
  let clips = [], order = [], pos = 0, enabled = !urlOff, started = false, playing = false, lastLive = Date.now(), lastEnd = 0;
  const KEY = 'lammoa-filler-v1';

  fetch('/filler/manifest.json').then((r) => r.json()).then((m) => {
    clips = m.clips || [];
    const segs = [...new Set(clips.map((c) => c.s))];
    let saved = null; try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    if (saved && saved.n === clips.length && Array.isArray(saved.segs)) { order = buildOrder(saved.segs); pos = saved.pos % order.length; }
    else { const shuffled = segs.sort(() => Math.random() - 0.5); order = buildOrder(shuffled); pos = 0; save(shuffled); }
    window.__filler = { clips: clips.length, totalMs: clips.reduce((a, c) => a + c.d, 0) };
  }).catch((e) => console.warn('filler manifest', e));
  let segOrder = [];
  function buildOrder(segs) { segOrder = segs; const o = []; for (const s of segs) clips.forEach((c, i) => { if (c.s === s) o.push(i); }); return o; }
  function save(segs = segOrder) { try { localStorage.setItem(KEY, JSON.stringify({ n: clips.length, segs, pos })); } catch {} }

  const markLive = () => { lastLive = Date.now(); };
  addEventListener('lammoa:live', markLive);          // a live reply (comment, gift, his speech) arrived
  addEventListener('lammoa:heard-start', markLive);   // he started talking
  addEventListener('lammoa:heard', markLive);
  addEventListener('lammoa:hello', (e) => { if (typeof e.detail.filler === 'boolean') enabled = e.detail.filler && !urlOff; });
  addEventListener('lammoa:filler', (e) => { enabled = !!e.detail && !urlOff; if (!enabled && playing) stopAudio(); });
  // tap the screen while she's doing filler: she stops and listens for a while
  addEventListener('pointerdown', () => { if (playing) { stopAudio(); lastLive = Date.now() + 20000; } });

  window.startFiller = () => { started = true; };
  setInterval(() => { if (started && enabled && window.__ws && window.__ws.readyState === 1) window.__ws.send(JSON.stringify({ type: 'filler-on' })); }, 20000);

  const ready = () => started && enabled && order.length && !playing && !window.__speaking && !window.__micBusy &&
    Date.now() - lastLive > WAIT && Date.now() - lastEnd > GAP && document.visibilityState === 'visible';
  async function tick() {
    if (ready()) {
      const c = clips[order[pos]];
      playing = true; window.__fillerPlaying = c.f;
      let done = false;
      try { done = await speak({ text: c.t, audioUrl: '/filler/' + c.f, durationMs: c.d, filler: true }); } catch (e) { console.warn('filler', e); done = true; }
      playing = false; window.__fillerPlaying = null; lastEnd = Date.now();
      if (done && Date.now() - lastLive > 0) { pos = (pos + 1) % order.length; save(); } // interrupted clips replay later
      window.__fillerPos = pos;
    }
    setTimeout(tick, 400);
  }
  tick();
})();
