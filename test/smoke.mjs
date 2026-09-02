// Поднимает public/ на localhost, открывает страницу в headless-браузере,
// вводит пароль и проверяет, что все четыре таблицы наполнились данными.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(ROOT, 'public');
const PASS = process.env.PAGE_PASSPHRASE || 'test123';
const CHROME = process.env.CHROME_PATH; // в CI можно не задавать — playwright найдёт сам

const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const p = path.join(root, u === '/' ? 'index.html' : u);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(404).end('');
    return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8099, r));

const browser = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto('http://localhost:8099/');
await page.fill('#pass', PASS);
await page.click('#go');
await page.waitForTimeout(9000);

const frame = page.frames()[1];
assert.ok(frame, 'интерфейс не загрузился');

const expected = { Эксперты: 1, Серчеры: 1, Fillout: 1, 'Активные клиенты': 1 };
for (const [label, min] of Object.entries(expected)) {
  await frame.getByText(label, { exact: true }).first().click();
  await page.waitForTimeout(1200);
  const rows = await frame.evaluate(() => document.querySelector('tbody')?.children.length ?? 0);
  assert.ok(rows >= min, `${label}: строк ${rows}, ожидали хотя бы ${min}`);
  console.log(`${label}: ${rows} строк`);
}

assert.deepEqual(errors, [], 'ошибки в консоли страницы');
console.log('страница: ок');

await browser.close();
server.close();
