// api/parse.js  —  Vercel Serverless Function
// Nhận 2 PDF base64 từ frontend → gọi Gemini → trả JSON

export const config = { maxDuration: 60 };

const GEMINI_MODEL = 'gemini-2.5-flash';

const PROMPT = `Đây là 2 tài liệu sản xuất giày (tiếng Trung):
- Document 1: Đơn sản xuất (生产单) — bảng màu sắc và vật liệu
- Document 2: Bảng dùng liệu chính (主面料用量表) — tiêu hao nguyên liệu

Hãy trích xuất dữ liệu và trả về DUY NHẤT một JSON object. Không giải thích, không markdown.

{
  "po": {
    "orderNo": "factory order no (厂单号/厂单编号)",
    "model":   "model code (型体号码)",
    "style":   "style name (款名)",
    "cust":    "customer (客户)",
    "season":  "season (季节)",
    "totalQ":  total_quantity_integer,
    "colors": [
      { "id": "row NO. e.g. '1'", "code": "full COLOR/SKU cell text",
        "qty": integer_from_合计_column, "qtyMissing": false }
    ]
  },
  "bom": {
    "orderNo": "factory order no if present",
    "model":   "model code if present",
    "mats": [
      {
        "cfg":      "config codes e.g. '1' or '1+2+3'",
        "part":     "part name in Chinese only (部位)",
        "matName":  "material name in Chinese only — do NOT include English. E.g. '斯普伦多牛皮/SPLENDOR CALF' → '斯普伦多牛皮'",
        "engName":  "English material name only, extracted from after '/' in the material cell. E.g. '斯普伦多牛皮/SPLENDOR CALF' → 'SPLENDOR CALF'. Empty string if none.",
        "color":    "color in Chinese only. E.g. '黑色/BLACK' → '黑色', '自然色/黑色' → '自然色/黑色'",
        "engColor": "English color only, extracted from after '/' in color cell. E.g. '黑色/BLACK' → 'BLACK', '浅奶黄色/LIGHT CREAM' → 'LIGHT CREAM'. If multiple colors '自然色/黑色' → 'NATURAL/BLACK'. Empty string if none.",
        "spec":     "thickness/spec e.g. '1.3-1.5MM'",
        "perPair":  consumption_number,
        "unit":     "SF or m2 or yd",
        "note":     "notes if any"
      }
    ]
  }
}

Quy tắc:
- qty trong colors: đọc từ cột 合计 (cột cuối cùng), là số nguyên 3-6 chữ số.
  Nếu không đọc được thì qty:0, qtyMissing:true
- cfg trong mats: nếu 1 hàng rowspan nhiều hàng thì lặp lại cfg đó
- perPair: ưu tiên SF/对 > m²/对 > yd/对 > 目标用量SF
- matName và engName: tách rõ phần tiếng Trung và tiếng Anh tại dấu '/'
- color và engColor: tách rõ tương tự — tiếng Trung vào color, tiếng Anh vào engColor
- Chỉ trả hàng có matName và perPair > 0
- Trả về JSON thuần, không có \`\`\``;

export default async function handler(req, res) {
  // ── CORS headers ──────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // ── Validate API key ───────────────────────────────────────────────────────
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY chưa được cấu hình trong Vercel env vars.' });
  }

  // ── Parse request body ─────────────────────────────────────────────────────
  let poPdfB64, bomPdfB64;
  try {
    ({ poPdfB64, bomPdfB64 } = req.body);
    if (!poPdfB64 || !bomPdfB64) throw new Error('Thiếu poPdfB64 hoặc bomPdfB64');
  } catch (e) {
    return res.status(400).json({ error: 'Request body không hợp lệ: ' + e.message });
  }

  // ── Call Gemini API ────────────────────────────────────────────────────────
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const geminiBody = {
    contents: [{
      parts: [
        {
          inline_data: {
            mime_type: 'application/pdf',
            data: poPdfB64
          }
        },
        {
          inline_data: {
            mime_type: 'application/pdf',
            data: bomPdfB64
          }
        },
        { text: PROMPT }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json'
    }
  };

  // ── Retry với exponential backoff (503/429/500 retry tối đa 4 lần) ──────────
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_TRIES = 4;
  let geminiResp, lastErr;

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      geminiResp = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      });
    } catch (e) {
      lastErr = e.message;
      if (attempt < MAX_TRIES) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      return res.status(502).json({ error: 'Không kết nối được Gemini API: ' + e.message });
    }

    if (geminiResp.ok) break;

    if (RETRYABLE.has(geminiResp.status) && attempt < MAX_TRIES) {
      const wait = 2000 * attempt; // 2s, 4s, 6s
      console.log(`Gemini ${geminiResp.status} — retry ${attempt}/${MAX_TRIES - 1} sau ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    // Lỗi không retry được (400, 401, 403, 422...)
    const errText = await geminiResp.text();
    return res.status(geminiResp.status).json({
      error: `Gemini API lỗi ${geminiResp.status}: ${errText.slice(0, 300)}`
    });
  }

  if (!geminiResp || !geminiResp.ok) {
    const errText = geminiResp ? await geminiResp.text() : lastErr;
    return res.status(503).json({
      error: `Gemini quá tải sau ${MAX_TRIES} lần thử. Vui lòng thử lại sau ít phút.`
    });
  }

  // ── Parse Gemini HTTP response (guard against non-JSON body) ─────────────────
  let geminiData;
  try {
    geminiData = await geminiResp.json();
  } catch (e) {
    const txt = await geminiResp.text().catch(() => '(unreadable)');
    return res.status(502).json({ error: `Gemini trả về body không phải JSON: ${txt.slice(0, 200)}` });
  }

  // ── Extract text from Gemini response ──────────────────────────────────────
  const rawText = geminiData?.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';

  if (!rawText) {
    // Surface Gemini-level error if present
    const gemErr = geminiData?.error?.message || geminiData?.candidates?.[0]?.finishReason || 'response rỗng';
    return res.status(502).json({ error: `Gemini: ${gemErr}. Kiểm tra lại file PDF.` });
  }

  // ── Parse JSON (strip markdown fences nếu có) ──────────────────────────────
  const clean = rawText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error('Raw Gemini response:', rawText.slice(0, 1000));
    return res.status(422).json({
      error: `Gemini trả về JSON không hợp lệ: ${e.message}. Thử lại hoặc kiểm tra file PDF.`,
      raw: rawText.slice(0, 300)
    });
  }

  return res.status(200).json(parsed);
}
