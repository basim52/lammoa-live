// Gemini TTS -> WAV buffer (24 kHz mono 16-bit PCM). Key in header only.
import { config, apiKey } from './config.js';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Engines: Gemini TTS (voice Zephyr, the original voice) first; each model that returns 429 is cooled down
// for a while and the next Gemini model is tried; if all Gemini models fail / time out, Microsoft Edge (no key).
const cooldown = new Map(); // model -> until
export const ttsState = { lastEngine: null, lastModel: null, geminiCooldownUntil: 0, lastGeminiError: null, cooldowns: {} };
const liveModels = () => config.ttsModels.filter((m) => (cooldown.get(m) || 0) <= Date.now());
export function geminiAvailable() { return config.hasKey && config.ttsEngine !== 'edge' && liveModels().length > 0; }
async function synthGemini(text) {
  const t0 = Date.now(); let lastErr = new Error('Gemini TTS: all models cooling down');
  for (const model of liveModels()) {
    const left = config.geminiTtsBudgetMs - (Date.now() - t0);
    if (left < 1500) { lastErr = new Error('Gemini TTS budget used'); break; }
    try {
      const r = await synthOnce(text, model, Math.min(config.geminiTtsTimeoutMs, left));
      // some TTS models read the line twice; far longer than the text needs = reject and try the next engine
      const words = String(text).split(/\s+/).filter(Boolean).length;
      if (r.durationMs > 1500 + words * 800) throw new Error(`Gemini TTS ${model} too long (${Math.round(r.durationMs / 1000)}s for ${words} words)`);
      ttsState.lastModel = model; return r;
    }
    catch (e) {
      lastErr = e; ttsState.lastGeminiError = e.message;
      if (/HTTP 429/.test(e.message)) { cooldown.set(model, Date.now() + config.geminiCooldownMs); ttsState.cooldowns[model] = new Date(Date.now() + config.geminiCooldownMs).toISOString(); }
    }
  }
  ttsState.geminiCooldownUntil = Math.min(...config.ttsModels.map((m) => cooldown.get(m) || 0));
  throw lastErr;
}
export async function synthesize(text) {
  const engine = config.ttsEngine;
  let lastErr;
  if (engine !== 'edge' && config.hasKey) {
    try { const r = await synthGemini(text); ttsState.lastEngine = 'gemini'; return r; }
    catch (e) { lastErr = e; if (engine === 'gemini') throw e; }
  }
  try { const r = await synthEdge(text); ttsState.lastEngine = 'edge'; return r; }
  catch (e) {
    if (engine === 'edge' && config.hasKey) { try { const r = await synthGemini(text); ttsState.lastEngine = 'gemini'; return r; } catch {} }
    throw new Error(`${lastErr ? lastErr.message + ' | ' : ''}edge: ${e.message}`);
  }
}

// ---- Microsoft Edge neural TTS (free, no key) ----
let edge = null; let edgeUsedAt = 0;
// Keep the Edge connection warm so the first reply after a quiet spell doesn't pay the connect cost.
export async function warmEdge() { if (Date.now() - edgeUsedAt < 120000 && edge) return; try { await synthEdge('هلا'); } catch {} }
async function edgeClient() {
  if (edge) return edge;
  const c = new MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 15000 });
  await c.setMetadata(config.edgeVoice, config.edgeFormat);
  edge = c; return c;
}
export async function synthEdge(text, { attempt = 0 } = {}) {
  try {
    const c = await edgeClient();
    const { audioStream } = c.toStream(escapeXml(text), { pitch: config.edgePitch, rate: config.edgeRate });
    const parts = [];
    await Promise.race([
      (async () => { for await (const ch of audioStream) parts.push(ch); })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('edge timeout')), 15000)),
    ]);
    const audio = Buffer.concat(parts);
    edgeUsedAt = Date.now();
    if (audio.length < 500) throw new Error('edge: empty audio');
    const kbps = Number((config.edgeFormat.match(/(\d+)kbitrate/) || [])[1] || 48); // CBR mp3
    return { audio, wav: audio, mime: 'audio/mpeg', ext: 'mp3', durationMs: Math.round(audio.length * 8 / kbps), engine: 'edge' };
  } catch (e) {
    try { edge && edge.close(); } catch {}
    edge = null;
    if (attempt < 1) return synthEdge(text, { attempt: attempt + 1 });
    throw e;
  }
}
function escapeXml(t) { return String(t).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])); }

export async function synthOnce(text, model, timeoutMs = 30000) {
  const key = apiKey();
  if (!key) throw new Error('GEMINI_API_KEY missing');
  const body = {
    contents: [{ parts: [{ text: `Say in a cheerful, bubbly, friendly young Saudi female voice, fast and energetic like a fun live-stream co-host, in Saudi Gulf Arabic: ${text}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } },
    },
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini TTS ${model} HTTP ${res.status}: ${j?.error?.status || ''}`);
    const part = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData?.data);
    if (!part) throw new Error(`Gemini TTS no audio (${j.candidates?.[0]?.finishReason || 'unknown'})`);
    const mime = part.inlineData.mimeType || '';
    const rate = Number((mime.match(/rate=(\d+)/) || [])[1] || 24000);
    const pcm = trimSilence(Buffer.from(part.inlineData.data, 'base64'), rate);
    const wav = pcmToWav(pcm, rate);
    return { audio: wav, wav, mime: 'audio/wav', ext: 'wav', durationMs: Math.round((pcm.length / 2 / rate) * 1000), engine: 'gemini' };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Gemini TTS ${model} timeout`);
    throw e;
  } finally { clearTimeout(t); }
}

// Trim leading/trailing near-silence (TTS sometimes pads several seconds), keep 150 ms margins.
function trimSilence(pcm, rate) {
  const n = Math.floor(pcm.length / 2); if (!n) return pcm;
  const win = Math.floor(rate * 0.02), thr = 500;
  const loud = (i) => { let m = 0; for (let k = i; k < Math.min(n, i + win); k++) { const v = Math.abs(pcm.readInt16LE(k * 2)); if (v > m) m = v; } return m > thr; };
  let a = 0; while (a < n && !loud(a)) a += win;
  let b = n - win; while (b > a && !loud(b)) b -= win;
  if (a >= b) return pcm;
  const pad = Math.floor(rate * 0.15);
  a = Math.max(0, a - pad); b = Math.min(n, b + win + pad);
  return pcm.subarray(a * 2, b * 2);
}

// Split a reply for TTS: only at sentence ends (never mid-phrase), at most 2 chunks, so the first
// sentence can start playing while the rest is synthesized. Short replies stay in one piece.
export function splitForTts(text) {
  const t = String(text).trim();
  const wc = (x) => x.split(/\s+/).filter(Boolean).length;
  if (wc(t) <= 10) return [t];
  const parts = t.split(/(?<=[.!؟?…])\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return [t];
  let first = parts[0], i = 1;
  while (i < parts.length - 1 && wc(first) < 5) first += ' ' + parts[i++];
  const rest = parts.slice(i).join(' ');
  return rest && wc(rest) >= 2 ? [first, rest] : [t];
}
