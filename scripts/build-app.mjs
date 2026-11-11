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

// 3b. тег с таймзоной во всех карточках команды.
// Делаем это в сборке, а не в макете: при следующем экспорте из Claude тег
// добавится сам, вручную его каждый раз возвращать не придётся.
const tzChip = (v) =>
  `\n<sc-if value="{{ ${v}.hasTimeZoneTag }}" hint-placeholder-val="{{ false }}">` +
  `<div style="font-size:11.5px;font-weight:600;color:#5a6b4a;background:#5a6b4a14;border-radius:4px;padding:2px 7px">` +
  `🕐 {{ ${v}.timeZoneLabel }}</div></sc-if>`;

// сколько у человека сейчас активных VIP-клиентов (тег появляется только если есть)
const vipChip = (v) =>
  `\n<sc-if value="{{ ${v}.hasVipTag }}" hint-placeholder-val="{{ false }}">` +
  `<div style="font-size:11.5px;font-weight:600;color:#8a6b1f;background:#8a6b1f14;border-radius:4px;padding:2px 7px">` +
  `⭐ VIP: {{ ${v}.vipActiveLabel }}</div></sc-if>`;

// а) в шаблоны: сразу после тега со страной/локацией
let chips = 0;
html = html.replace(
  /<sc-if value="\{\{ (ex|rs)\.(?:hasResidenceTag|hasCountryTag|hasCountry) \}\}"[\s\S]*?<\/sc-if>/g,
  (block, v) => { chips++; return block + tzChip(v) + vipChip(v); }
);
if (chips < 3) throw new Error(`теги в карточках: ожидали минимум 3 карточки, нашли ${chips}`);

// б) в логику: поля для тега рядом с уже существующими
// подпись уже посчитана при выгрузке из Grist: «МСК+2», «МСК−1»
const tzLabel = (v) => `(${v}.timeZoneLabel || "")`;
const vipFields = (v) => `hasVipTag: !!${v}.vipActive, vipActiveLabel: (${v}.vipActive || 0),`;
const logicPatches = [
  ['hasResidenceTag: !!ex.residenceLabel,',
   'hasResidenceTag: !!ex.residenceLabel, hasTimeZoneTag: !!ex.timeZoneLabel, timeZoneLabel: ' + tzLabel('ex') + ', ' + vipFields('ex')],
  ['countryTagLabel: e.residenceLabel || (e.residenceCountries || []).join(", "),',
   'countryTagLabel: e.residenceLabel || (e.residenceCountries || []).join(", "), hasTimeZoneTag: !!e.timeZoneLabel, timeZoneLabel: ' + tzLabel('e') + ', ' + vipFields('e')],
  ['timeZone: rs.timeZone || "",',
   'timeZone: rs.timeZone || "", hasTimeZoneTag: !!rs.timeZoneLabel, timeZoneLabel: ' + tzLabel('rs') + ', ' + vipFields('rs')]
];
for (const [from, to] of logicPatches) {
  if (!html.includes(from)) throw new Error(`теги в карточках: не найден блок «${from.slice(0, 40)}…»`);
  html = html.replace(from, to);
}

// в) у серчеров таймзона дублировалась в подписи — убираем, её теперь показывает тег
html = html.replace(/ · TZ: \{\{ rs\.timeZone \}\}/g, '');

// 3c. поиск по карточкам в «Подбор экспертов» у сейлзов
const searchInput =
  '<input value="{{ salesSearchValue }}" onChange="{{ onSalesSearchChange }}" ' +
  'placeholder="Поиск по имени, роли, индустрии, стране, продукту..." ' +
  'style="width:100%;box-sizing:border-box;border:1px solid #ddd4c4;border-radius:6px;background:#fff;' +
  'padding:10px 14px;font-size:14px;font-family:inherit;margin-bottom:12px">\n';
const countLabel = '<div style="font-size:13px;color:#8a7f6e;margin-bottom:12px">{{ salesMatchCountLabel }}</div>';
if (!html.includes(countLabel)) throw new Error('поиск у сейлзов: не найдена строка со счётчиком');
html = html.replace(countLabel, searchInput + countLabel);

const salesFilterHead = 'const salesMatched = salesBaseExperts.filter(e =>\n      (salesFilters.role.length === 0';
if (!html.includes(salesFilterHead)) throw new Error('поиск у сейлзов: не найден фильтр salesMatched');
html = html.replace(
  salesFilterHead,
  'const salesQuery = (this.state.salesSearch || "").trim().toLowerCase();\n' +
  '    const salesMatched = salesBaseExperts.filter(e =>\n' +
  '      (!salesQuery || [e.ruName, e.name, e.telegram, e.specialty, e.temporaryConditions, e.residenceLabel,' +
  ' ...(e.roles || []), ...(e.industries || []), ...(e.countries || []), ...(e.products || [])]' +
  '.filter(Boolean).join(" ").toLowerCase().includes(salesQuery)) &&\n' +
  '      (salesFilters.role.length === 0'
);

const salesCount = 'salesMatchCountLabel: salesMatched.length + " из " + experts.length + " экспертов",';
if (!html.includes(salesCount)) throw new Error('поиск у сейлзов: не найден salesMatchCountLabel');
html = html.replace(
  salesCount,
  salesCount +
  '\n      salesSearchValue: this.state.salesSearch || "",' +
  '\n      onSalesSearchChange: e => this.setState({ salesSearch: e.target.value }),'
);

// 3d. убираем всё, что связано с зарплатами: цифры не должны уезжать из Grist
//     (общая ссылка — её видят и сейлзы)
const salaryDrops = [
  [/\s*<th[^>]*>Прогресс по ЗП<\/th>/, 'колонка «Прогресс по ЗП»'],
  [/\s*<th[^>]*>Факт заработано без VIP-фикса<\/th>/, 'колонка «Факт заработано»'],
  [/\s*<th[^>]*>Прогноз VIP-фикс<\/th>/, 'колонка «Прогноз VIP-фикс»'],
  [/\s*<td style="padding:10px 14px;white-space:normal;min-width:220px;vertical-align:top">[\s\S]*?\{\{ row\.estimateVipFixLabel \}\}<\/td>/, 'ячейки с зарплатой'],
  [/\s*<sc-if value="\{\{ ex\.hasSalary \}\}"[\s\S]*?<\/sc-if>/, 'полоса прогресса в карточке']
];
for (const [re_, what] of salaryDrops) {
  if (!re_.test(html)) throw new Error(`ЗП: не найдено — ${what}`);
  html = html.replace(re_, '');
}

// «Активных VIP» — это счётчик клиентов, а не деньги: оставляем, но берём из карточки эксперта
const salaryLogic = [
  ['vipActive: s ? (s.vipActive || 0) : "—",', 'vipActive: e.vipActive || 0,'],
  ['sortKey: s ? s.estRewardLeft : -Infinity', 'sortKey: 0']
];
for (const [from, to] of salaryLogic) {
  if (!html.includes(from)) throw new Error(`ЗП: не найден блок «${from.slice(0, 40)}…»`);
  html = html.replace(from, to);
}

// кнопка «Копировать сводку» больше не выгружает суммы
const summaryRe = /const expected = s \? s\.expectedSalary[\s\S]*?leftPct \+ "%\)";/;
if (!summaryRe.test(html)) throw new Error('ЗП: не найден текст сводки');
html = html.replace(
  summaryRe,
  'const text = (e.ruName ? e.ruName + " (" + e.name + ")" : e.name) +\n' +
  '              "\\nАктивных клиентов: " + activeClientsArr.length + (activeClientsLabel !== "—" ? " (" + activeClientsLabel + ")" : "") +\n' +
  '              "\\nАктивных випов: " + (e.vipActive || 0);'
);

// и загрузчики CSV с зарплатами убираем тоже
const uploadRe = /,\n\s*\{\n\s*title: "Ожидаемая ЗП",[\s\S]*?\n\s*\}\n(\s*\],)/;
if (!uploadRe.test(html)) throw new Error('ЗП: не найдены карточки загрузки CSV');
html = html.replace(uploadRe, '\n$1');

// 3e. подпись под заголовком: роли и индустрии больше не «разово загружены»
const noteOld = 'Разово загружена инфа про роли, индустрии, страны. Для её обновления пишите Саше.';
if (!html.includes(noteOld)) throw new Error('не найдена подпись про разовую загрузку');
html = html.replace(noteOld, 'Роли, индустрии и страны экспертизы — из колонок Roles, Industries и Countries в Grist.');

// 3f. комментарий к капасити у серчеров — сразу после специфики работы.
// Не через <sc-if>: добавленный руками sc-if dc-runtime не подхватывает,
// поэтому прячем пустой блок через display в style.
const commentBlock =
  '\n<div style="display:{{ rs.capacityCommentDisplay }};font-size:12.5px;color:#4a6b8a;' +
  'margin-bottom:8px;max-width:520px;white-space:pre-wrap;line-height:1.5;' +
  'border-left:2px solid #4a6b8a44;padding-left:8px">{{ rs.capacityComment }}</div>';
let comments = 0;
html = html.replace(
  /<sc-if value="\{\{ rs\.hasSpecialty \}\}"[\s\S]*?<\/sc-if>/g,
  (block) => { comments++; return block + commentBlock; }
);
if (comments !== 2) throw new Error(`комментарий к капасити: ожидали 2 карточки, нашли ${comments}`);

const commentLogic = 'hasSpecialty: !!rs.specialty,';
if (!html.includes(commentLogic)) throw new Error('комментарий к капасити: не найден блок с hasSpecialty');
html = html.replace(
  commentLogic,
  commentLogic +
    ' capacityComment: rs.capacityComment || "",' +
    ' capacityCommentDisplay: rs.capacityComment ? "block" : "none",'
);

// 3g. продукт «Applies&Outreach Addons» — добавляем в список продуктов
// (в макете его нет, поэтому вшиваем на сборке, как и остальные правки)
const addonsAnchor = '  { id: "p_mock_interview", title: "Mock interview"';
if (!html.includes(addonsAnchor)) throw new Error('Addons: не найдено место в списке продуктов');
if (html.includes('p_applies_addons')) throw new Error('Addons: продукт уже есть в макете');
const addonsProduct =
  '  { id: "p_applies_addons", title: "Applies&Outreach Addons", matrixKey: "Applies-100 and LinkedIn Outreach",\n' +
  '    infoStage: { title: "Информация", items: [\n' +
  '      { label: "Перед организацией", value: "Проверить, что с клиентом работали не более чем 6 месяцев назад.' +
  '\\n\\nЕсли аддоны купили после 6 месяцев работы и сейлз не предложил консультации по документам — это плохо: ' +
  'придёт экспертка на кейс и скажет, что нужно смотреть документы и переделывать, а клиент за документы не платил." },\n' +
  '      { label: "Чат и команда", value: "Чат уже создан — новый заводить не нужно.' +
  '\\n\\nОбычно спрашиваем предыдущего серчера, продолжит ли он работу. Если не может — подбираем нового." },\n' +
  '      { label: "Состав", value: "1. Интро с эксперткой — или сразу командная, если серчер уже есть' +
  '\\n2. Встреча с серчером — только если серчера подключаем позже' +
  '\\n3. Встреча после 50 отклика\\n4. Финальная встреча" },\n' +
  '      { label: "Дальше", value: "Остальная работа — только поддержка на кейсе." },\n' +
  '      { label: "В скрипте подключения", value: "Строку «Когда все документы будут готовы, в чат добавят серчера/ку» ' +
  'оставляем, только если клиент давно с нами работал." }\n' +
  '    ] },\n' +
  '    introTpl: "{{tagclient}}, привет! Организую работу по аддонам — в течение суток добавлю в чат экспертку. ' +
  'Здесь будет вся дальнейшая коммуникация.",\n' +
  '    connectTpl: "{{tagclient}}, привет! С тобой будет работать {{expert_name}} {{tagexpert}}, профайл — {{profile_link}}' +
  '\\n\\n▶ Интро-встреча — 60 минут' +
  '\\n\\nКогда все документы будут готовы, в чат добавят серчера/ку.' +
  '\\n\\nБронируй встречу по ссылке: {{calendar_link}}.\\nZoom {{expert_name}} пришлет перед встречей.' +
  '\\n\\nВажно: отменить или перенести сессию можно не позже чем за 24 часа до начала. ' +
  'Если перенос/отмена происходит позже — сессия считается проведённой.' +
  '\\n\\n📂 Рабочий спейс: {{workspace_link}}" },\n';
html = html.replace(addonsAnchor, addonsProduct + addonsAnchor);

// 3h. убираем вкладку «Ловим заявку в Grist» у всех продуктов,
// а её два пункта переносим первыми в «Чеклист: до интро»
const gristItems =
  '  { id: "assign_manager", label: "Проставляем в Manager своё имя" },\n' +
  '  { id: "set_csm_status", label: "Ставим статус CSM Status = Организую" }\n';
const gristDecl =
  'const GRIST_STAGE = { id: "grist_stage", title: "Ловим заявку в Grist", items: [\n' +
  gristItems + '] };';
if (!html.includes(gristDecl)) throw new Error('Grist-вкладка: не найдено объявление GRIST_STAGE');
html = html.replace(gristDecl, 'const GRIST_STAGE = { id: "grist_stage", title: "Ловим заявку в Grist", items: [] };');

const preIntroHead = 'const PRE_INTRO_CHECKLIST_STAGE = { id: "pre_intro_checklist_stage", title: "Чеклист: до интро", items: [\n';
if (!html.includes(preIntroHead)) throw new Error('Grist-вкладка: не найден «Чеклист: до интро»');
html = html.replace(preIntroHead, preIntroHead + gristItems.replace(/\n$/, ',\n'));

const gristTab =
  '      productTabs: [{\n' +
  '        title: GRIST_STAGE.title + (this.isStageComplete(GRIST_STAGE, selectedProductId) ? " \u2705" : ""),\n' +
  '        select: () => { this.setState({ productStage: GRIST_STAGE.id, copied: false }); this.scrollTop(); },\n' +
  '        color: productStage === GRIST_STAGE.id ? "#8a3324" : "#6b6255",\n' +
  '        weight: productStage === GRIST_STAGE.id ? 600 : 400,\n' +
  '        border: productStage === GRIST_STAGE.id ? "#8a3324" : "transparent"\n' +
  '      }, {\n';
if (!html.includes(gristTab)) throw new Error('Grist-вкладка: не найдена вкладка в productTabs');
html = html.replace(gristTab, '      productTabs: [{\n');

const starts = (html.match(/productStage: "grist_stage"/g) || []).length;
if (starts < 4) throw new Error('Grist-вкладка: ожидали минимум 4 места со стартовой вкладкой, нашли ' + starts);
html = html.replace(/productStage: "grist_stage"/g, 'productStage: "input_stage"');

// 3i. правки чеклистов: текст про вставку из Grist, состав «Чеклиста: до интро»
// и пречек на вкладке «Интро»
const edits = [
  // подпись над полем вставки
  ['Вставь строчку целиком, скопированную из Grist (со всеми колонками, разделёнными табуляцией) — тег клиента, ссылка на Notion-спейс и ссылка на форму фидбека подставятся автоматически.',
   'Вставь текст из задачи на организацию услуг — тег клиента, ссылка на Notion-спейс и ссылка на форму фидбека подставятся автоматически.'],
  // три пункта из «Чеклиста: до интро» убираем
  ['  { id: "check_existing_chat", label: "Проверяем, есть ли уже такой чат — если да, следующий пункт пропускаем", showClientStatus: true },\n', ''],
  ['  { id: "create_chat", label: "Создать чат с клиентом и сразу добавить бота @AFAgentBot", showChatName: true, showAvatar: true, showBotHandle: true },\n', ''],
  ['  { id: "chat_description", label: "Добавить в description чата название продукта", showProductName: true },\n', ''],
  // вместо них — аватарка, сразу после статуса CSM
  ['  { id: "set_csm_status", label: "Ставим статус CSM Status = Организую" },\n',
   '  { id: "set_csm_status", label: "Ставим статус CSM Status = Организую" },\n' +
   '  { id: "set_avatar", label: "Проставь аватарку чату", showAvatar: true },\n'],
  // «Интро»: убираем пояснялку про чат с сейлзами
  ['<div style="font-size:13.5px;color:#6b6255;background:#f2ede3;border:1px solid #e6ded2;border-radius:6px;padding:12px 16px;margin-bottom:14px;line-height:1.5">Сначала идём читаем чат с сейлзами. Если там всё ок, нет спецусловий и можно организовывать — добавляем клиента в чат и отправляем интро.</div>\n', ''],
  // ...и добавляем пречек про важные условия перед добавлением клиента
  ['const INTRO_PRECHECK_ITEMS = [\n  { id: "add_client"',
   'const INTRO_PRECHECK_ITEMS = [\n  { id: "check_conditions", label: "Проверяем, есть ли «Важные условия»" },\n  { id: "add_client"'],
  ['INTRO_PRECHECK_ITEMS.filter(i => i.id === "add_client")',
   'INTRO_PRECHECK_ITEMS.filter(i => i.id === "check_conditions" || i.id === "add_client")'],
  ['INTRO_PRECHECK_ITEMS.filter(i => i.id !== "add_client")',
   'INTRO_PRECHECK_ITEMS.filter(i => i.id !== "check_conditions" && i.id !== "add_client")'],
  ['placeholder="Вставь сюда строку из Grist"', 'placeholder="Вставь сюда текст из задачи"'],
  // от этапа «Красная кнопка» отказались — убираем вкладку у всех продуктов
  ['        if (st === "intro" && product.id !== "p_vip" && product.id !== "p_career_support_rus") {\n' +
   '          return [tab, {\n' +
   '            title: "Красная кнопка",\n' +
   '            select: () => { this.setState({ productStage: "red_button_stage", copied: false }); this.scrollTop(); },\n' +
   '            color: productStage === "red_button_stage" ? "#8a3324" : "#6b6255",\n' +
   '            weight: productStage === "red_button_stage" ? 600 : 400,\n' +
   '            border: productStage === "red_button_stage" ? "#8a3324" : "transparent"\n' +
   '          }];\n' +
   '        }\n', '']
];
for (const [from, to] of edits) {
  if (!html.includes(from)) throw new Error(`чеклисты: не найдено «${from.slice(0, 60)}…»`);
  html = html.replace(from, to);
}

// 3j. ещё правки чеклистов и инфо-блока
const edits2 = [
  // «Чеклист: до интро» — без пункта про Manager
  ['  { id: "assign_manager", label: "Проставляем в Manager своё имя" },\n', ''],
  // «Интро» — без ссылки на тг-чат в Grist
  ['  { id: "paste_link_grist", label: "Вставить ссылку на тг-чат в Grist" }\n', ''],
  // «Чеклист организованной услуги»
  ['  { id: "add_chat_to_folder", label: "Добавить чат с клиентом себе в папку" },\n', ''],
  ['  { id: "grist_employee_tasks", label: "Проставить Employee в тасках", noteByProduct: { p_career_support_rus: "Таски с техническим мок-интервью оставляем без подключений, а в Тамару добавить на таску «Встреча с ресёрч-аналитиком»." } },\n', ''],
  ['label: "В Grist поставить Team Active подобранного эксперта", labelByProduct: { p_career_support_rus: "В Grist поставить Team Active подобранного эксперта и рисерч-аналитика Тамару @londonidiot" }',
   'label: "Добавить подобранного эксперта в 🆕 Team Active", labelByProduct: { p_career_support_rus: "Добавить подобранного эксперта и рисерч-аналитика Тамару @londonidiot в 🆕 Team Active" }'],
  ['label: "В Grist сменить CSM-статус на «Проверить как дела»"',
   'label: "Ставим статус CSM Status = Организовано"']
];
for (const [from, to] of edits2) {
  if (!html.includes(from)) throw new Error(`чеклисты-2: не найдено «${from.slice(0, 60)}…»`);
  html = html.replace(from, to);
}

// «Сколько стоит» -> «Себестоимость услуги» во всех продуктах
const priceLabels = (html.match(/label: "Сколько стоит"/g) || []).length;
if (priceLabels < 7) throw new Error(`инфо-блок: ожидали минимум 7 подписей «Сколько стоит», нашли ${priceLabels}`);
html = html.replace(/label: "Сколько стоит"/g, 'label: "Себестоимость услуги"');

// 3k. рисёрч-аналитик на РФ-рынке: вместо Тамары — Алина
const alina = [
  ['Знакомься, Тамара @londonidiot', 'Знакомься, Алина @alinazlata'],
  ['забронировать встречу с Тамарой по ссылке: https://zcal.co/tamara-ostroukhova. Zoom Тамара пришлет перед встречей.',
   'забронировать встречу с Алиной по ссылке: https://schedule.fillout.com/t/3JXkGiQKmMus. Zoom Алина пришлет перед встречей.'],
  ['Встреча с рисёрч-аналитиком https://zcal.co/tamara-ostroukhova',
   'Встреча с рисёрч-аналитиком https://schedule.fillout.com/t/3JXkGiQKmMus'],
  ['рисерч-аналитика Тамару @londonidiot в 🆕 Team Active',
   'рисерч-аналитика Алину @alinazlata в 🆕 Team Active']
];
for (const [from, to] of alina) {
  if (!html.includes(from)) throw new Error(`Алина: не найдено «${from.slice(0, 60)}…»`);
  html = html.replace(from, to);
}
if (/Тамар|londonidiot|tamara-ostroukhova/.test(html)) throw new Error('Алина: в макете остались упоминания Тамары');

// 3l. новый текст скрипта «Добавление ресерчера» (везде, кроме РФ-рынка)
const addResearcherOld =
  'tpl:"Привет!\\n\\nДобавляю в чат ресерчера. Знакомьтесь, {{researcher_name}} {{tag_researcher}}.' +
  '\\n\\n{{tagclient}}, пожалуйста, забронируйте удобное время по этой ссылке:\\n\\n{{researcher_calendar_link}}"';
const addResearcherNew =
  'tpl:"Всем привет! Добавляю в чат ресерчера/ку. Знакомьтесь, {{researcher_name}} {{tag_researcher}}' +
  '\\n\\n{{tag_researcher}} {{researcher_name}}, пожалуйста, забронируй удобное время по этой ссылке: {{researcher_calendar_link}}' +
  '\\n\\n❗️Отменить или изменить время встречи после бронирования можно по ссылке из письма с приглашением"';
if (!html.includes(addResearcherOld)) throw new Error('Ресерчер: не найден старый текст скрипта');
html = html.replace(addResearcherOld, addResearcherNew);

// 3m. подключение рисёрч-аналитика на РФ: выбор из двух кандидаток
// (как в Coaching Session) + живой счётчик активных клиентов из Grist
const rfField = '  researcher_name: { label: "Имя ресёрчера/ки", fallback: "имя ресёрчера" },\n';
if (!html.includes(rfField)) throw new Error('РФ-ресёрч: не найдено поле researcher_name');
html = html.replace(
  rfField,
  rfField + '  researcher_name_case: { label: "Имя ресёрчера/ки в падеже (с Алиной, с Эллиной)", fallback: "имя ресёрчера в нужном падеже" },\n'
);

// новый текст скрипта
const rfTplOld = /tpl:"\{\{tagclient\}\}, и также добавила к вам в чат рисёрч аналитика[^"]*"/;
if (!rfTplOld.test(html)) throw new Error('РФ-ресёрч: не найден старый текст скрипта');
html = html.replace(
  rfTplOld,
  'tpl:"Также добавляю к вам в чат рисёрч аналитика {{researcher_name}} {{tag_researcher}}' +
  '\\n{{researcher_name}} поможет настроить платформу под твой запрос' +
  '\\n\\n📎 Встреча с рисёрч-аналитиком — 30 минут' +
  '\\n\\nКак только вы подготовите документы с {{expert_name_case}} {{tagexpert}} можно будет забронировать встречу с {{researcher_name_case}} по ссылке:' +
  '\\n{{researcher_calendar_link}}' +
  '\\n\\nZoom {{researcher_name}} также пришлет перед встречей"'
);

// карточки выбора — в начало этапа
const stageOpen = '<sc-if value="{{ showStageScript }}" hint-placeholder-val="{{ false }}">';
if (!html.includes(stageOpen)) throw new Error('РФ-ресёрч: не найден блок этапа');
const card = (sel, pick, name, tg, load) =>
  `<div onClick="{{ ${pick} }}" style="cursor:pointer;flex:1;border:1px solid {{ ${sel} }};border-radius:6px;padding:14px 16px;background:#faf7f1">` +
  `<div style="font-size:14px;font-weight:600;color:#22201d;margin-bottom:4px">{{ ${name} }}</div>` +
  `<div style="font-size:12.5px;color:#8a7f6e;margin-bottom:6px">{{ ${tg} }}</div>` +
  `<div style="font-size:12.5px;color:#4a6b8a;margin-bottom:10px">{{ ${load} }}</div>` +
  `<div style="display:inline-block;font-size:12.5px;padding:5px 12px;border-radius:5px;border:1px solid #d8cfbe;color:#6b6255">Выбрать</div></div>`;
html = html.replace(
  stageOpen,
  stageOpen +
  '\n<sc-if value="{{ showRfPicker }}" hint-placeholder-val="{{ false }}">' +
  '<div style="background:#fff;border:1px solid #e6ded2;border-radius:6px;padding:18px 22px;margin-bottom:20px">' +
  '<div style="font-weight:600;font-size:14px;margin-bottom:4px">Кого подключаем</div>' +
  '<div style="font-size:12.5px;color:#8a7f6e;margin-bottom:12px">Активные клиенты на Career support Rus — из Grist, обновляются вместе со страницей</div>' +
  '<div style="display:flex;gap:12px">' +
  card('rfSelA', 'rfPickA', 'rfNameA', 'rfTgA', 'rfLoadA') +
  card('rfSelB', 'rfPickB', 'rfNameB', 'rfTgB', 'rfLoadB') +
  '</div></div></sc-if>'
);

// логика: кандидатки и счётчик
const logicAnchor = '    const introTplByMode = {';
if (!html.includes(logicAnchor)) throw new Error('РФ-ресёрч: не найдено место для логики');
html = html.replace(
  logicAnchor,
  '    const RF_TEAM = [\n' +
  '      { name: "Алина", nameCase: "Алиной", telegram: "@alinazlata", link: "https://schedule.fillout.com/t/3JXkGiQKmMus", find: "zolotareva" },\n' +
  '      { name: "Эллина", nameCase: "Эллиной", telegram: "@mctvnss", link: "https://form.fillout.com/t/5qcpT22PxCus", find: "krivorotova" }\n' +
  '    ];\n' +
  '    const rfPlural = (n) => (n % 10 === 1 && n % 100 !== 11) ? "активный клиент"\n' +
  '      : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? "активных клиента" : "активных клиентов";\n' +
  '    const rfLoadLabel = (needle) => {\n' +
  '      const map = this.activeClients || {};\n' +
  '      const key = Object.keys(map).find(k => k.toLowerCase().includes(needle));\n' +
  '      if (!key) return "нет данных в Grist";\n' +
  '      const n = (map[key] || []).filter(c => /career support rus/i.test(c.product || "")).length;\n' +
  '      return n + " " + rfPlural(n);\n' +
  '    };\n' +
  '    const rfPickFn = (r) => () => {\n' +
  '      this.setField("researcher_name", r.name);\n' +
  '      this.setField("researcher_name_case", r.nameCase);\n' +
  '      this.setField("tag_researcher", r.telegram);\n' +
  '      this.setField("researcher_calendar_link", r.link);\n' +
  '      this.setState({ rfResearcher: r.name });\n' +
  '    };\n' +
  logicAnchor
);

const valsAnchor = '      coachingExperts: ';
if (!html.includes(valsAnchor)) throw new Error('РФ-ресёрч: не найден coachingExperts');
html = html.replace(
  valsAnchor,
  '      showRfPicker: view === "product" && productStage === "research_rf_stage",\n' +
  '      rfNameA: RF_TEAM[0].name, rfTgA: RF_TEAM[0].telegram, rfLoadA: rfLoadLabel(RF_TEAM[0].find),\n' +
  '      rfSelA: this.state.rfResearcher === RF_TEAM[0].name ? "#8a3324" : "#e6ded2",\n' +
  '      rfPickA: rfPickFn(RF_TEAM[0]),\n' +
  '      rfNameB: RF_TEAM[1].name, rfTgB: RF_TEAM[1].telegram, rfLoadB: rfLoadLabel(RF_TEAM[1].find),\n' +
  '      rfSelB: this.state.rfResearcher === RF_TEAM[1].name ? "#8a3324" : "#e6ded2",\n' +
  '      rfPickB: rfPickFn(RF_TEAM[1]),\n' +
  valsAnchor
);

// 3n. в Grist переехали колонки в заявке на серчера — чиним разбор вставленной строки
const parseOld =
  '    const parts = raw.split("\\t");\n' +
  '    const product = (parts[1] || "").trim();\n' +
  '    const expertName = (parts[3] || "").trim();\n' +
  '    let request = (parts.find(p => p.trim().length > 40 || /Запрос серчера/i.test(p)) || parts[parts.length - 2] || "").trim();';
const parseNew =
  '    const parts = raw.split("\\t");\n' +
  '    // Порядок колонок в CRM Tasks: Client, Searcher from Commitment, Manager Client,\n' +
  '    // Product Commitment, Тип заявки, Deadline, Крайний срок подключения, By Team,\n' +
  '    // CSM Status, Done, Note, Task, Client TG, Created at, Entergram ID, Employee,\n' +
  '    // Searcher Request, CSM Type\n' +
  '    const TASK_COLS = 18, COL_PRODUCT = 3, COL_BY_TEAM = 7, COL_TASK = 11, COL_CLIENT_TG = 12;\n' +
  '    const newLayout = parts.length >= TASK_COLS;\n' +
  '    const isProductTag = (t) => PRODUCTS.some(pr => pr.matrixKey && pr.matrixKey.toLowerCase() === String(t).trim().toLowerCase());\n' +
  '    let product = ((newLayout ? parts[COL_PRODUCT] : parts[1]) || "").trim();\n' +
  '    if (!isProductTag(product)) product = (parts.find(t => isProductTag(t)) || "").trim();\n' +
  '    const expertName = ((newLayout ? parts[COL_BY_TEAM] : parts[3]) || "").trim();\n' +
  '    let request = ((newLayout ? parts[COL_TASK] : "") || parts.find(p => p.trim().length > 40 || /Запрос серчера/i.test(p)) || parts[parts.length - 2] || "").trim();';
if (!html.includes(parseOld)) throw new Error('заявка на серчера: не найден разбор строки');
html = html.replace(parseOld, parseNew);

const tgOld = '    const clientTg = (parts[parts.length - 2] || "").trim();';
const tgNew = '    const clientTg = ((newLayout ? parts[COL_CLIENT_TG] : parts[parts.length - 2]) || "").trim();';
if (!html.includes(tgOld)) throw new Error('заявка на серчера: не найдена колонка с тегом клиента');
html = html.replace(tgOld, tgNew);

// в Client TG теперь попадаются телефоны — в тег их не превращаем
const tgGuardOld = 'if (clientTg && !/^https?:\\/\\//i.test(clientTg) && clientTg.indexOf(" ") === -1) {';
const tgGuardNew = 'if (clientTg && !/^https?:\\/\\//i.test(clientTg) && clientTg.indexOf(" ") === -1 && !/^[+\\d]/.test(clientTg)) {';
if (!html.includes(tgGuardOld)) throw new Error('заявка на серчера: не найдена проверка тега клиента');
html = html.replace(tgGuardOld, tgGuardNew);

// 3o. вкладка «Интро»: чекбокс «уже работали», список «что прислать» из
// «Что запрашивать», отложенный старт с датой, инфо-поля у Addons
// 0) единообразное «Я — Настя» и без двойных пробелов после «привет!»
const helloRe = /привет!\s+Я\s*[-—]\s*Настя, CSM AgileFluent/g;
const helloHits = (html.match(helloRe) || []).length;
if (helloHits < 5) throw new Error(`интро: ожидали минимум 5 приветствий, нашли ${helloHits}`);
html = html.replace(helloRe, 'привет! Я — Настя, CSM AgileFluent');

const introEdits = [
  // 1) род у Career support Rus
  ['Подбираю тебе эксперта для работы и добавлю её сюда в рабочий чатик в течение суток🚀',
   'Подбираю тебе эксперта для работы и добавлю сюда в рабочий чатик в течение суток🚀'],
  // 2) поле «когда хочет начать»
  ['  expert_name_case: { label: "Имя эксперта в падеже (с Анной, с Дмитрием...)", fallback: "имя эксперта в нужном падеже" },',
   '  start_when: { label: "Когда хочет начать (после 1 декабря, в январе)", fallback: "позже" },\n' +
   '  expert_name_case: { label: "Имя эксперта в падеже (с Анной, с Дмитрием...)", fallback: "имя эксперта в нужном падеже" },'],
  // 3) подсказку про «уже работали» заменяем чекбоксом
  ['<div style="font-size:12.5px;color:#8a7f6e;background:#f2ede3;border:1px solid #e6ded2;border-radius:6px;padding:10px 14px;margin-bottom:16px;line-height:1.5">Если уже работали с этим клиентом раньше — представляться заново не нужно, начинай сразу с сути сообщения.</div>',
   '<div onClick="{{ onToggleKnownClient }}" style="display:flex;align-items:center;gap:10px;background:#f2ede3;border:1px solid #e6ded2;border-radius:6px;padding:10px 14px;margin-bottom:16px;cursor:pointer">' +
   '<div style="width:18px;height:18px;flex-shrink:0;border-radius:4px;border:1.5px solid {{ knownClientBorder }};background:{{ knownClientBg }};color:#fff;font-size:12px;display:flex;align-items:center;justify-content:center">{{ knownClientMark }}</div>' +
   '<div style="font-size:13px;color:#6b6255">Уже работали с этим клиентом — представляться заново не нужно</div></div>'],
  // 4) у Addons прячем вариант «Данных нет»
  ['<div onClick="{{ introToggle.onNoData }}" style="cursor:pointer;font-size:13.5px;padding:8px 16px;border-radius:6px;border:1px solid {{ introToggle.noDataBorder }};background:{{ introToggle.noDataBg }};color:{{ introToggle.noDataColor }};font-weight:{{ introToggle.noDataWeight }}">Данных нет</div>',
   '<sc-if value="{{ showIntroNoDataBtn }}" hint-placeholder-val="{{ true }}"><div onClick="{{ introToggle.onNoData }}" style="cursor:pointer;font-size:13.5px;padding:8px 16px;border-radius:6px;border:1px solid {{ introToggle.noDataBorder }};background:{{ introToggle.noDataBg }};color:{{ introToggle.noDataColor }};font-weight:{{ introToggle.noDataWeight }}">Данных нет</div></sc-if>']
];
for (const [from, to] of introEdits) {
  if (!html.includes(from)) throw new Error(`интро: не найдено «${from.slice(0, 60)}…»`);
  html = html.replace(from, to);
}

// 5) шаблоны «данных нет» и «отложенный старт» — считаем из «Что запрашивать»
const tplByModeOld =
  '    const introTplByMode = {\n' +
  '      data: product.introTpl,\n' +
  '      nodata: product.introNoDataTpl || INTRO_NO_DATA_TPL,\n' +
  '      deferred: introDeferredHasData ? INTRO_DEFERRED_DATA_TPL : INTRO_DEFERRED_NO_DATA_TPL\n' +
  '    };';
if (!html.includes(tplByModeOld)) throw new Error('интро: не найден introTplByMode');
html = html.replace(tplByModeOld,
  '    const INTRO_HELLO = "{{tagclient}}, привет! Я — Настя, CSM AgileFluent, ко мне можно обращаться с вопросами)";\n' +
  '    const introAskItems = (p) => {\n' +
  '      const it = (((p || {}).infoStage || {}).items || []).find(i => /Что запрашивать/i.test(i.label || ""));\n' +
  '      return String((it && it.value) || "").split(/[,;]/).map(x => x.trim()).filter(Boolean);\n' +
  '    };\n' +
  '    const INTRO_ASK_LINE = { "cv": "CV", "linkedin": "LinkedIn", "запрос": "Твой запрос: на какие роли, индустрии и страны ты целишься" };\n' +
  '    const introAskBullets = (p) => introAskItems(p).map(x => "— " + (INTRO_ASK_LINE[x.toLowerCase()] || x)).join("\\n");\n' +
  '    const introAskInline = (p) => {\n' +
  '      const list = introAskItems(p).map(x => /^[А-ЯЁ][а-яё]/.test(x) ? x.toLowerCase() : x);\n' +
  '      if (!list.length) return "";\n' +
  '      return list.length === 1 ? list[0] : list.slice(0, -1).join(", ") + " и " + list[list.length - 1];\n' +
  '    };\n' +
  '    const introNoDataFor = (p) => {\n' +
  '      const id = (p || {}).id;\n' +
  '      if (id === "p_career_support_rus") return INTRO_HELLO + "\\n\\nОтправишь, пожалуйста, своё CV? Я его изучу и подберу для тебя эксперта)";\n' +
  '      if (id === "p_job_pack" || id === "p_applies100" || id === "p_vip") {\n' +
  '        const who = id === "p_vip" ? "менторку" : "эксперта";\n' +
  '        return INTRO_HELLO + "\\n\\nОтправишь, пожалуйста, следующую информацию, я её изучу и подберу для тебя " + who + ":\\n" +\n' +
  '          introAskBullets(p) + "\\n\\nЭто нужно, чтобы подобрать " + who + " с наиболее релевантной специализацией)";\n' +
  '      }\n' +
  '      return "";\n' +
  '    };\n' +
  '    const introDeferredFor = (p, hasData) => {\n' +
  '      const base = INTRO_HELLO + " Команда передала, что ты хочешь начать {{start_when}}. Вернусь к тебе ближе к этому времени.";\n' +
  '      const list = introAskInline(p);\n' +
  '      return (hasData || !list) ? base\n' +
  '        : base + "\\n\\nА пока пришли, пожалуйста, " + list + " — так к старту всё будет готово и мы сразу подберём эксперта.";\n' +
  '    };\n' +
  '    const introTplByMode = {\n' +
  '      data: product.introTpl,\n' +
  '      nodata: product.id === "p_applies_addons" ? product.introTpl\n' +
  '        : (introNoDataFor(product) || product.introNoDataTpl || INTRO_NO_DATA_TPL),\n' +
  '      deferred: introDeferredFor(product, introDeferredHasData)\n' +
  '    };'
);

// 6) чекбокс «уже работали» выкидывает фразу-представление
const tplTail = '      : (activeSubScript ? activeSubScript.tpl : (script ? script.tpl : ""));';
if (!html.includes(tplTail)) throw new Error('интро: не найден конец rawScriptTpl');
html = html.replace('    const rawScriptTpl = view === "product"', '    const rawScriptTpl0 = view === "product"');
html = html.replace(tplTail,
  tplTail + '\n' +
  '    const rawScriptTpl = (view === "product" && productStage === "intro" && this.state.introKnownClient)\n' +
  '      ? String(rawScriptTpl0 || "").replace(/Я — Настя, CSM AgileFluent, ко мне можно обращаться с вопросами\\)( Рада, что ты будешь с нами бежать до оффера! ✨)?/, "Рада снова работать с тобой)")\n' +
  '      : rawScriptTpl0;'
);

// 7) значения для шаблона
const introVals = '      introToggle: {';
if (!html.includes(introVals)) throw new Error('интро: не найден introToggle');
html = html.replace(introVals,
  '      showIntroNoDataBtn: product.id !== "p_applies_addons",\n' +
  '      knownClientMark: this.state.introKnownClient ? "✓" : "",\n' +
  '      knownClientBorder: this.state.introKnownClient ? "#8a3324" : "#d8cfbe",\n' +
  '      knownClientBg: this.state.introKnownClient ? "#8a3324" : "transparent",\n' +
  '      onToggleKnownClient: () => this.setState(st => ({ introKnownClient: !st.introKnownClient })),\n' +
  introVals
);

// 8) инфо-блок у Addons: пустые поля
const addonsInfoTail = '      { label: "В скрипте подключения", value: "Строку «Когда все документы будут готовы, в чат добавят серчера/ку» ';
if (!html.includes(addonsInfoTail)) throw new Error('Addons: не найден инфо-блок');
html = html.replace(
  '  { id: "p_applies_addons", title: "Applies&Outreach Addons", matrixKey: "Applies-100 and LinkedIn Outreach",\n' +
  '    infoStage: { title: "Информация", items: [\n',
  '  { id: "p_applies_addons", title: "Applies&Outreach Addons", matrixKey: "Applies-100 and LinkedIn Outreach",\n' +
  '    infoStage: { title: "Информация", items: [\n' +
  '      { label: "Duration", value: "[ЗАПОЛНИТЬ]" },\n' +
  '      { label: "Team", value: "[ЗАПОЛНИТЬ]" },\n'
);
html = html.replace(
  'оставляем, только если клиент давно с нами работал." }\n    ] },',
  'оставляем, только если клиент давно с нами работал." },\n' +
  '      { label: "Фильтры в матрице", value: "[ЗАПОЛНИТЬ]" },\n' +
  '      { label: "Что запрашивать", value: "[ЗАПОЛНИТЬ]" }\n    ] },'
);

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
