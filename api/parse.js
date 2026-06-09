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
      { "cfg":     "config codes e.g. '1' or '1+2+3'",
        "part":    "part name Chinese (部位)",
        "matName": "material name Chinese",
        "engName": "English material name if present in cell (after '/')",
        "color":   "color(s), '/' between multiple",
        "spec":    "thickness/spec e.g. '1.3-1.5MM'",
        "perPair": consumption_number,
        "unit":    "SF or m² or yd",
        "note":    "notes if any" }
    ]
  }
}

Quy tắc:
- qty trong colors: đọc từ cột 合计 (cột cuối cùng), là số nguyên 3-6 chữ số.
  Nếu không đọc được thì qty:0, qtyMissing:true
- cfg trong mats: nếu 1 hàng rowspan nhiều hàng thì lặp lại cfg đó
- perPair: ưu tiên SF/对 > m²/对 > yd/对 > 目标用量SF
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

  let geminiResp;
  try {
    geminiResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody)
    });
  } catch (e) {
    return res.status(502).json({ error: 'Không kết nối được Gemini API: ' + e.message });
  }

  if (!geminiResp.ok) {
    const errText = await geminiResp.text();
    return res.status(geminiResp.status).json({
      error: `Gemini API lỗi ${geminiResp.status}: ${errText.slice(0, 300)}`
    });
  }

  const geminiData = await geminiResp.json();

  // ── Extract text from Gemini response ──────────────────────────────────────
  const rawText = geminiData?.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';

  if (!rawText) {
    return res.status(502).json({ error: 'Gemini trả về response rỗng. Kiểm tra lại file PDF.' });
  }

  // ── Parse JSON (strip markdown fences nếu có) ──────────────────────────────
  const clean = rawText.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    console.error('Raw Gemini response:', rawText);
    return res.status(422).json({
      error: `Gemini trả về JSON không hợp lệ: ${e.message}`,
      raw: rawText.slice(0, 500)
    });
  }

  return res.status(200).json(parsed);
}
