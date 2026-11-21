// TikTok LIVE comments via the unofficial open-source tiktok-live-connector (read-only).
import { TikTokLiveConnection, WebcastEvent, ControlEvent, WebcastHttpClient } from 'tiktok-live-connector';

// Workaround for tiktok-live-connector 2.5.0: getBaseUrl() builds http:// URLs for www.tiktok.com,
// which some networks/proxies reject (HTTP 500). Force https for remote hosts.
if (WebcastHttpClient?.prototype?.getBaseUrl) {
  WebcastHttpClient.prototype.getBaseUrl = function (host) {
    if (host.includes('://')) return host;
    return /^(localhost|127\.|\[?::1)/.test(host) ? `http://${host}` : `https://${host}`;
  };
}

const nameOf = (u) => (u?.nickname || u?.uniqueId || '').trim();

export function connectTikTok(username, onEvent, log = console.log, onStatus = () => {}) {
  let conn = null;
  let stopped = false;
  let retry = 0;
  let retryPending = false;

  async function start() {
    conn = new TikTokLiveConnection(username, {});
    conn.on(WebcastEvent.CHAT, (d) => onEvent({ type: 'chat', user: nameOf(d.user), text: d.content || d.comment || '' }));
    conn.on(WebcastEvent.GIFT, (d) => {
      const g = d.giftDetails || d.gift || {};
      const giftType = g.giftType ?? g.type ?? d.extendedGiftInfo?.type;
      if (giftType === 1 && !d.repeatEnd) return; // streak still running; wait for the end
      onEvent({ type: 'gift', user: nameOf(d.user), gift: g.giftName || g.name || d.extendedGiftInfo?.name || 'هدية', count: d.repeatCount || 1 });
    });
    conn.on(WebcastEvent.MEMBER, (d) => onEvent({ type: 'join', user: nameOf(d.user) }));
    conn.on(WebcastEvent.FOLLOW, (d) => onEvent({ type: 'follow', user: nameOf(d.user) }));
    conn.on(WebcastEvent.LIKE, (d) => onEvent({ type: 'like', user: nameOf(d.user), count: d.likeCount || 0 }));
    conn.on(WebcastEvent.STREAM_END, () => { log('[tiktok] stream ended'); });
    conn.on(ControlEvent.DISCONNECTED, () => { log('[tiktok] disconnected'); onStatus('reconnecting'); if (!stopped) scheduleRetry(); });
    conn.on(ControlEvent.ERROR, (e) => log('[tiktok] error:', e?.message || e?.info || String(e)));
    try {
      const state = await conn.connect();
      retry = 0;
      onStatus('connected');
      log(`[tiktok] connected to @${username} roomId=${state?.roomId ?? '?'}`);
      return { ok: true };
    } catch (e) {
      log('[tiktok] connect failed:', e?.message || String(e));
      onStatus(/offline|isn't online/i.test(e?.message || '') ? 'offline (البث مو شغال)' : 'error: ' + (e?.message || String(e)).slice(0, 80));
      if (!stopped) scheduleRetry();
      return { ok: false, error: e?.message || String(e) };
    }
  }
  function scheduleRetry() {
    if (retryPending) return;
    retryPending = true;
    retry++;
    const ms = Math.min(60000, 5000 * retry);
    log(`[tiktok] retry in ${ms / 1000}s`);
    setTimeout(() => { retryPending = false; if (!stopped) start(); }, ms);
  }
  const first = start();
  return { first, stop() { stopped = true; try { conn?.disconnect(); } catch {} } };
}
