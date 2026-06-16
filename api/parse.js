// api/parse.js  —  Vercel Serverless Function
// provider: 'gemini' | 'mistral' | 'auto'

export const config = { maxDuration: 60 };

const GEMINI_MODEL  = 'gemini-2.5-flash';
const MISTRAL_MODEL = 'pixtral-12b-2409';

// ── Prompt: cả 2 doc gộp (dùng cho Gemini — xử lý tốt multi-doc) ─────────────
const PROMPT_COMBINED = `Đây là 2 tài liệu sản xuất giày (tiếng Trung):
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
      { "id": "row NO.", "code": "full COLOR code/SKU cell text",
        "qty": integer_from_合计_column, "qtyMissing": false }
    ]
  },
  "bom": {
    "orderNo": "factory order no if present",
    "model":   "model code if present",
    "mats": [
      {
        "cfg":       "config/配法 e.g. '1' or '2+3' — repeat for each row if rowspan",
        "part":      "part name Chinese (部位名称)",
        "matName":   "FULL material name — keep Chinese AND English e.g. '斯普伦多牛皮/SPLENDOR CALF'",
        "engName":   "",
        "color":     "FULL color — keep Chinese AND English e.g. '黑色/BLACK'",
        "engColor":  "",
        "spec":      "规格 column e.g. '135-140CM'",
        "sfTarget":  number_or_null,
        "perPairSF": number_or_null,
        "perPairY":  number_or_null,
        "perPair":   chosen_number,
        "unit":      "SF or m2 or yd",
        "note":      ""
      }
    ]
  }
}

QUY TẮC qty (COLORS):
- qty = cột 合计 (cột CUỐI CÙNG bên phải bảng màu), số nguyên 2-5 chữ số.
- KHÔNG cộng các cột A单 B单 C单... — chỉ đọc 合计.
- Nếu không đọc được: qty:0, qtyMissing:true

QUY TẮC perPair (BOM — 3 cột: 目标用量SF | SF/对 | Y/对):
- DA THẬT (牛皮,羊皮,猪皮,反绒,绒皮,马毛,nappa,suede,calf,leather,kid): perPair=SF/对, unit=SF
- PHI DA (PU,PVC,布,纤维,无纺,lining,fabric): perPair=Y/对, unit=m2
- Fallback nếu cột ưu tiên trống: dùng 目标用量SF, unit=SF
- Điền đúng sfTarget/perPairSF/perPairY từng cột (null nếu trống)

QUY TẮC cfg: rowspan → lặp lại cfg cho từng hàng con.
Chỉ trả hàng có matName và perPair > 0. JSON thuần, không backtick.`;

// ── Prompt chỉ đọc PO (dùng cho Mistral call 1) ──────────────────────────────
const PROMPT_PO = `Đây là đơn sản xuất giày (生产单). Đọc TẤT CẢ trang.

BƯỚC 1 — Tìm số tổng đơn hàng:
Tìm trường "订单总数" hoặc "总计" hoặc "合计" trong phần HEADER của đơn (không phải trong bảng màu).
Ghi lại số đó là totalQ.

BƯỚC 2 — Tìm bảng màu:
Bảng có dòng header chứa "NO." và nhiều tên kênh (A单, B单...) và cột "合计" ở cuối.

BƯỚC 3 — Đối với mỗi hàng màu, làm theo thứ tự:
a) Đọc số trong ô "合计" (cột cuối bên phải của bảng màu).
b) Kiểm tra: số đó có hợp lý không? (không vượt quá totalQ, không bằng số ở cột khác).
c) Nếu nghi ngờ: tìm số lớn nhất trong hàng đó, đó thường là 合计.

BƯỚC 4 — Kiểm tra tổng:
Cộng tất cả qty lại. Nếu tổng ≠ totalQ (sai > 10%) → xem lại các hàng có qty bất thường.

Trả về JSON, không markdown, không backtick:
{
  "orderNo": "厂单号",
  "model": "型体号码",
  "style": "款名",
  "cust": "客户",
  "season": "季节",
  "totalQ": số_tổng_từ_header,
  "colors": [
    { "id": "1", "code": "tên màu/SKU đầy đủ", "qty": số_từ_cột_合计, "qtyMissing": false }
  ]
}
Nếu không đọc được ô 合计: qty:0, qtyMissing:true. JSON thuần.`;

// ── Prompt retry PO — tiếp cận hoàn toàn khác ───────────────────────────────
const PROMPT_PO_RETRY = `Đây là đơn sản xuất giày. Tìm và đọc thông tin sau:

THÔNG TIN CẦN ĐỌC:
1. Trường "订单总数" trong header đơn → đây là TỔNG số đôi toàn đơn.
2. Với mỗi hàng màu trong bảng phân phối: đọc số trong cột "合计" — cột CỰC PHẢI của bảng.

QUY TẮC ĐỌC CỘT 合计:
- Bảng phân phối có nhiều cột kênh (A单 B单 C单...). Cột cuối cùng là "合计".
- Trong mỗi hàng, số 合计 PHẢI NHỎ HƠN HOẶC BẰNG 订单总数.
- Nếu số bạn đọc được > 订单总数 thì sai — đọc lại.
- Nếu tổng tất cả qty > 订单总数 thì sai — xem lại.

JSON trả về (không markdown, không backtick):
{
  "orderNo": "厂单号",
  "model": "型体号码",
  "style": "款名",
  "cust": "客户",
  "season": "季节",
  "totalQ": số_từ_订单总数,
  "colors": [
    { "id": "1", "code": "COLOR CODE/SKU", "qty": số_合计, "qtyMissing": false }
  ]
}
qty không bao giờ > totalQ. Nếu không đọc được: qtyMissing:true, qty:0.`;

// ── Prompt chỉ đọc BOM (dùng cho Mistral call 2) ─────────────────────────────
const PROMPT_BOM = `Đây là bảng dùng liệu chính sản xuất giày (主面料用量表/面料用量控制表). CHỈ đọc bảng nguyên liệu.

Trả về DUY NHẤT JSON sau. Không giải thích, không markdown, không backtick.

{
  "orderNo": "factory order no (厂单号)",
  "model":   "model code (型体编号)",
  "mats": [
    {
      "cfg":       "配法 e.g. '1' or '2+3' — lặp lại nếu rowspan",
      "part":      "部位名称 (Chinese)",
      "matName":   "材料名称+颜色 — giữ nguyên Chinese AND English e.g. '斯普伦多牛皮/SPLENDOR CALF'",
      "engName":   "",
      "color":     "颜色 — giữ nguyên Chinese AND English e.g. '黑色/BLACK'",
      "engColor":  "",
      "spec":      "规格 e.g. '135-140CM' or '14-20SF'",
      "sfTarget":  number_or_null,
      "perPairSF": number_or_null,
      "perPairY":  number_or_null,
      "perPair":   chosen_number,
      "unit":      "SF or m2 or yd",
      "note":      "备注 nếu có"
    }
  ]
}

QUY TẮC cột (bảng có 3-4 cột số liệu — đọc HEADER ROW để xác định đúng cột):

BƯỚC 1 — Xác định header của bảng:
Tìm hàng tiêu đề chứa: 目标用量SF | SF/对 | Y/对 (hoặc 单一用量 SF | 单一用量 Y)

BƯỚC 2 — Đọc đúng từng cột:
- Cột "目标用量SF" (hoặc "目标用量") → sfTarget (số lớn hơn, 1-2 decimal: 0.48, 1.3, 2.15)
- Cột "SF/对" (hoặc "单一用量 SF/对") → perPairSF (da thật, đơn vị SF)
- Cột "Y/对" (hoặc "单一用量 Y/对") → perPairY (PU/PVC/fabric, đơn vị m2, số nhỏ: 0.026, 0.1143)
- Cột "单刀用量" (phân bổ chi tiết từng bộ phận) → BỎ QUA hoàn toàn, không map vào bất kỳ field nào

BƯỚC 3 — Kiểm tra logic:
- Nếu vật liệu là DA THẬT (牛皮,羊皮,羊京皮,绒皮...): perPairSF phải có giá trị, perPairY thường null
- Nếu vật liệu là PU/PVC/布/纤维: perPairY phải có giá trị (số nhỏ kiểu 0.026-0.15), perPairSF thường null
- sfTarget LUÔN LỚN HƠN perPairY (sfTarget=0.48 > perPairY=0.044 ✓)
- Nếu cột SF/对 KHÔNG TỒN TẠI trong bảng → perPairSF = null cho tất cả các hàng

Cột nào trống/gạch ngang/dấu '-' → null.
ĐỌC SỐ CẨN THẬN: 0.026 ≠ 0.0264. Đọc đúng từng chữ số.

QUY TẮC chọn perPair:
- DA THẬT (牛皮,羊皮,猪皮,反绒,绒皮,马毛,羊京皮,nappa,suede,calf,leather): perPair=perPairSF, unit=SF
- PHI DA (PU,PVC,布,纤维,无纺,绒面革,lining): perPair=perPairY, unit=m2
- Fallback nếu cột ưu tiên null: dùng sfTarget, unit=SF
- Chỉ trả hàng có matName và perPair > 0.
JSON thuần, không backtick.`;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRY = new Set([429, 500, 502, 503, 504]);

function stripAndParse(raw, label) {
  const clean = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try { return JSON.parse(clean); }
  catch (e) {
    // Thử recover JSON bị truncate: tìm vị trí object hợp lệ cuối cùng
    console.warn(`${label} JSON parse failed (${e.message}), trying recovery...`);
    try {
      // Tìm vị trí "}" cuối cùng có thể đóng được object
      // Thử cắt dần từ cuối cho đến khi parse được
      let attempt = clean;
      // Đóng các string/array/object còn hở
      const opens = { '{': '}', '[': ']' };
      const stack = [];
      let inStr = false, escape = false;
      for (const ch of attempt) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"' && !escape) { inStr = !inStr; continue; }
        if (!inStr) {
          if (ch === '{' || ch === '[') stack.push(opens[ch]);
          else if (ch === '}' || ch === ']') stack.pop();
        }
      }
      // Đóng stack còn lại
      if (inStr) attempt += '"';
      while (stack.length) attempt += stack.pop();
      return JSON.parse(attempt);
    } catch (e2) {
      console.error(`${label} raw (first 1200):`, raw.slice(0, 1200));
      throw new Error(`${label} JSON không hợp lệ: ${e.message}`);
    }
  }
}

async function fetchWithRetry(url, opts, label) {
  for (let i = 1; i <= 4; i++) {
    let resp;
    try { resp = await fetch(url, opts); }
    catch (e) {
      if (i < 4) { await sleep(2000 * i); continue; }
      throw new Error(`Không kết nối ${label}: ` + e.message);
    }
    if (resp.ok) return resp;
    if (resp.status === 429 && label === 'Gemini') {
      const err = new Error('GEMINI_QUOTA'); err.quota = true; throw err;
    }
    if (RETRY.has(resp.status) && i < 4) { await sleep(2000 * i); continue; }
    const txt = await resp.text().catch(() => '');
    throw new Error(`${label} lỗi ${resp.status}: ${txt.slice(0, 200)}`);
  }
  throw new Error(`${label} quá tải sau 4 lần thử.`);
}

// ── Gemini: 1 call, 2 PDF gộp ─────────────────────────────────────────────────
async function callGemini(apiKey, poPdfB64, bomPdfB64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'application/pdf', data: poPdfB64 } },
      { inline_data: { mime_type: 'application/pdf', data: bomPdfB64 } },
      { text: PROMPT_COMBINED }
    ]}],
    generationConfig: { temperature: 0.1, maxOutputTokens: 16000, responseMimeType: 'application/json' }
  };
  const resp = await fetchWithRetry(url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    'Gemini');
  let data;
  try { data = await resp.json(); } catch { throw new Error('Gemini body không phải JSON'); }
  const raw = data?.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';
  if (!raw) throw new Error('Gemini: ' + (data?.candidates?.[0]?.finishReason || 'response rỗng'));
  return raw;
}

// ── Mistral single call helper ────────────────────────────────────────────────
async function mistralCall(apiKey, pdfB64OrPages, promptText, label) {
  const url = 'https://api.mistral.ai/v1/chat/completions';

  // Nếu nhận mảng ảnh (pages) → gửi từng ảnh riêng, tốt hơn cho multi-page scan PDF
  // Nếu nhận PDF b64 → gửi document_url như cũ
  let contentParts;
  if (Array.isArray(pdfB64OrPages)) {
    // Gửi từng trang như image_url — Pixtral đọc được toàn bộ không bị cắt
    contentParts = pdfB64OrPages.map(imgB64 => ({
      type: 'image_url',
      image_url: `data:image/jpeg;base64,${imgB64}`
    }));
    contentParts.push({ type: 'text', text: promptText });
  } else {
    contentParts = [
      { type: 'document_url', document_url: `data:application/pdf;base64,${pdfB64OrPages}` },
      { type: 'text', text: promptText }
    ];
  }

  const body = {
    model: MISTRAL_MODEL,
    temperature: 0.1,
    max_tokens: label.startsWith('PO') ? 6000 : 4096,
    messages: [{ role: 'user', content: contentParts }]
  };
  const resp = await fetchWithRetry(url,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }, body: JSON.stringify(body) },
    `Mistral(${label})`);
  let data;
  try { data = await resp.json(); } catch { throw new Error(`Mistral(${label}) body không phải JSON`); }
  const raw = data?.choices?.[0]?.message?.content || '';
  if (!raw) throw new Error(`Mistral(${label}) trả về nội dung rỗng.`);
  return raw;
}

// ── Mistral: 2 call song song — PO riêng, BOM riêng ──────────────────────────
async function callMistral(apiKey, poPdfB64, bomPdfB64, poPages, bomPages) {
  // pages = mảng PNG base64 từng trang (từ pdf.js client-side)
  // Nếu có → gửi ảnh, nếu không → fallback gửi PDF
  const poInput  = (poPages  && poPages.length  > 0) ? poPages  : poPdfB64;
  const bomInput = (bomPages && bomPages.length > 0) ? bomPages : bomPdfB64;
  console.log(`Mistral PO: ${Array.isArray(poInput) ? poInput.length + ' pages' : 'PDF'} | BOM: ${Array.isArray(bomInput) ? bomInput.length + ' pages' : 'PDF'}`);

  // Gọi song song để tiết kiệm thời gian
  const [poRaw, bomRaw] = await Promise.all([
    mistralCall(apiKey, poInput,  PROMPT_PO,  'PO'),
    mistralCall(apiKey, bomInput, PROMPT_BOM, 'BOM')
  ]);
  let po  = stripAndParse(poRaw,  'Mistral-PO');
  const bom = stripAndParse(bomRaw, 'Mistral-BOM');

  // ── Validate & cross-check qty với totalQ ───────────────────────────────────
  const colors = Array.isArray(po.colors) ? po.colors : [];
  const zeroCount = colors.filter(c => !c.qty || c.qty === 0).length;
  const totalColors = colors.length;
  const sumQty = colors.reduce((s, c) => s + (parseInt(c.qty) || 0), 0);
  const headerTotal = parseInt(po.totalQ) || 0;

  console.log(`Mistral-PO: ${totalColors} màu, sum=${sumQty}, headerTotal=${headerTotal}, zeros=${zeroCount}`);

  // Case 1: quá nhiều qty=0 → retry
  const needsRetry = (totalColors > 0 && zeroCount / totalColors > 0.4);
  // Case 2: tổng inflate quá nhiều so với header (>20%) → retry
  const isInflated = headerTotal > 0 && sumQty > headerTotal * 1.2;

  if (needsRetry || isInflated) {
    const reason = isInflated
      ? `sum ${sumQty} > headerTotal ${headerTotal} * 1.2`
      : `${zeroCount}/${totalColors} zeros`;
    console.log(`Mistral-PO: ${reason} → retry`);

    const retryRaw = await mistralCall(apiKey, poInput, PROMPT_PO_RETRY, 'PO-retry');
    const poRetry = stripAndParse(retryRaw, 'Mistral-PO-retry');
    const retryColors = Array.isArray(poRetry.colors) ? poRetry.colors : [];
    const retrySum = retryColors.reduce((s, c) => s + (parseInt(c.qty) || 0), 0);
    const retryZero = retryColors.filter(c => !c.qty || c.qty === 0).length;
    const retryInflated = headerTotal > 0 && retrySum > headerTotal * 1.2;

    // Dùng retry nếu tốt hơn: ít inflate hơn HOẶC ít zero hơn
    const retryBetter = retryColors.length > 0 &&
      (!retryInflated || retrySum < sumQty) &&
      retryZero <= zeroCount;
    if (retryBetter) {
      console.log(`Retry tốt hơn: sum=${retrySum}, zeros=${retryZero}`);
      po = poRetry;
    }
  }

  // Gộp thành cùng format với Gemini
  return JSON.stringify({ po, bom });
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

  let poPdfB64, bomPdfB64, provider, poPages, bomPages;
  try {
    ({ poPdfB64, bomPdfB64, provider = 'auto', poPages = null, bomPages = null } = req.body);
    if (!poPdfB64 || !bomPdfB64) throw new Error('Thiếu poPdfB64 hoặc bomPdfB64');
  } catch (e) {
    return res.status(400).json({ error: 'Request body không hợp lệ: ' + e.message });
  }

  if (provider === 'gemini'  && !GEMINI_KEY)  return res.status(500).json({ error: 'GEMINI_API_KEY chưa cấu hình.' });
  if (provider === 'mistral' && !MISTRAL_KEY) return res.status(500).json({ error: 'MISTRAL_API_KEY chưa cấu hình.' });
  if (provider === 'auto' && !GEMINI_KEY && !MISTRAL_KEY) return res.status(500).json({ error: 'Cần cấu hình ít nhất 1 API key.' });

  let rawText, usedProvider;
  try {
    if (provider === 'gemini') {
      rawText = await callGemini(GEMINI_KEY, poPdfB64, bomPdfB64);
      usedProvider = 'gemini';
    } else if (provider === 'mistral') {
      rawText = await callMistral(MISTRAL_KEY, poPdfB64, bomPdfB64, poPages, bomPages);
      usedProvider = 'mistral';
    } else {
      // auto: Gemini trước, fallback Mistral khi quota hết
      if (GEMINI_KEY) {
        try {
          rawText = await callGemini(GEMINI_KEY, poPdfB64, bomPdfB64);
          usedProvider = 'gemini';
        } catch (e) {
          if (e.quota && MISTRAL_KEY) {
            console.log('Gemini quota → fallback Mistral');
            rawText = await callMistral(MISTRAL_KEY, poPdfB64, bomPdfB64, poPages, bomPages);
            usedProvider = 'mistral';
          } else throw e;
        }
      } else {
        rawText = await callMistral(MISTRAL_KEY, poPdfB64, bomPdfB64, poPages, bomPages);
        usedProvider = 'mistral';
      }
    }
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  let parsed;
  try { parsed = stripAndParse(rawText, usedProvider); }
  catch (e) { return res.status(422).json({ error: e.message, raw: rawText.slice(0, 300) }); }

  // Normalize structure
  if (!parsed.po && !parsed.bom) {
    const nested = parsed.data || parsed.result || parsed.output || Object.values(parsed)[0];
    if (nested && (nested.po || nested.bom)) parsed = nested;
  }
  // Mistral trả po flat (không bọc trong {po:...}) → wrap lại
  if (!parsed.po && parsed.colors) parsed = { po: parsed, bom: { mats: [] } };
  if (!parsed.bom && parsed.mats)  parsed = { po: parsed.po || {}, bom: { mats: parsed.mats } };

  if (!parsed.po  || typeof parsed.po  !== 'object') parsed.po  = {};
  if (!parsed.bom || typeof parsed.bom !== 'object') parsed.bom = {};
  if (!Array.isArray(parsed.po.colors))  parsed.po.colors  = [];
  if (!Array.isArray(parsed.bom.mats))   parsed.bom.mats   = [];

  return res.status(200).json({ ...parsed, _provider: usedProvider });
}
