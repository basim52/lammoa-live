// Loads settings. Secrets are read from env files and never logged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v;
  }
}

// 1) app/.env (on the user's PC)  2) ~/.agentring/.env (on the box) — only fills missing values
loadEnvFile(path.join(ROOT, '.env'));
loadEnvFile(path.join(os.homedir(), '.agentring', '.env'));

const env = process.env;
export const config = {
  port: Number(env.PORT || 3939),
  host: env.HOST || '127.0.0.1',
  tiktokUsername: (env.TIKTOK_USERNAME || '').replace(/^@/, '').trim(),
  characterOpen: env.CHARACTER_IMAGE || '/assets/lammoa-open.png',
  characterClosed: env.CHARACTER_IMAGE_CLOSED || '/assets/lammoa-closed.png',
  characterName: env.CHARACTER_NAME || 'لمّوعة',
  textModels: (env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',').map((x) => x.trim()).filter(Boolean),
  thinkingLevel: env.GEMINI_THINKING || 'minimal',
  hedgeMs: Number(env.GEMINI_HEDGE_MS || 1500),
  ttsModels: (env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts,gemini-3.1-flash-tts-preview').split(',').map((x) => x.trim()).filter(Boolean),
  voice: env.GEMINI_VOICE || 'Zephyr',
  sttModels: (env.GEMINI_STT_MODEL || env.GEMINI_TEXT_MODEL || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite').split(',').map((x) => x.trim()).filter(Boolean),
  hostName: (env.HOST_NAME || '').trim(),
  micMode: env.MIC_MODE || 'server',
  ttsEnabled: env.TTS_ENABLED !== '0',
  ttsEngine: (env.TTS_ENGINE || 'auto').toLowerCase(), // auto (Gemini Zephyr first, Edge fallback) | edge (Edge first) | gemini (Gemini only)
  geminiTtsTimeoutMs: Number(env.GEMINI_TTS_TIMEOUT_MS || 12000), // per Gemini TTS call before trying the next model / Edge
  geminiTtsBudgetMs: Number(env.GEMINI_TTS_BUDGET_MS || 16000),   // total time on Gemini models before falling back to Edge
  ttsSplit: env.TTS_SPLIT || 'edge', // split replies into sentence chunks: edge (only when Edge is the engine) | always | never
  geminiCooldownMs: Number(env.GEMINI_TTS_COOLDOWN_MS || 5 * 60 * 1000),
  edgeVoice: env.EDGE_VOICE || 'ar-SA-ZariyahNeural',
  edgeFormat: env.EDGE_FORMAT || 'audio-24khz-96kbitrate-mono-mp3', // best format the free Edge endpoint accepts
  edgePitch: env.EDGE_PITCH || '+2%',
  edgeRate: env.EDGE_RATE || '+4%',
  replyIntervalMs: Number(env.REPLY_INTERVAL_MS || 7000),
  welcomeIntervalMs: Number(env.WELCOME_INTERVAL_MS || 45000),
  hasKey: Boolean(env.GEMINI_API_KEY),
};
export function apiKey() { return env.GEMINI_API_KEY || ''; }
