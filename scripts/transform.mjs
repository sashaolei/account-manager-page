// Чистая функция: сырые записи Grist -> данные в формате интерфейса.
// Вынесена отдельно, чтобы её можно было прогнать и в браузере, и в Actions.

const ROLES = ['Recruiter', 'Searcher'];
const ACTIVE_STATUSES = ['Execution', 'On Pause'];

export const refs = (v) => (Array.isArray(v) ? v : v == null || v === 0 ? [] : [v]);

const str = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v));
// часть значений приезжает из Grist в кавычках: "РФ, Москва"
const unquoted = (v) => str(v).replace(/^"([\s\S]*)"$/, '$1').trim();
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const tg = (v) => {
  const s = str(v).replace(/^https?:\/\/t\.me\//i, '');
  return s ? (s.startsWith('@') ? s : '@' + s) : '';
};

// "14.09.26 — 21.09.26, 01.10.26 — 01.05.27" -> [{start, finish}] в ISO
export function parseVacations(raw) {
  const s = str(raw);
  if (!s) return [];
  const iso = (d) => {
    const m = d.match(/(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
    if (!m) return '';
    const year = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  };
  return s
    .split(/[,;\n]/)
    .map((part) => part.split(/\s[—–-]\s|—|–/).map((x) => x.trim()))
    .filter((p) => p.length >= 2)
    .map(([a, b]) => ({ start: iso(a), finish: iso(b) }))
    .filter((r) => r.start && r.finish)
    .sort((a, b) => a.start.localeCompare(b.start));
}

// Ближайший актуальный отпуск (или последний, если все в прошлом)
function currentVacation(list) {
  if (!list.length) return { start: '', end: '' };
  const today = new Date().toISOString().slice(0, 10);
  const r = list.find((x) => x.finish >= today) || list[list.length - 1];
  return { start: r.start, end: r.finish };
}

// "РФ, Москва" / "Россия, Казань" -> ["РФ"]
function residenceCountries(country) {
  const first = unquoted(country).split(',')[0].trim();
  if (!first) return [];
  return /^росси|^рф$/i.test(first) ? ['РФ'] : [first];
}

export function buildPayload({ team, products, commitments, zite, matrix = {} }) {
  const nameById = new Map(team.map((t) => [t.id, str(t.Name)]));
  const tagById = new Map(products.map((p) => [p.id, str(p.Tag)]));

  const alive = team
    .filter((t) => ROLES.includes(str(t.Role)) && !t.Retired)
    .sort((a, b) => str(a.Name).localeCompare(str(b.Name)));

  const common = (m) => {
    const vacations = parseVacations(m.Vacations);
    const cur = currentVacation(vacations);
    return {
      name: str(m.Name),
      ruName: str(m.Name_Rus),
      telegram: tg(m.Telegram),
      zcal: str(m.Zcal),
      notion: str(m.Notion),
      onStop: !!m.On_Stop,
      products: refs(m.Products_Work).map((id) => tagById.get(id)).filter(Boolean),
      specialty: str(m.Specifics_of_the_work),
      temporaryConditions: str(m.Temporary_Conditions),
      country: unquoted(m.Country),
      timeZone: str(m.Time_Zone),
      timeInTeam: str(m.Time_In_Team),
      nowVacation: !!m.Now_Vacation,
      vacations,
      vacationStart: cur.start,
      vacationEnd: cur.end,
      active: num(m.Active),
      pause: num(m.Pause),
      vipActive: num(m.Vip_Active),
      expectedSalary: num(m.Expected_Salary)
    };
  };

  const RESEARCHERS = alive
    .filter((m) => str(m.Role) === 'Searcher')
    .map((m) => ({
      ...common(m),
      capacity: num(m.Capacity_Only_Searchers_),
      free: num(m.Free_Only_Searchers_),
      joinDate: ''
    }));

  const recruiters = alive.filter((m) => str(m.Role) === 'Recruiter');

  const EXPERTS = recruiters.map((m) => {
    const base = common(m);
    const mx = matrix[base.name] || {};
    return {
      ...base,
      industries: mx.industries || [],
      roles: mx.roles || [],
      countries: mx.countries || [],
      residenceLabel: base.country,
      residenceCountries: mx.residenceCountries?.length
        ? mx.residenceCountries
        : residenceCountries(base.country),
      isNew: mx.isNew ?? !matrix[base.name]
    };
  });

  const SALARY_PROGRESS = recruiters
    .map((m) => {
      const expectedSalary = num(m.Expected_Salary);
      const rewardNoVipFix = num(m.Actual_Earnings_excl_VIP_Fix_Only_Recruiters_);
      const estimateVipFix = num(m.VIP_Fixed_Fee_Forecast_Only_Recruiters_);
      const earned = rewardNoVipFix + estimateVipFix;
      return {
        name: str(m.Name),
        expectedSalary,
        estimatedSalary: rewardNoVipFix,
        rewardNoVipFix,
        estimateVipFix,
        vipActive: num(m.Vip_Active),
        estRewardLeft: Math.max(0, expectedSalary - earned),
        progress: expectedSalary ? Math.round((earned / expectedSalary) * 100) : 0
      };
    })
    .sort((a, b) => b.expectedSalary - a.expectedSalary || a.name.localeCompare(b.name));

  const ZITE_LINKS = zite
    .map((z) => ({
      searcher: nameById.get(refs(z.Searcher)[0]) || '',
      expert: nameById.get(refs(z.Expert)[0]) || '',
      link: str(z.Link)
    }))
    .filter((z) => z.searcher && z.expert && z.link)
    .sort((a, b) => a.searcher.localeCompare(b.searcher) || a.expert.localeCompare(b.expert));

  const ACTIVE_CLIENTS = {};
  for (const c of commitments) {
    if (!ACTIVE_STATUSES.includes(str(c.Status))) continue;
    // Team_Active пустой у клиентов на паузе — тогда берём Team
    const members = refs(c.Team_Active).length ? refs(c.Team_Active) : refs(c.Team);
    const item = {
      client: str(c.Client_Name),
      product: str(c.Product_Tag) || tagById.get(refs(c.Product)[0]) || '',
      notionSpace: str(c.Notion_Space),
      tgChat: str(c.Tg_Chat2) || str(c.Clients_Tg_Chats),
      clientTelegram: str(c.Client_Telegram).replace(/^@/, ''),
      status: str(c.Status)
    };
    for (const id of members) {
      const name = nameById.get(id);
      if (!name) continue;
      (ACTIVE_CLIENTS[name] ||= []).push(item);
    }
  }
  for (const list of Object.values(ACTIVE_CLIENTS)) {
    list.sort((a, b) => a.client.localeCompare(b.client));
  }

  return {
    updatedAt: new Date().toISOString(),
    EXPERTS,
    RESEARCHERS,
    SALARY_PROGRESS,
    ZITE_LINKS,
    ACTIVE_CLIENTS
  };
}
