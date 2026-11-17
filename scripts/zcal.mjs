// Свободные слоты из zcal: публичный профиль отдаёт рабочие окна экспертки
// и занятые события её календаря, свободное время считаем сами.
const DAYS = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

const zoneOffsetMinutes = (tz, date) => {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
  return (asUTC - date.getTime()) / 60000;
};

// локальное время в зоне tz -> момент в UTC
const zonedToUtc = (y, m, d, hh, mm, tz) => {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let off = zoneOffsetMinutes(tz, new Date(guess));
  off = zoneOffsetMinutes(tz, new Date(guess - off * 60000));
  return new Date(guess - off * 60000);
};

const ymdInZone = (date, tz) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return [Number(p.year), Number(p.month), Number(p.day)];
};

// https://zcal.co/ivanova/30min -> ivanova
export function zcalUsername(url) {
  const m = /zcal\.co\/+([^/?#\s]+)/i.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]) : '';
}

async function api(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'agilefluent-account-manager-page', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// из профиля выбираем встречу нужной длительности; у части встреч нет slug — берём по id
function pickInvite(profile, username, want) {
  let fallback = null;
  for (const inv of profile.data?.invites || []) {
    if (inv.treatAsDeleted || inv.hideFromProfilePage) continue;
    const opts = inv.durationOptions || [];
    const path = inv.slug ? `${username}/${inv.slug}` : inv.id;
    if (!path) continue;
    if (opts.includes(want)) return path;
    if (opts.length && !fallback) fallback = path;
  }
  return fallback;
}

function weeklyWindows(availability) {
  const out = [];
  for (const a of availability || []) {
    const r = a.rrule || '';
    if (!/FREQ=WEEKLY/.test(r)) continue;
    const byday = /BYDAY=([A-Z,]+)/.exec(r);
    const byhour = /BYHOUR=(\d+)/.exec(r);
    if (!byday || !byhour) continue;
    const byminute = /BYMINUTE=(\d+)/.exec(r);
    const tz = a.availabilityTimezone || 'Europe/Moscow';
    for (const d of byday[1].split(',')) {
      if (d in DAYS) out.push({ wd: DAYS[d], h: +byhour[1], m: byminute ? +byminute[1] : 0, dur: +(a.duration || 0), tz });
    }
  }
  return out;
}

export async function freeSlots(username, { days = 7, meeting = 60 } = {}) {
  const profile = await api(`https://zcal.co/api/users/${encodeURIComponent(username)}/profile`);
  const path = pickInvite(profile, username, meeting);
  if (!path) return { slots: [], horizon: 0, note: 'нет публичных встреч' };
  const data = (await api(`https://zcal.co/api/invites/${path}`)).data;
  const inv = data.invite || {};
  const dur = (inv.durationOptions || [meeting])[0];
  const step = Number(inv.slotIncrement) || 15;
  const notice = Number(inv.minNotice) || 0;
  const before = Number(inv.bufferBefore) || 0;
  const after = Number(inv.bufferAfter) || 0;
  const busy = ((data.organizerBusySlotsPeriod || {}).events || []).map((e) => [
    new Date(e.startDate).getTime() - after * 60000,
    new Date(e.endDate).getTime() + before * 60000
  ]);
  const windows = weeklyWindows(inv.availability);
  const now = Date.now();
  const earliest = now + notice * 60000;
  const horizon = Math.min(days, Number(inv.availabilityNumDays) || days);
  const slots = [];
  for (let i = 0; i <= horizon; i++) {
    const dayAnchor = new Date(now + i * 86400000);
    for (const w of windows) {
      const [y, m, d] = ymdInZone(dayAnchor, w.tz);
      const start = zonedToUtc(y, m, d, w.h, w.m, w.tz);
      const wd = (new Date(start.getTime() + zoneOffsetMinutes(w.tz, start) * 60000)).getUTCDay();
      if (((wd + 6) % 7) !== w.wd) continue;
      const ws = start.getTime();
      const we = ws + w.dur * 60000;
      for (let t = ws; t + dur * 60000 <= we; t += step * 60000) {
        if (t < earliest) continue;
        const end = t + dur * 60000;
        if (busy.some(([bs, be]) => t < be && end > bs)) continue;
        slots.push(t);
      }
    }
  }
  const uniq = [...new Set(slots)].sort((a, b) => a - b);
  // horizon — на сколько дней вперёд у человека вообще открыта запись в zcal
  return { slots: uniq.map((t) => new Date(t).toISOString()), duration: dur, horizon };
}
