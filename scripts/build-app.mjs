// Собирает интерфейс из src/app-source.html в зашифрованный public/app.enc:
//  - вшивает support.js и React внутрь HTML;
//  - вшивает картинки и видео как data:-ссылки (наружу ничего не выкладывается);
//  - чинит <sc-for> в таблицах (HTML-парсер выбрасывает его из <tbody>);
//  - заменяет загрузку данных из локальных .js-модулей на window.__AM_DATA.
// Плюс шифрует src/matrix.json -> src/matrix.enc (его читает sync-grist в Actions).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encrypt } from './crypto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');
const SRC = path.join(ROOT, 'src');

const passphrase = process.env.PAGE_PASSPHRASE;
if (!passphrase) throw new Error('PAGE_PASSPHRASE не задан');

let html = fs.readFileSync(path.join(SRC, 'app-source.html'), 'utf8');

// 1. support.js и React внутрь документа
const supportTag = '<script src="./support.js"></script>';
if (!html.includes(supportTag)) throw new Error('не найден <script src="./support.js">');
// подключаем как data:-скрипты, а не текстом внутри <script>: в минифицированном
// React встречаются последовательности, которые ломают HTML-парсер
const inline = (f) =>
  `<script src="data:text/javascript;base64,${fs.readFileSync(path.join(SRC, f)).toString('base64')}"></script>`;
// React — на месте старого тега, а сам dc-runtime подключаем в самом конце body:
// он разбирает шаблон сразу, а до этого нужно починить <sc-for> в таблицах
html = html.replace(supportTag, [inline('react.js'), inline('react-dom.js')].join('\n'));

// 2. убираем объявления внешних data-ресурсов
html = html.replace(/\s*<meta name="ext-resource-dependency"[^>]*>/g, '');

// 3. картинки и видео — в data:-ссылки
// тип определяем по содержимому: часть файлов сжата в webp, но имена остались прежними
const sniff = (buf) => {
  const a = buf.subarray(0, 12).toString('latin1');
  if (a.startsWith('RIFF') && a.slice(8, 12) === 'WEBP') return 'image/webp';
  if (a.startsWith('\x89PNG')) return 'image/png';
  if (a.startsWith('\xff\xd8')) return 'image/jpeg';
  if (a.startsWith('GIF8')) return 'image/gif';
  if (a.slice(4, 8) === 'ftyp') return 'video/mp4';
  if (a.trimStart().startsWith('<')) return 'image/svg+xml';
  return null;
};
const used = new Set();
html = process.env.SKIP_ASSETS ? html : html.replace(/\.\/assets\/([A-Za-z0-9._-]+)/g, (m, file) => {
  const p = path.join(SRC, 'assets', file);
  if (!fs.existsSync(p)) throw new Error(`нет файла ${file}`);
  used.add(file);
  const buf = fs.readFileSync(p);
  const mime = sniff(buf);
  if (!mime) throw new Error(`неизвестный тип ${file}`);
  return `data:${mime};base64,${buf.toString('base64')}`;
});

// 4. HTML-парсер браузера выбрасывает <sc-for> из <tbody> (в таблицу можно
// только <tr>), поэтому переносим цикл в атрибут и восстанавливаем его через
// DOM API уже после разбора документа — до загрузки dc-runtime.
let loops = 0;
html = html.replace(
  /(<tbody[^>]*>)([\s\S]*?)<sc-for ([^>]*)>([\s\S]*?)<\/sc-for>([\s\S]*?)(<\/tbody>)/g,
  (all, open, pre, attrs, inner, post, close) => {
    const cfg = {};
    for (const m of attrs.matchAll(/([a-z-]+)="([^"]*)"/g)) cfg[m[1]] = m[2];
    loops++;
    return (
      open.replace(/>$/, ` data-sc-for="${JSON.stringify(cfg).replace(/"/g, '&quot;')}">`) +
      pre + inner + post + close
    );
  }
);
if (loops !== 4) throw new Error(`ожидали 4 таблицы с sc-for, нашли ${loops}`);

const restore = `<script>
(function(){
  var n = document.querySelectorAll('[data-sc-for]');
  console.info('[am] sc-for to restore:', n.length, 'readyState:', document.readyState);
  n.forEach(function(el){
    var cfg = JSON.parse(el.getAttribute('data-sc-for'));
    el.removeAttribute('data-sc-for');
    var f = document.createElement('sc-for');
    Object.keys(cfg).forEach(function(k){ f.setAttribute(k, cfg[k]); });
    while (el.firstChild) f.appendChild(el.firstChild);
    el.appendChild(f);
  });
})();
</script>`;
if (!html.includes('</body>')) throw new Error('не найден </body>');
html = html.replace('</body>', restore + '\n' + inline('support.js') + '\n</body>');

// 5. данные — из window.__AM_DATA, плюс хук window.__AM_APPLY для живого обновления
const loaderRe =
  /const expertsUrl = [\s\S]*?const activeClientsMod = await import\(activeClientsUrl\);/;
if (!loaderRe.test(html)) throw new Error('не найден блок загрузки данных в componentDidMount');
html = html.replace(
  loaderRe,
  `const __apply = (D) => {
      this.originalExperts = D.EXPERTS || [];
      this.originalSalary = D.SALARY_PROGRESS || [];
      this.ziteLinks = D.ZITE_LINKS || [];
      this.researchers = D.RESEARCHERS || [];
      this.activeClients = D.ACTIVE_CLIENTS || {};
      const eOv = localStorage.getItem("am_experts_override");
      const sOv = localStorage.getItem("am_salary_override");
      this.setState({
        experts: eOv ? JSON.parse(eOv) : this.originalExperts,
        salaryProgress: sOv ? JSON.parse(sOv) : this.originalSalary
      });
    };
    window.__AM_APPLY = __apply;
    window.__ROOT = this;
    const __D = window.__AM_DATA || {};
    const mod = { EXPERTS: __D.EXPERTS || [] };
    const salaryMod = { SALARY_PROGRESS: __D.SALARY_PROGRESS || [] };
    const ziteMod = { ZITE_LINKS: __D.ZITE_LINKS || [] };
    const researchersMod = { RESEARCHERS: __D.RESEARCHERS || [] };
    const activeClientsMod = { ACTIVE_CLIENTS: __D.ACTIVE_CLIENTS || {} };`
);

fs.mkdirSync(OUT, { recursive: true });
if (process.env.DUMP_HTML) fs.writeFileSync(process.env.DUMP_HTML, html);
fs.writeFileSync(path.join(OUT, 'app.enc'), await encrypt(Buffer.from(html, 'utf8'), passphrase));

// 6. матрица экспертов — тоже шифром, её читает sync-grist в GitHub Actions
const matrixPath = path.join(SRC, 'matrix.json');
if (fs.existsSync(matrixPath)) {
  fs.writeFileSync(path.join(SRC, 'matrix.enc'), await encrypt(fs.readFileSync(matrixPath), passphrase));
}

const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(
  `app.enc собран: ${used.size} медиафайлов вшито, ${mb(html.length)} МБ исходного HTML -> ` +
    `${mb(fs.statSync(path.join(OUT, 'app.enc')).size)} МБ шифра`
);
