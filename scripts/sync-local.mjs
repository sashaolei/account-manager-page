// Только для локальной проверки: собирает data.enc из статичного снапшота в src/,
// без обращения к Grist. В проде данные готовит scripts/sync-grist.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encrypt } from './crypto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) =>
  JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')
      .replace(/^export const \w+ = /, '')
      .replace(/;\s*$/, '')
  );

const payload = {
  updatedAt: new Date().toISOString(),
  EXPERTS: read('experts-data.js'),
  RESEARCHERS: read('researchers-data.js'),
  SALARY_PROGRESS: read('salary-progress.js'),
  ZITE_LINKS: read('zite-fillout-links.js'),
  ACTIVE_CLIENTS: read('active-clients.js')
};

fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'public/data.enc'),
  await encrypt(Buffer.from(JSON.stringify(payload), 'utf8'), process.env.PAGE_PASSPHRASE)
);
console.log('локальный data.enc собран из снапшота');
