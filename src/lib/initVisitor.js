// src/lib/initVisitor.js
import api from './api';

export async function initVisitor() {
  try {
    // read cookie
    const COOKIE_NAME = 'exotech_sid';
    const existing = (document.cookie || '').split('; ').find(c => c.startsWith(COOKIE_NAME + '='));
    let sid = existing ? existing.split('=')[1] : null;
    if (!sid) {
      sid = cryptoRandomUUID();
      // set cookie: 1 year expiry, sameSite lax
      document.cookie = `${COOKIE_NAME}=${sid}; path=/; max-age=${60*60*24*365}; samesite=lax`;
    }

    const ua = navigator.userAgent || null;
    const meta = { ref: document.referrer || null };
    const ip = null;
    await api.postVisitorIdentify(sid, ip, ua, meta);
    return sid;
  } catch (err) {
    console.warn('initVisitor failed', err);
    return null;
  }
}

function cryptoRandomUUID() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // fallback
  return 'xxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
