// Прогоняет scripts/sync-grist.mjs против фейкового Grist: проверяем, что
// выгрузка, преобразование и шифрование работают, не трогая боевой API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { decrypt } from '../scripts/crypto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASS = 'mock-pass';

const FIXTURES = {
  Team: [
    { id: 1, fields: { Name: 'Recruiter One', Name_Rus: 'Рекрутер', Role: 'Recruiter', Retired: false,
      Telegram: 'rec_one', Zcal: 'https://zcal.co/one', Notion: 'https://notion.so/one',
      On_Stop: false, Products_Work: ['L', 10], Specifics_of_the_work: 'спец',
      Temporary_Conditions: '', Country: ['L', 'Россия'], City: ['L', 'Москва'], Time_Zone: ['L', 'Europe/Moscow'],
      Time_In_Team: '2 лет', Now_Vacation: false, Vacations: '14.09.26 — 21.09.26',
      Roles: ['L', 'Back-end', 'QA'], Industries: ['L', 'FinTech'], Countries: ['L', 'Германия'],
      Vip_Active: 3, Actual_Earnings_excl_VIP_Fix_Only_Recruiters_: 10000,
      VIP_Fixed_Fee_Forecast_Only_Recruiters_: 7500, Expected_Salary: 100000, Active: 5, Pause: 1 } },
    { id: 2, fields: { Name: 'Searcher One', Name_Rus: 'Серчер', Role: 'Searcher', Retired: false,
      Telegram: '@srch', Products_Work: ['L', 10], Country: ['L', 'Казахстан'], City: ['L', 'Алматы'],
      Time_Zone: ['L', 'Asia/Almaty'], Time_In_Team: '1 лет 2 мес.',
      Capacity_Only_Searchers_: null, Free_Only_Searchers_: null, Active: 5, Pause: 2 } },
    { id: 3, fields: { Name: 'Retired Guy', Role: 'Recruiter', Retired: true } },
    { id: 4, fields: { Name: 'Sales Guy', Role: 'Sales', Retired: false } }
  ],
  Products: [{ id: 10, fields: { Tag: 'VIP' } }, { id: 11, fields: { Tag: 'Job Pack' } }],
  Commitments: [
    { id: 100, fields: { Status: 'Execution', Client_Name: 'Клиент А', Product_Tag: 'VIP',
      Notion_Space: 'https://notion.so/a', Tg_Chat2: 'https://t.me/+a', Client_Telegram: '@klienta',
      Team_Active: ['L', 1], Team: ['L', 1, 2] } },
    { id: 101, fields: { Status: 'On Pause', Client_Name: 'Клиент Б', Product: 11,
      Notion_Space: '', Clients_Tg_Chats: 'https://t.me/+b', Client_Telegram: 'klientb',
      Team_Active: null, Team: ['L', 2] } },
    { id: 102, fields: { Status: 'Completed', Client_Name: 'Клиент В', Team_Active: ['L', 1] } }
  ],
  Capacity: [
    { id: 1, fields: { Team_Active: 2, Capacity: 3 } },
    { id: 2, fields: { Team_Active: 2, Capacity: 7, Flexibility: 'yes', Note: 'можно обсуждать' } }
  ],
  Zite_Fillout_Links: [
    { id: 200, fields: { Searcher: 2, Expert: 1, Link: 'https://schedule.fillout.com/t/x' } },
    { id: 201, fields: { Searcher: 999, Expert: 1, Link: 'https://schedule.fillout.com/t/y' } }
  ]
};

const server = http.createServer((req, res) => {
  const table = decodeURIComponent(req.url).match(/\/tables\/([^/?]+)\/records/)?.[1];
  if (!FIXTURES[table] || req.headers.authorization !== 'Bearer mock-key') {
    res.writeHead(404).end('нет такой таблицы');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ records: FIXTURES[table] }));
});
await new Promise((r) => server.listen(8123, r));

const run = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/sync-grist.mjs')], {
    env: { ...process.env, GRIST_BASE_URL: 'http://localhost:8123', GRIST_API_KEY: 'mock-key', PAGE_PASSPHRASE: PASS }
  });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  child.on('close', (code) => resolve({ code, out, err }));
});
server.closeAllConnections?.();
server.close();
if (run.code !== 0) {
  console.error(run.out, run.err);
  process.exit(1);
}
console.log(run.out.trim());

const data = JSON.parse(
  await decrypt(fs.readFileSync(path.join(ROOT, 'public/data.enc')), PASS)
);

assert.equal(data.EXPERTS.length, 1, 'один рекрутер (уволенные и продажники отсеяны)');
assert.equal(data.RESEARCHERS.length, 1, 'один серчер');
const e = data.EXPERTS[0];
assert.equal(e.telegram, '@rec_one', 'телеграм с собакой');
assert.equal(e.country, 'Россия, Москва', 'страна и город из ChoiceList');
assert.deepEqual(e.residenceCountries, ['Россия']);
assert.equal(e.timeZoneLabel, 'МСК', 'таймзона как смещение от МСК');
assert.deepEqual(e.products, ['VIP'], 'продукты развёрнуты из ссылок');
assert.deepEqual(e.roles, ['Back-end', 'QA'], 'роли берутся из Grist, а не из CSV-матрицы');
assert.deepEqual(e.industries, ['FinTech'], 'индустрии из Grist');
assert.deepEqual(e.countries, ['Германия'], 'страны экспертизы из Grist');
assert.deepEqual(e.vacations, [{ start: '2026-09-14', finish: '2026-09-21' }]);
const r = data.RESEARCHERS[0];
// формула в Grist приехала пустой — capacity берём из таблицы Capacity (последняя запись)
assert.equal(r.capacity, 7, 'capacity из таблицы Capacity, а не из пустой формулы');
assert.equal(r.free, 2, 'free = capacity - active');
assert.equal(r.capacityComment, 'Готов брать замены сверхкапасити\nможно обсуждать',
  'комментарий к капасити собран из таблицы Capacity');
assert.match(r.joinDate, /^\d{4}-\d{2}-01$/, 'дата входа в команду выведена из Time In Team');
assert.equal(r.country, 'Казахстан, Алматы', 'у серчера тоже страна + город');
assert.equal(r.timeZoneLabel, 'МСК+2', 'смещение Алматы от Москвы');
assert.equal(data.SALARY_PROGRESS.length, 0, 'зарплаты не выгружаются вовсе');
assert.ok(!('expectedSalary' in e), 'у эксперта нет поля с зарплатой');
assert.ok(!JSON.stringify(data).includes('100000'), 'ни одна сумма зарплаты не попала в выгрузку');
assert.equal(data.ZITE_LINKS.length, 1, 'связка с несуществующим серчером отброшена');
assert.deepEqual(data.ZITE_LINKS[0], {
  searcher: 'Searcher One', expert: 'Recruiter One', link: 'https://schedule.fillout.com/t/x'
});
assert.deepEqual(Object.keys(data.ACTIVE_CLIENTS).sort(), ['Recruiter One', 'Searcher One']);
assert.equal(data.ACTIVE_CLIENTS['Recruiter One'].length, 1, 'Completed не попал');
assert.equal(data.ACTIVE_CLIENTS['Searcher One'][0].client, 'Клиент Б', 'на паузе — по Team');
assert.equal(data.ACTIVE_CLIENTS['Searcher One'][0].tgChat, 'https://t.me/+b');

console.log('sync-grist: ок');
