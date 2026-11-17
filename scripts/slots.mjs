// Свободные часовые окна экспертов: считаем по zcal, кладём в кэш и
// подмешиваем в данные страницы. Если zcal недоступен — сборка не падает,
// на карточке просто будет «слоты не проверились».
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeSlots, zcalUsername } from './zcal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache', 'slots.json');

const TTL_MIN = Number(process.env.ZCAL_TTL_MIN || 120);
const DAYS = Number(process.env.ZCAL_DAYS || 7);
const MEETING = Number(process.env.ZCAL_MEETING || 60);
// насколько далеко заглядываем в поисках ближайшего окна; реальный горизонт
// обрезает сам zcal (сколько дней вперёд у человека открыта запись)
const HORIZON = Number(process.env.ZCAL_HORIZON || 60);
const PARALLEL = 4;

// zcal нарезает старты каждые 15 минут, поэтому «102 слота» — это одно и то же
// время внахлёст. Считаем, сколько встреч реально влезает подряд.
const meetings = (iso, minutes) => {
  const out = [];
  let busyUntil = 0;
  for (const s of iso) {
    const t = new Date(s).getTime();
    if (t < busyUntil) continue;
    out.push(s);
    busyUntil = t + minutes * 60000;
  }
  return out;
};

const msk = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
});
const fmt = (iso) => msk.format(new Date(iso)).replace(',', '');

const mskDay = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit' });
const fmtDay = (iso) => mskDay.format(new Date(iso));

// при смене формата кэш не переиспользуем, иначе на карточках будут старые подписи
const CACHE_V = 2;
const readCache = () => {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    return c && c.v === CACHE_V ? c : { v: CACHE_V, people: {} };
  } catch { return { v: CACHE_V, people: {} }; }
};
const writeCache = (cache) => {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(cache));
  } catch (e) { console.log('слоты: кэш не записался —', e.message); }
};

const fresh = (entry) =>
  entry && entry.checkedAt && Date.now() - new Date(entry.checkedAt).getTime() < TTL_MIN * 60000;

// people — массив из payload.EXPERTS (мутируем, добавляя поле slots)
export async function attachSlots(people) {
  const cache = readCache();
  cache.people = cache.people || {};

  const targets = people.filter((p) => !p.onStop && zcalUsername(p.zcal));
  const todo = targets.filter((p) => !fresh(cache.people[p.name]));
  let ok = 0;
  let failed = 0;

  const queue = [...todo];
  const worker = async () => {
    for (;;) {
      const p = queue.shift();
      if (!p) return;
      const user = zcalUsername(p.zcal);
      try {
        const res = await freeSlots(user, { days: HORIZON, meeting: MEETING });
        const list = meetings(res.slots || [], res.duration || MEETING);
        // индикатор — про ближайшую неделю, ближайшие окна показываем любые
        const weekEnd = Date.now() + DAYS * 86400000;
        const week = list.filter((s) => new Date(s).getTime() <= weekEnd);
        cache.people[p.name] = {
          count: week.length,
          next: list.slice(0, 3).map(fmt).join(' · '),
          soonest: list.length ? fmtDay(list[0]) : '',
          // докуда вообще открыта запись — чтобы честно сказать «окон нет до ...»
          until: res.horizon ? fmtDay(new Date(Date.now() + res.horizon * 86400000)) : '',
          checkedAt: new Date().toISOString()
        };
        ok++;
      } catch (e) {
        cache.people[p.name] = { count: null, next: '', soonest: '', until: '', checkedAt: new Date().toISOString(), error: e.message };
        failed++;
      }
    }
  };
  if (todo.length) await Promise.all(Array.from({ length: PARALLEL }, worker));

  for (const p of targets) {
    const e = cache.people[p.name];
    if (e) p.slots = { count: e.count, next: e.next, soonest: e.soonest || '', until: e.until || '', checkedAt: e.checkedAt };
  }
  if (todo.length) writeCache(cache);

  const green = targets.filter((p) => p.slots && p.slots.count >= 5).length;
  const red = targets.filter((p) => p.slots && p.slots.count === 0).length;
  console.log(
    `zcal: экспертов с календарём ${targets.length}, обновлено ${ok}, ошибок ${failed}, ` +
      `из кэша ${targets.length - todo.length}; свободных 5+ — ${green}, занято полностью — ${red}`
  );
  return people;
}
