// Gemini TTS -> WAV buffer (24 kHz mono 16-bit PCM). Key in header only.
import { config, apiKey } from './config.js';

function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export async function synthesize(text) {
  let lastErr;
  for (const model of config.ttsModels) {
    try { return await synthOnce(text, model); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function synthOnce(text, model) {
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
  const t = setTimeout(() => ctrl.abort(), 30000);
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
    return { wav, durationMs: Math.round((pcm.length / 2 / rate) * 1000) };
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
