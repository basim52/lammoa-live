// لمّوعة تسمع صاحب البث: listens on the tablet mic and sends what he says to the server.
// Modes: 'server' (default: voice detection here + Gemini speech-to-text on the server, no beeps),
//        'web' (Chrome Web Speech API, ar-SA), 'off'. URL ?mic=off|web|server overrides; the server can switch it live.
(() => {
  const urlMode = (qs.get('mic') || '').toLowerCase();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let serverMode = 'server', stageKey = null, started = false, mode = null, speaking = false, quietUntil = 0;
  const pending = []; // texts waiting for the stage key

  // ---- small indicator ----
  const el = document.createElement('div'); el.id = 'mic'; el.innerHTML = '<span></span>'; document.body.appendChild(el);
  const label = el.querySelector('span');
  const LABELS = { listen: '🎤 أسمعك…', paused: 'لمّوعة تتكلم…', thinking: 'أفكر…', wait: 'اسمح للمايك…', denied: 'المايك مقفل، اسمح للمتصفح' };
  let heardTimer;
  function ui(state, text = '') {
    el.dataset.state = state;
    if (state !== 'heard') clearTimeout(heardTimer);
    label.textContent = text || LABELS[state] || '';
    window.__micState = state;
  }
  function showHeard(t) {
    ui('heard', 'سمعتك: ' + (t.length > 46 ? t.slice(0, 46) + '…' : t));
    heardTimer = setTimeout(() => ui(speaking ? 'paused' : 'listen'), 3500);
  }

  async function send(path, body, headers) {
    if (!stageKey) { pending.push([path, body, headers]); return null; }
    const r = await fetch(path, { method: 'POST', headers: { 'x-stage-key': stageKey, ...headers }, body });
    return r.json().catch(() => ({}));
  }
  async function sendText(text, via) {
    const j = await send('/api/hear', JSON.stringify({ text, via }), { 'content-type': 'application/json' });
    if (j && j.ok) { showHeard(j.text); dispatchEvent(new CustomEvent('lammoa:heard', { detail: j.text })); }
    window.__lastHeard = j;
  }

  // ---- speaking state from lammoa.js: don't listen to herself ----
  addEventListener('lammoa:speaking', (e) => {
    speaking = e.detail;
    if (speaking) { if (mode && mode !== 'off') ui('paused'); webPause(); }
    else { quietUntil = Date.now() + 600; if (mode && mode !== 'off') ui('listen'); setTimeout(webResume, 600); }
  });
  addEventListener('lammoa:hello', (e) => {
    stageKey = e.detail.stageKey || stageKey; serverMode = e.detail.micMode || serverMode;
    while (stageKey && pending.length) { const [p, b, h] = pending.shift(); send(p, b, h); }
    apply();
  });
  addEventListener('lammoa:mic', (e) => { serverMode = e.detail || serverMode; apply(); });

  function desired() {
    let m = ['off', 'web', 'server'].includes(urlMode) ? urlMode : serverMode;
    if (m === 'web' && !SR) m = 'server';
    return m;
  }
  function apply() {
    if (!started) return;
    const want = desired();
    if (want === mode) return;
    stopAll(); mode = want;
    if (mode === 'off') { el.style.display = 'none'; return; }
    el.style.display = '';
    if (mode === 'web') startWeb(); else startServer();
  }
  function stopAll() { stopWeb(); stopServer(); }
  window.startMic = () => { started = true; apply(); };
  window.micMode = () => mode;

  // ================= server mode: voice activity detection + WAV upload =================
  let stream = null, srcNode = null, proc = null, sink = null;
  let sttErrors = 0, inUtt = false, buf = [], pre = [], loud = 0, voicedMs = 0, silentMs = 0, noise = 0.004, uploading = 0;
  async function startServer() {
    ui('wait');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      console.warn('mic', e);
      ui('denied');
      setTimeout(() => { if (mode === 'server' && !stream) { mode = null; apply(); } }, 8000);
      return;
    }
    if (mode !== 'server') { stream.getTracks().forEach((t) => t.stop()); stream = null; return; }
    ensureCtx();
    srcNode = ctx.createMediaStreamSource(stream);
    proc = ctx.createScriptProcessor(2048, 1, 1);
    sink = ctx.createGain(); sink.gain.value = 0; // never to the speakers
    srcNode.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    proc.onaudioprocess = (e) => onFrame(e.inputBuffer.getChannelData(0));
    stream.getTracks()[0].addEventListener('ended', () => { if (mode === 'server') { stopServer(); mode = null; setTimeout(apply, 1500); } });
    ui(speaking ? 'paused' : 'listen');
  }
  function stopServer() {
    try { proc && (proc.onaudioprocess = null, proc.disconnect()); srcNode && srcNode.disconnect(); sink && sink.disconnect(); } catch {}
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = srcNode = proc = sink = null; resetUtt();
  }
  function resetUtt() { window.__micBusy = false; inUtt = false; buf = []; loud = 0; voicedMs = 0; silentMs = 0; }
  function onFrame(x) {
    const frame = new Float32Array(x);
    let s = 0; for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
    const rms = Math.sqrt(s / frame.length), fms = frame.length / ctx.sampleRate * 1000;
    window.__micLevel = rms;
    if (speaking || Date.now() < quietUntil) { resetUtt(); pre = []; return; }
    const thr = Math.max(0.012, noise * 3.5);
    if (!inUtt) {
      pre.push(frame); if (pre.length > 8) pre.shift();
      if (rms > thr) { if (++loud >= 3) { inUtt = true; window.__micBusy = true; dispatchEvent(new CustomEvent('lammoa:heard-start')); buf = pre.slice(); pre = []; voicedMs = loud * fms; silentMs = 0; } }
      else { loud = 0; noise = noise * 0.97 + rms * 0.03; }
      return;
    }
    buf.push(frame);
    if (rms > thr * 0.6) { voicedMs += fms; silentMs = 0; } else silentMs += fms;
    if (silentMs >= 650 || buf.length * fms >= 12000) {
      const take = buf, v = voicedMs; resetUtt();
      if (v >= 400) upload(take, ctx.sampleRate);
    }
  }
  function toWav(frames, rate, out = 16000) {
    let n = 0; for (const f of frames) n += f.length;
    const all = new Float32Array(n); let o = 0; for (const f of frames) { all.set(f, o); o += f.length; }
    const ratio = rate / out, m = Math.floor(n / ratio), pcm = new Int16Array(m);
    for (let i = 0; i < m; i++) {
      const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio)); let s = 0;
      for (let k = a; k < b; k++) s += all[k];
      const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a))); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const h = new DataView(new ArrayBuffer(44)), w = (p, t) => { for (let i = 0; i < t.length; i++) h.setUint8(p + i, t.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, 36 + pcm.byteLength, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, out, true); h.setUint32(28, out * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, pcm.byteLength, true);
    return new Blob([h.buffer, pcm.buffer], { type: 'audio/wav' });
  }
  async function upload(frames, rate) {
    if (uploading >= 2) return;
    uploading++; ui('thinking');
    try {
      const j = await send('/api/hear-audio', toWav(frames, rate), { 'content-type': 'audio/wav' });
      window.__lastHeard = j;
      if (j && j.ok) { sttErrors = 0; showHeard(j.text); dispatchEvent(new CustomEvent('lammoa:heard', { detail: j.text })); }
      else {
        ui(speaking ? 'paused' : 'listen');
        // server speech-to-text down (e.g. key quota): switch to Chrome's own recognition if available
        if (j && j.reason === 'stt-error' && ++sttErrors >= 2 && SR && !urlMode) { console.warn('server STT failing, switching to Web Speech'); serverMode = 'web'; apply(); }
      }
    } catch (e) { console.warn('hear upload', e); ui('listen'); }
    finally { uploading--; }
  }

  // ================= web mode: Chrome Web Speech API =================
  let rec = null, webOn = false, webErrors = 0, finalText = '', flushTimer;
  function startWeb() {
    rec = new SR(); rec.lang = 'ar-SA'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      if (speaking) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += ' ' + r[0].transcript; else interim += r[0].transcript;
      }
      webErrors = 0;
      if (interim) ui('heard', '…' + interim.slice(-46));
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, interim ? 1800 : 1000);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.warn('speech', e.error); webErrors++;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'language-not-supported' || webErrors >= 4) {
        // Web Speech isn't usable here: fall back to server transcription
        serverMode = 'server'; mode = null; stopWeb(); apply();
      }
    };
    rec.onend = () => { if (mode === 'web' && webOn && !speaking) setTimeout(() => { try { webOn && rec && rec.start(); } catch {} }, 250); };
    webOn = true; try { rec.start(); } catch {}
    ui(speaking ? 'paused' : 'listen');
  }
  function flush() { const t = finalText.trim(); finalText = ''; if (t) sendText(t, 'web'); else if (!speaking) ui('listen'); }
  function stopWeb() { webOn = false; clearTimeout(flushTimer); finalText = ''; try { rec && rec.abort(); } catch {} rec = null; }
  function webPause() { if (mode === 'web' && rec) { clearTimeout(flushTimer); flush(); try { rec.abort(); } catch {} } }
  function webResume() { if (mode === 'web' && rec && webOn && !speaking) { try { rec.start(); } catch {} } }
})();
