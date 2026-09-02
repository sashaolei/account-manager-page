// Тонкий клиент Grist REST API (аналог GristRepo.ts, но без zod/бэкенда).
const BASE_URL = process.env.GRIST_BASE_URL || 'https://team.agilefluent.co';
const DOC_ID = process.env.GRIST_DOC_ID || 'sviG8pvrrPDw1eU26QGsc5';
const API_KEY = process.env.GRIST_API_KEY;

export async function records(table, { filter, limit } = {}) {
  if (!API_KEY) throw new Error('GRIST_API_KEY не задан');
  const params = new URLSearchParams();
  if (filter) params.set('filter', JSON.stringify(filter));
  if (limit) params.set('limit', String(limit));
  const qs = params.toString() ? `?${params}` : '';
  const url = `${BASE_URL}/api/docs/${DOC_ID}/tables/${table}/records${qs}`;

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${API_KEY}` }
      });
      if (!res.ok) throw new Error(`Grist ${table}: HTTP ${res.status} ${await res.text()}`);
      const json = await res.json();
      return json.records.map((r) => ({ id: r.id, ...mapFields(r.fields) }));
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, attempt * 1500));
    }
  }
  throw lastErr;
}

// Разворачивает служебные объекты Grist (["L", ...], ["R", table, id] и т.д.)
function mapFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) out[k] = parseValue(v);
  return out;
}

function parseValue(value) {
  if (!Array.isArray(value)) return value;
  if (value.length === 0) return null;
  const [code, ...data] = value;
  switch (code) {
    case 'L': return data;
    case 'l': return data[0] ?? null;
    case 'O': return data[0] ?? null;
    case 'D': case 'd': return data[0] ?? null;
    case 'R': return data[1] ?? null;
    case 'r': return data[1] ?? null;
    case 'C': case 'E': case 'P': return null;
    case 'U': case 'V': return data[0] ?? null;
    default: return value;
  }
}

// Всегда возвращает массив id из ссылочного поля
export const refs = (v) => (Array.isArray(v) ? v : v == null || v === 0 ? [] : [v]);
