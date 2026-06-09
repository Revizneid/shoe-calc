# 🚀 Hướng dẫn Deploy Shoe Material Calculator lên Vercel

## Cấu trúc project
```
shoe-calc/
├── index.html        ← Tool chính (đã sửa, gọi /api/parse thay vì Anthropic)
├── api/
│   └── parse.js      ← Serverless Function: proxy giữa browser và Gemini
└── vercel.json       ← Config timeout 60s cho function
```

---

## Bước 1 — Lấy Gemini API Key (miễn phí)

1. Vào https://aistudio.google.com/app/apikey
2. Đăng nhập Google → nhấn **"Create API key"**
3. Copy key dạng `AIza...`

**Giới hạn free tier:**
- 1,500 request/ngày
- 1,000,000 token/ngày
- Đủ cho hàng trăm đơn/ngày

---

## Bước 2 — Upload lên GitHub

1. Tạo repo mới (private) tại https://github.com/new
2. Upload 3 files: `index.html`, `api/parse.js`, `vercel.json`
   - Hoặc dùng GitHub Desktop / git push

---

## Bước 3 — Deploy lên Vercel

1. Vào https://vercel.com → đăng nhập bằng GitHub
2. Nhấn **"Add New Project"** → chọn repo vừa tạo
3. Nhấn **"Deploy"** (không cần thay đổi gì)

---

## Bước 4 — Thêm Gemini API Key vào Vercel

> ⚠️ Bước này BẮT BUỘC — không có key tool không chạy được

1. Vào Vercel dashboard → chọn project → tab **"Settings"**
2. Menu trái → **"Environment Variables"**
3. Thêm:
   - **Name:** `GEMINI_API_KEY`
   - **Value:** `AIza...` (key vừa lấy ở Bước 1)
   - **Environment:** ✅ Production ✅ Preview ✅ Development
4. Nhấn **"Save"**
5. Vào tab **"Deployments"** → nhấn **"Redeploy"** (bắt buộc để env var có hiệu lực)

---

## Bước 5 — Sử dụng

Tool sẽ chạy tại URL dạng:
```
https://shoe-calc-xxxx.vercel.app
```

Chia sẻ link này cho cả team — ai cũng dùng được, không cần cài gì.

---

## Troubleshooting

| Lỗi | Nguyên nhân | Cách sửa |
|-----|-------------|----------|
| `GEMINI_API_KEY chưa được cấu hình` | Chưa thêm env var | Làm Bước 4 rồi Redeploy |
| `Gemini API lỗi 400` | File PDF bị lỗi hoặc quá nhỏ | Kiểm tra PDF có nội dung |
| `Gemini trả về JSON không hợp lệ` | PDF khó đọc | Thử lại, hoặc nhập tay |
| Timeout sau 60s | PDF quá phức tạp | Nén PDF nhỏ hơn trước khi upload |

---

## Cập nhật tool sau này

Chỉ cần sửa file trong GitHub → Vercel tự động redeploy trong ~30 giây.
