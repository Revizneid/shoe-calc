// api/parse.js  —  Vercel Serverless Function
// provider: 'gemini' | 'mistral' | 'auto' (auto = gemini trước, fallback mistral)

export const config = { maxDuration: 60 };

const GEMINI_MODEL  = 'gemini-2.5-flash';
const MISTRAL_MODEL = 'mistral-small-latest';

const PROMPT = `Đây là 2 tài liệu sản xuất giày (tiếng Trung):
- Document 1: Đơn sản xuất (生产单) — bảng màu sắc và số lượng
- Document 2: Bảng dùng liệu chính (主面料用量表) — tiêu hao nguyên liệu

Trích xuất và trả về DUY NHẤT một JSON object. Không giải thích, không markdown, không backtick.

{
  "po": {
    "orderNo": "factory order no (厂单号/厂单编号)",
    "model":   "model code (型体号码)",
    "style":   "style name (款名)",
    "cust":    "customer (客户)",
    "season":  "season (季节)",
    "totalQ":  total_quantity_integer,
    "colors": [
      { "id": "row NO.", "code": "full COLOR/SKU cell text",
        "qty": integer_from_合计_column, "qtyMissing": false }
    ]
  },
  "bom": {
    "orderNo": "factory order no if present",
    "model":   "model code if present",
    "mats": [
      {
        "cfg":      "config codes e.g. '1' or '1+2+3'",
        "part":     "part name Chinese (部位)",
        "matName":  "FULL material name as written — keep Chinese AND English together, e.g. '斯普伦多牛皮/SPLENDOR CALF'",
        "engName":  "",
        "color":    "FULL color as written — keep Chinese AND English together, e.g. '黑色/BLACK'",
        "engColor": "",
        "spec":     "spec/thickness e.g. '1.3-1.5MM'",
        "perPair":  consumption_number,
        "unit":     "SF or m2 or yd",
        "note":     "notes if any"
      }
    ]
  }
}

Quy tắc:
- qty: đọc từ cột 合计, số nguyên 3-6 chữ số. Không đọc được → qty:0, qtyMissing:true
- cfg: nếu rowspan nhiều hàng thì lặp lại cfg đó cho từng hàng
- perPair: ưu tiên SF/对 > m²/对 > yd/对
- Chỉ trả hàng có matName và perPair > 0
- Trả JSON thuần, tuyệt đối không có backtick hay markdown`;

// ── Shared helpers ────────────────────────────────────────────────────────────
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const RETRY    = new Set([429, 500, 502, 503, 504]);

function stripAndParse(raw, providerName) {
  const clean = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try {
    return JSON.parse(clean);
  } catch (e) {
    console.error(`${providerName} raw:`, raw.slice(0, 1000));
    throw new Error(`${providerName} trả về JSON không hợp lệ: ${e.message}`);
  }
}

// ── Gemini ────────────────────────────────────────────────────────────────────
async function callGemini(apiKey, poPdfB64, bomPdfB64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'application/pdf', data: poPdfB64 } },
      { inline_data: { mime_type: 'application/pdf', data: bomPdfB64 } },
      { text: PROMPT }
    ]}],
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
  };

  for (let i = 1; i <= 4; i++) {
    let resp;
    try {
      resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      if (i < 4) { await sleep(2000 * i); continue; }
      throw new Error('Không kết nối được Gemini: ' + e.message);
    }

    if (resp.ok) {
      let data;
      try { data = await resp.json(); } catch { throw new Error('Gemini body không phải JSON'); }
      const raw = data?.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';
      if (!raw) {
        const reason = data?.candidates?.[0]?.finishReason || data?.error?.message || 'response rỗng';
        throw new Error('Gemini: ' + reason);
      }
      return raw;
    }

    // 429 = quota hết → throw đặc biệt để auto fallback
    if (resp.status === 429) {
      const err = new Error('GEMINI_QUOTA');
      err.quota = true;
      throw err;
    }

    if (RETRY.has(resp.status) && i < 4) { await sleep(2000 * i); continue; }
    const txt = await resp.text().catch(() => '');
    throw new Error(`Gemini lỗi ${resp.status}: ${txt.slice(0, 200)}`);
  }
  throw new Error('Gemini quá tải sau 4 lần thử.');
}

// ── Mistral ───────────────────────────────────────────────────────────────────
async function callMistral(apiKey, poPdfB64, bomPdfB64) {
  const url = 'https://api.mistral.ai/v1/chat/completions';
  const body = {
    model: MISTRAL_MODEL,
    temperature: 0.1,
    max_tokens: 8192,
    messages: [{ role: 'user', content: [
      { type: 'document_url', document_url: `data:application/pdf;base64,${poPdfB64}` },
      { type: 'document_url', document_url: `data:application/pdf;base64,${bomPdfB64}` },
      { type: 'text', text: PROMPT }
    ]}]
  };

  for (let i = 1; i <= 4; i++) {
    let resp;
    try {
      resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify(body) });
    } catch (e) {
      if (i < 4) { await sleep(2000 * i); continue; }
      throw new Error('Không kết nối được Mistral: ' + e.message);
    }

    if (resp.ok) {
      let data;
      try { data = await resp.json(); } catch { throw new Error('Mistral body không phải JSON'); }
      const raw = data?.choices?.[0]?.message?.content || '';
      if (!raw) throw new Error('Mistral trả về nội dung rỗng.');
      return raw;
    }

    if (RETRY.has(resp.status) && i < 4) { await sleep(2000 * i); continue; }
    const txt = await resp.text().catch(() => '');
    throw new Error(`Mistral lỗi ${resp.status}: ${txt.slice(0, 200)}`);
  }
  throw new Error('Mistral quá tải sau 4 lần thử.');
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const GEMINI_KEY  = process.env.GEMINI_API_KEY;
  const MISTRAL_KEY = process.env.MISTRAL_API_KEY;

  let poPdfB64, bomPdfB64, provider;
  try {
    ({ poPdfB64, bomPdfB64, provider = 'auto' } = req.body);
    if (!poPdfB64 || !bomPdfB64) throw new Error('Thiếu poPdfB64 hoặc bomPdfB64');
  } catch (e) {
    return res.status(400).json({ error: 'Request body không hợp lệ: ' + e.message });
  }

  // Validate keys theo provider được chọn
  if ((provider === 'gemini' || provider === 'auto') && !GEMINI_KEY && provider === 'gemini')
    return res.status(500).json({ error: 'GEMINI_API_KEY chưa cấu hình trong Vercel env vars.' });
  if ((provider === 'mistral') && !MISTRAL_KEY)
    return res.status(500).json({ error: 'MISTRAL_API_KEY chưa cấu hình trong Vercel env vars.' });
  if (provider === 'auto' && !GEMINI_KEY && !MISTRAL_KEY)
    return res.status(500).json({ error: 'Cần cấu hình ít nhất GEMINI_API_KEY hoặc MISTRAL_API_KEY.' });

  let rawText, usedProvider;

  try {
    if (provider === 'gemini') {
      rawText = await callGemini(GEMINI_KEY, poPdfB64, bomPdfB64);
      usedProvider = 'gemini';

    } else if (provider === 'mistral') {
      rawText = await callMistral(MISTRAL_KEY, poPdfB64, bomPdfB64);
      usedProvider = 'mistral';

    } else {
      // auto: Gemini trước, fallback Mistral nếu quota hết
      if (GEMINI_KEY) {
        try {
          rawText = await callGemini(GEMINI_KEY, poPdfB64, bomPdfB64);
          usedProvider = 'gemini';
        } catch (e) {
          if (e.quota && MISTRAL_KEY) {
            console.log('Gemini quota hết → fallback Mistral');
            rawText = await callMistral(MISTRAL_KEY, poPdfB64, bomPdfB64);
            usedProvider = 'mistral';
          } else {
            throw e;
          }
        }
      } else {
        rawText = await callMistral(MISTRAL_KEY, poPdfB64, bomPdfB64);
        usedProvider = 'mistral';
      }
    }
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  let parsed;
  try {
    parsed = stripAndParse(rawText, usedProvider);
  } catch (e) {
    return res.status(422).json({ error: e.message, raw: rawText.slice(0, 300) });
  }

  // Trả thêm usedProvider để frontend biết dùng AI nào
  return res.status(200).json({ ...parsed, _provider: usedProvider });
}
