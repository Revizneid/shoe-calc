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
const PROMPT_PO = `Đây là đơn sản xuất giày (生产单), có thể nhiều trang. Nhiệm vụ DUY NHẤT: đọc số lượng từng màu từ TẤT CẢ các trang.

Trả về DUY NHẤT JSON sau. Không giải thích, không markdown, không backtick.

{
  "orderNo": "factory order no (厂单号/厂单编号)",
  "model":   "model code (型体号码)",
  "style":   "style name (款名)",
  "cust":    "customer (客户)",
  "season":  "season (季节)",
  "totalQ":  number_from_订单总数_field,
  "colors": [
    { "id": "1", "code": "COLOR NAME/SKU đầy đủ", "qty": 3565, "qtyMissing": false }
  ]
}

═══ CẤU TRÚC BẢNG MÀU ═══

Bảng màu có dạng:
| NO. | COLOR/C CODE/SK | phần phối A单 | B单 | C单 | D单 | E单 | F单 | G单 | H单 | I单 | J单 | K单 | L单 | M单 | N单 | 合计 |

Mỗi hàng = 1 màu. Cột 合计 là cột SỐ CUỐI CÙNG bên phải — đó là TỔNG số đôi của màu đó.

VÍ DỤ THỰC TẾ từ loại đơn này:
  Hàng 1: NAVY/40W/...    → các cột phân phối: 140, 110, 20, 3565, 24, 98, 802, 651, 70, 166, 260, 400, 304, 100  → 合计 = 3565  ← LẤY SỐ NÀY
  Hàng 2: BLACK/36W/...   → các cột phân phối: 0, 0, 0, 802, ...                                                  → 合计 = 802   ← LẤY SỐ NÀY  (KHÔNG phải 651)
  Hàng 3: KONIJ/15W/...   → ...                                                                                    → 合计 = 260   ← LẤY SỐ NÀY
  Hàng 4: GRAVES/ANTI/... → ...                                                                                    → 合计 = 1306  ← LẤY SỐ NÀY
  Hàng 5: LIGGAGE/Z30/... → ...                                                                                    → 合计 = 929   ← LẤY SỐ NÀY
  Hàng 6: BLACK/MIL/...   → ...                                                                                    → 合计 = 694   ← LẤY SỐ NÀY
  Hàng 7: LIGGAGE/Z30/... → ...                                                                                    → 合计 = 634   ← LẤY SỐ NÀY

NGUYÊN TẮC BẮT BUỘC:
1. 合计 = cột CUỐI CÙNG bên phải của bảng → đó là qty đúng duy nhất.
2. TUYỆT ĐỐI KHÔNG cộng tay A单+B单+... và KHÔNG lấy giá trị từ bất kỳ cột nào khác ngoài 合计.
3. Đọc TẤT CẢ trang trong file, không bỏ sót màu nào ở trang 2, 3...
4. Nếu ô 合计 không đọc được → qty:0, qtyMissing:true. Không tự bịa số.
5. id = số thứ tự (1, 2, 3...), code = toàn bộ text trong ô COLOR CODE.
6. Kết quả: tổng qty tất cả màu phải bằng (hoặc gần bằng) trường 订单总数/总计 trong header.
JSON thuần, không backtick.`;

// ── Prompt retry PO — tiếp cận khác khi lần 1 thất bại ─────────────────────────
const PROMPT_PO_RETRY = `Đây là đơn sản xuất giày (生产单) nhiều trang.

NHIỆM VỤ: Tìm bảng có cột header "合计" (tổng cộng). Đọc từng hàng dữ liệu, ghi lại giá trị trong ô cột 合计.

CÁCH LÀM:
- Tìm dòng header của bảng màu: thường chứa chữ "NO." hoặc số thứ tự, "COLOR" hoặc màu sắc, và "合计" ở cuối.
- Với mỗi hàng dữ liệu bên dưới header đó: đọc (1) số thứ tự/NO, (2) tên màu/SKU, (3) số trong cột 合计.
- Đọc TẤT CẢ trang — bảng có thể tiếp tục sang trang 2.
- 合计 = số lớn nhất trong hàng đó, thường 3-4 chữ số (100-9999).

Trả về JSON, không markdown, không backtick:
{
  "orderNo": "厂单号",
  "model": "型体号码",
  "style": "款名",
  "cust": "客户",
  "season": "季节",
  "totalQ": number_from_订单总数,
  "colors": [
    { "id": "1", "code": "tên màu/SKU", "qty": số_từ_cột_合计, "qtyMissing": false }
  ]
}
Nếu không đọc được ô 合计 của 1 màu: qty:0, qtyMissing:true. JSON thuần.`;

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

QUY TẮC cột (bảng có 3 cột số liệu):
- 目标用量SF (hoặc 目标用量) → sfTarget
- SF/对 (hoặc 单一用量 SF/对) → perPairSF  
- Y/对 (hoặc 单一用量 Y/对) → perPairY
Cột nào trống/gạch ngang → null.

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
    console.error(`${label} raw:`, raw.slice(0, 800));
    throw new Error(`${label} JSON không hợp lệ: ${e.message}`);
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
    generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
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
async function mistralCall(apiKey, pdfB64, promptText, label) {
  const url = 'https://api.mistral.ai/v1/chat/completions';
  const body = {
    model: MISTRAL_MODEL,
    temperature: 0.1,
    max_tokens: label === 'PO' ? 6000 : 4096,
    messages: [{ role: 'user', content: [
      { type: 'document_url', document_url: `data:application/pdf;base64,${pdfB64}` },
      { type: 'text', text: promptText }
    ]}]
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
async function callMistral(apiKey, poPdfB64, bomPdfB64) {
  // Gọi song song để tiết kiệm thời gian
  const [poRaw, bomRaw] = await Promise.all([
    mistralCall(apiKey, poPdfB64, PROMPT_PO,  'PO'),
    mistralCall(apiKey, bomPdfB64, PROMPT_BOM, 'BOM')
  ]);
  let po  = stripAndParse(poRaw,  'Mistral-PO');
  const bom = stripAndParse(bomRaw, 'Mistral-BOM');

  // ── Validate qty: nếu >50% màu có qty=0 → retry PO với prompt cứng hơn ────
  const colors = Array.isArray(po.colors) ? po.colors : [];
  const zeroCount = colors.filter(c => !c.qty || c.qty === 0).length;
  const totalColors = colors.length;

  if (totalColors > 0 && zeroCount / totalColors > 0.4) {
    console.log(`Mistral-PO: ${zeroCount}/${totalColors} màu qty=0 → retry với PROMPT_PO_RETRY`);
    const retryRaw = await mistralCall(apiKey, poPdfB64, PROMPT_PO_RETRY, 'PO-retry');
    const poRetry = stripAndParse(retryRaw, 'Mistral-PO-retry');
    // Dùng kết quả retry nếu tốt hơn
    const retryColors = Array.isArray(poRetry.colors) ? poRetry.colors : [];
    const retryZero = retryColors.filter(c => !c.qty || c.qty === 0).length;
    if (retryColors.length >= totalColors && retryZero < zeroCount) {
      console.log(`Retry tốt hơn: ${retryZero}/${retryColors.length} zeros vs ${zeroCount}/${totalColors}`);
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

  let poPdfB64, bomPdfB64, provider;
  try {
    ({ poPdfB64, bomPdfB64, provider = 'auto' } = req.body);
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
      rawText = await callMistral(MISTRAL_KEY, poPdfB64, bomPdfB64);
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
            rawText = await callMistral(MISTRAL_KEY, poPdfB64, bomPdfB64);
            usedProvider = 'mistral';
          } else throw e;
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
