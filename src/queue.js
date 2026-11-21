// Event queue: priorities, de-duplication, spam control, rate limit.
import { normalize } from './filter.js';

const PRIORITY = { host: 0, say: 0, gift: 1, follow: 2, chat: 3, like: 4, join: 5, idle: 6 };
const MAX_QUEUE = 25;

export class EventQueue {
  constructor({ welcomeIntervalMs = 45000 } = {}) {
    this.items = [];
    this.recentTexts = new Map(); // normalized text -> ts
    this.userLast = new Map();    // user -> ts of last accepted chat
    this.lastWelcome = 0;
    this.lastLikeThanks = new Map();
    this.followed = new Set();
    this.welcomeIntervalMs = welcomeIntervalMs;
    this.stats = { accepted: 0, dropped: 0 };
  }

  push(ev) {
    const now = Date.now();
    ev.ts = now;
    ev.priority = PRIORITY[ev.type] ?? 9;
    const reason = this._reject(ev, now);
    if (reason) { this.stats.dropped++; return { ok: false, reason }; }
    this.items.push(ev);
    this.items.sort((a, b) => a.priority - b.priority || a.ts - b.ts);
    // overflow: drop lowest-priority / oldest non-manual items
    while (this.items.length > MAX_QUEUE) {
      const idx = this.items.findLastIndex((x) => x.type !== 'say' && x.type !== 'host' && x.type !== 'gift');
      this.items.splice(idx >= 0 ? idx : this.items.length - 1, 1);
      this.stats.dropped++;
    }
    this.stats.accepted++;
    return { ok: true };
  }

  _reject(ev, now) {
    if (ev.type === 'host') {
      // streamer kept talking before she answered: merge into the pending turn
      const p = this.items.find((x) => x.type === 'host');
      if (p) { p.text = `${p.text} ${ev.text}`.slice(0, 500); return 'merged-host'; }
      return null;
    }
    if (ev.type === 'say' || ev.type === 'idle') return null;
    if (ev.type === 'chat') {
      const n = normalize(String(ev.text).replace(/\[[\w-]+\]/g, ' '));
      if (!n) return ev.text ? 'emote-only' : 'empty';
      if (n.length < 2) return 'too-short';
      if (/^(.)\1*$/.test(n.replace(/\s/g, ''))) return 'spam-repeat-chars';
      if ((ev.text.match(/https?:\/\/|www\./gi) || []).length) return 'link';
      const seen = this.recentTexts.get(n);
      if (seen && now - seen < 120000) return 'duplicate-text';
      const last = this.userLast.get(ev.user);
      if (last && now - last < 20000) return 'user-rate-limit';
      this.recentTexts.set(n, now); this.userLast.set(ev.user, now);
      if (this.recentTexts.size > 500) this.recentTexts.clear();
      // only keep a handful of pending chats; old chats go stale on live
      const pendingChats = this.items.filter((x) => x.type === 'chat');
      if (pendingChats.length >= 6) this.items.splice(this.items.indexOf(pendingChats[0]), 1);
    }
    if (ev.type === 'join') {
      if (now - this.lastWelcome < this.welcomeIntervalMs) return 'welcome-rate-limit';
      if (this.items.length > 2) return 'busy';
      this.lastWelcome = now;
    }
    if (ev.type === 'follow') {
      if (this.followed.has(ev.user)) return 'already-thanked';
      this.followed.add(ev.user);
    }
    if (ev.type === 'like') {
      if ((ev.count || 0) < 15) return 'few-likes';
      const l = this.lastLikeThanks.get('*');
      if (l && now - l < 90000) return 'like-rate-limit';
      this.lastLikeThanks.set('*', now);
    }
    if (ev.type === 'gift') {
      // merge with a pending gift from the same user
      const p = this.items.find((x) => x.type === 'gift' && x.user === ev.user);
      if (p) { p.count = (p.count || 1) + (ev.count || 1); p.gift = ev.gift || p.gift; return 'merged-gift'; }
    }
    return null;
  }

  next() {
    const now = Date.now();
    // stale chats (>60s) and joins (>20s) are no longer relevant
    this.items = this.items.filter((x) => !((x.type === 'chat' && now - x.ts > 60000) || (x.type === 'join' && now - x.ts > 20000)));
    return this.items.shift() || null;
  }

  get length() { return this.items.length; }
}
