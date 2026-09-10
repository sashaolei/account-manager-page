// Тянет данные из Grist и складывает их в public/data.enc в том формате,
// который ожидает интерфейс (EXPERTS / RESEARCHERS / SALARY_PROGRESS /
// ZITE_LINKS / ACTIVE_CLIENTS).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { records } from './grist.mjs';
import { buildPayload } from './transform.mjs';
import { encrypt, decrypt } from './crypto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');

const passphrase = process.env.PAGE_PASSPHRASE;
if (!passphrase) throw new Error('PAGE_PASSPHRASE не задан');

// матрица экспертов лежит в репозитории зашифрованной
const matrixEnc = path.join(ROOT, 'src/matrix.enc');
const matrixJson = path.join(ROOT, 'src/matrix.json');
const readMatrix = async () => {
  if (fs.existsSync(matrixEnc)) {
    try {
      return await decrypt(fs.readFileSync(matrixEnc), passphrase);
    } catch {
      // пароль не тот (например, локальный прогон тестов) — берём открытую копию
      if (!fs.existsSync(matrixJson)) throw new Error('matrix.enc не расшифровывается этим паролем');
    }
  }
  return fs.readFileSync(matrixJson, 'utf8');
};
const matrix = JSON.parse(await readMatrix());

const [team, products, commitments, zite, capacity] = await Promise.all([
  records('Team', { limit: 2000 }),
  records('Products', { limit: 1000 }),
  records('Commitments', { limit: 20000 }),
  records('Zite_Fillout_Links', { limit: 5000 }),
  records('Capacity', { limit: 5000 })
]);

const payload = buildPayload({ team, products, commitments, zite, capacity, matrix });

if (!payload.EXPERTS.length || !payload.RESEARCHERS.length) {
  throw new Error('Grist вернул пустую команду — не перезаписываем данные');
}

fs.mkdirSync(OUT, { recursive: true });
const json = Buffer.from(JSON.stringify(payload), 'utf8');
fs.writeFileSync(path.join(OUT, 'data.enc'), await encrypt(json, passphrase));

console.log(
  `Grist -> data.enc: эксперты ${payload.EXPERTS.length}, ресерчеры ${payload.RESEARCHERS.length}, ` +
    `зарплаты ${payload.SALARY_PROGRESS.length}, fillout ${payload.ZITE_LINKS.length}, ` +
    `команда с клиентами ${Object.keys(payload.ACTIVE_CLIENTS).length}, ` +
    `связок клиент↔команда ${Object.values(payload.ACTIVE_CLIENTS).reduce((s, a) => s + a.length, 0)}, ` +
    `capacity ${payload.RESEARCHERS.reduce((s, r) => s + r.capacity, 0)} / free ` +
    `${payload.RESEARCHERS.reduce((s, r) => s + r.free, 0)}, ` +
    `${(json.length / 1024).toFixed(0)} КБ`
);
