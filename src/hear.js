// Streamer's own voice ("host" speech): noise/duplicate gate + Gemini speech-to-text fallback.
import { config, apiKey } from './config.js';
import { normalize } from './filter.js';
import { hedge } from './hedge.js';

// Fillers / noise words that are not worth a reply on their own.
const FILLER = new Set(['اه', 'ااه', 'اها', 'ام', 'امم', 'ايه', 'ها', 'هه', 'ههه', 'هم', 'همم', 'طيب', 'اوك', 'ok', 'okay', 'يب', 'لا', 'نعم', 'اي', 'يا', 'و', 'شكرا', 'uh', 'um', 'hmm', 'ah']);

export class HearGate {
  constructor({ dedupeMs = 15000, minIntervalMs = 1200, perMinute = 24 } = {}) {
    this.recent = new Map(); // normalized -> ts
    this.dedupeMs = dedupeMs; this.minIntervalMs = minIntervalMs; this.perMinute = perMinute;
    this.times = [];
  }
  /** Returns { ok:true, text } or { ok:false, reason } */
  check(raw, now = Date.now()) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    const n = normalize(text);
    if (!n) return { ok: false, reason: 'empty' };
    const letters = n.replace(/[\s\d]/g, '');
    if (letters.length < 3) return { ok: false, reason: 'too-short' };
    const ws = n.split(' ');
    if (ws.every((w) => FILLER.has(w) || /^(ه|ا|م)+$/.test(w))) return { ok: false, reason: 'filler' };
    if (/^(.)\1*$/.test(letters)) return { ok: false, reason: 'noise' };
    // speech-to-text sometimes "hears" words in beeps/music: same word over and over
    if (ws.length >= 4 && new Set(ws).size / ws.length < 0.45) return { ok: false, reason: 'repetitive' };
    const seen = this.recent.get(n);
    if (seen && now - seen < this.dedupeMs) return { ok: false, reason: 'duplicate' };
    this.times = this.times.filter((t) => now - t < 60000);
    if (this.times.length && now - this.times[this.times.length - 1] < this.minIntervalMs) return { ok: false, reason: 'too-fast' };
    if (this.times.length >= this.perMinute) return { ok: false, reason: 'rate-limit' };
    this.recent.set(n, now); this.times.push(now);
    if (this.recent.size > 200) this.recent.clear();
    return { ok: true, text };
  }
}

/** Transcribe a short WAV utterance (Arabic, Saudi dialect) with Gemini. Returns '' for no clear speech. */
export async function transcribe(wav) {
  const key = apiKey();
  if (!key) throw new Error('GEMINI_API_KEY missing');
  const body = {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: 'audio/wav', data: Buffer.from(wav).toString('base64') } },
      { text: 'اكتب الكلام المنطوق في هذا المقطع حرفياً بالحروف العربية كما قيل (غالباً لهجة سعودية/خليجية). المتكلم يكلم شخصية كرتونية اسمها «لمّوعة» في بث «فرفشة»، فإذا سمعت اسم يشبهها اكتبه «لموعة». إذا قال كلمات إنجليزية اكتبها بالحروف العربية كما تُنطق (مثل: أوكي، لايك). اكتب النص فقط بدون أي شرح أو علامات. إذا ما فيه كلام بشري واضح (صمت، ضجة، صفارة أو نغمة، موسيقى، كلام غير مفهوم) اكتب فقط: <empty>' },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 160, thinkingConfig: { thinkingLevel: 'minimal' } },
  };
  let lastErr;
  const noThink = { ...body, generationConfig: { temperature: 0, maxOutputTokens: 160 } };
  const once = async (model, b) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(b),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Gemini STT ${model} HTTP ${res.status}: ${j?.error?.status || ''}`);
      return cleanTranscript((j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('').trim());
    } catch (e) {
      throw e.name === 'AbortError' ? new Error(`Gemini STT ${model} timeout`) : e;
    } finally { clearTimeout(t); }
  };
  const tasks = config.sttModels.map((model) => async () => {
    try { return await once(model, body); }
    catch (e) { if (/HTTP 400/.test(e.message)) return once(model, noThink); throw e; }
  });
  return hedge(tasks, config.hedgeMs + 500);
}

export function cleanTranscript(t) {
  const s = String(t || '').trim().replace(/<\/?empty>?/gi, '').replace(/^["«“]+|["»”]+$/g, '').replace(/\s+/g, ' ').trim();
  if (/^(empty|\[.*\]|\(.*\))$/i.test(s)) return '';
  return s;
}
