// api/parse.js  —  Vercel Serverless Function
// provider: 'gemini' | 'mistral' | 'auto' (auto = gemini trước, fallback mistral)

export const config = { maxDuration: 60 };

const GEMINI_MODEL  = 'gemini-2.5-flash';
const MISTRAL_MODEL = 'pixtral-12b-2409';  // vision model, tốt hơn cho PDF scan phức tạp

const PROMPT = `Đây là 2 tài liệu sản xuất giày (tiếng Trung):
- Document 1: Đơn sản xuất (生产单) — bảng màu sắc và số lượng từng màu
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
      {
        "id":         "row NO. (配色NO./色号NO.)",
        "code":       "full COLOR code/SKU cell text (COLOR CODE/色号列)",
        "qty":        integer_total_quantity_for_this_color_from_合计_column,
        "qtyMissing": false
      }
    ]
  },
  "bom": {
    "orderNo": "factory order no if present",
    "model":   "model code if present",
    "mats": [
      {
        "cfg":      "config/配法 codes e.g. '1' or '2+3' — repeat for each row if rowspan",
        "part":     "part name Chinese (部位名称)",
        "matName":  "FULL material name as written in 材料名称 column — keep Chinese AND English, e.g. '斯普伦多牛皮/SPLENDOR CALF'",
        "engName":  "",
        "color":    "FULL color as written in 颜色 column — keep Chinese AND English, e.g. '黑色/BLACK'",
        "engColor": "",
        "spec":     "spec/width/thickness from 规格 column e.g. '1.3-1.5MM' or '135-140CM'",
        "sfTarget": target_SF_number_from_目标用量SF_column_or_null,
        "perPairSF": number_from_SF对_column_or_null,
        "perPairY":  number_from_Y对_column_or_null,
        "perPair":  chosen_consumption_number_explained_below,
        "unit":     "chosen unit: SF or m2 or yd or m",
        "note":     "备注 column content if any"
      }
    ]
  }
}

════ QUY TẮC QUAN TRỌNG ════

▌QUY TẮC COLORS (qty):
- qty: đọc từ cột 合计 của từng hàng màu trong đơn sản xuất. Đây là số TỔNG đôi cho màu đó.
- 合计 thường là cột CUỐI CÙNG bên phải trong bảng màu, giá trị là số nguyên 2-5 chữ số (vd: 830, 1150, 97, 3565).
- Nếu bảng có nhiều dòng phân phối (A单, B单...G单...) thì lấy cột 合计 chứ không cộng tay.
- Nếu không đọc được: qty:0, qtyMissing:true

▌QUY TẮC perPair & unit (QUAN TRỌNG):
BOM có 3 cột dữ liệu: [目标用量SF] [SF/对] [Y/对]

BƯỚC 1 — Xác định loại vật liệu (da thật vs phi da):
  - DA THẬT (leather): 牛皮, 羊皮, 猪皮, 绒皮, 反绒, 马毛, 小牛, 羊羔, nappa, suede, calf, leather → dùng cột SF/对
  - PHI DA (non-leather): PU, PVC, 布, 纤维, 无纺, 织物, lining, fabric, mesh, canvas → dùng cột Y/对

BƯỚC 2 — Chọn giá trị:
  - Nếu DA THẬT: perPair = SF/对 column value, unit = "SF"
    - Nếu SF/对 trống: dùng 目标用量SF, unit = "SF"
  - Nếu PHI DA: perPair = Y/对 column value, unit = "m2" (PU/PVC/布 dạng tấm), hoặc "yd" nếu Y/对
    - Nếu Y/对 trống: dùng 目标用量SF, unit = "SF"
  - Luôn ưu tiên giá trị thực tế đo được (SF/对 hoặc Y/对) hơn mục tiêu (目标用量SF)

BƯỚC 3 — Điền sfTarget, perPairSF, perPairY đúng từng cột tương ứng (null nếu ô trống/gạch ngang)

▌QUY TẮC CFG:
- cfg rowspan: nếu 1 cấu hình (配法) bao gồm nhiều hàng, lặp lại cfg đó cho mỗi hàng
- cfg dạng "2+3" nghĩa là cấu hình áp dụng cho cả màu 2 và màu 3

Chỉ trả hàng có matName và perPair > 0. Trả JSON thuần, không backtick.`;

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

  // ── Normalize: đảm bảo structure luôn đúng dù AI trả thiếu ──────────────────
  // Một số model wrap kết quả khác nhau, ví dụ { data: { po, bom } } hoặc { result: ... }
  if (!parsed.po && !parsed.bom) {
    // Thử tìm nested
    const nested = parsed.data || parsed.result || parsed.output || Object.values(parsed)[0];
    if (nested && (nested.po || nested.bom)) {
      parsed = nested;
    }
  }
  if (!parsed.po  || typeof parsed.po  !== 'object') parsed.po  = {};
  if (!parsed.bom || typeof parsed.bom !== 'object') parsed.bom = {};
  if (!Array.isArray(parsed.po.colors))  parsed.po.colors  = [];
  if (!Array.isArray(parsed.bom.mats))   parsed.bom.mats   = [];

  // Trả thêm usedProvider để frontend biết dùng AI nào
  return res.status(200).json({ ...parsed, _provider: usedProvider });
}
