require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const origins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:5500,http://127.0.0.1:5500')
  .split(',').map(x => x.trim()).filter(Boolean);

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    // Requests without Origin are normally local health checks / command-line tools.
    if (!origin || origins.includes('*') || origins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin không được phép truy cập API.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '30kb' }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Bạn gửi yêu cầu quá nhanh. Vui lòng đợi một phút rồi thử lại.' }
}));

app.get('/', (_req, res) => res.json({ service: 'VietNong Connect AI API', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const SYSTEM_INSTRUCTION = `Bạn là Trợ lý AI của VietNong Connect, nền tảng demo kết nối nông dân, hợp tác xã, thương lái và người mua nông sản tại Việt Nam.
Hãy trả lời bằng tiếng Việt rõ ràng, lịch sự, thực tế và dễ hiểu. Có thể hướng dẫn cách sử dụng các mục của hệ thống như chợ nông sản, đăng sản phẩm, trang trại/vùng trồng, nhật ký canh tác, truy xuất nguồn gốc, đơn hàng và kết nối người mua.
Về nông nghiệp, hãy cung cấp thông tin tổng quát và khuyến nghị người dùng xác minh với cơ quan chuyên môn khi cần. Không bịa giá thị trường hiện tại, chứng nhận, nguồn gốc, tồn kho hoặc trạng thái đơn hàng. Bạn không được truy cập trực tiếp dữ liệu thời gian thực hay dữ liệu riêng trong website; hãy nói rõ điều này nếu được hỏi về một giao dịch cụ thể. Không khẳng định sản phẩm có OCOP/VietGAP nếu chưa có bằng chứng xác minh. Không đưa ra tư vấn pháp lý, y tế hoặc an toàn thực phẩm mang tính chắc chắn khi thiếu dữ kiện. Nếu không biết, hãy nói rõ và đề xuất cách kiểm tra.`;

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-12).filter(item => item && ['user', 'model'].includes(item.role) && typeof item.text === 'string')
    .map(item => ({ role: item.role, parts: [{ text: item.text.slice(0, 3000) }] }));
}

app.post('/api/chat', async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: 'Backend chưa được cấu hình GEMINI_API_KEY.' });
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'Vui lòng nhập câu hỏi.' });
  if (message.length > 2000) return res.status(413).json({ error: 'Câu hỏi quá dài. Vui lòng giới hạn 2.000 ký tự.' });

  const contents = cleanHistory(req.body.history);
  // Always end history with the current user message, even if the browser sends stale history.
  contents.push({ role: 'user', parts: [{ text: message }] });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(API_KEY)}`;
  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents,
        generationConfig: { temperature: 0.6, maxOutputTokens: 2048 }
      }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      console.error('Gemini API error:', upstream.status, data?.error?.message || 'unknown');
      if (upstream.status === 429) return res.status(429).json({ error: 'Dịch vụ AI đang bận hoặc đã chạm giới hạn sử dụng. Hãy thử lại sau.' });
      if (upstream.status === 400 || upstream.status === 403) return res.status(502).json({ error: 'Gemini từ chối yêu cầu. Hãy kiểm tra API key, quyền truy cập và tên model trong cấu hình backend.' });
      return res.status(502).json({ error: 'Dịch vụ AI tạm thời gặp lỗi. Vui lòng thử lại sau.' });
    }
    const reply = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    console.log('Gemini finishReason:', data.candidates?.[0]?.finishReason);
    if (!reply) return res.status(502).json({ error: 'Gemini không trả về câu trả lời. Vui lòng thử lại.' });
    return res.json({ reply });
  } catch (error) {
    console.error('Chat request failed:', error.name || error.message);
    return res.status(504).json({ error: 'Không kết nối được với AI trong thời gian cho phép. Vui lòng thử lại.' });
  }
});

app.use((err, _req, res, _next) => {
  if (err.message === 'Origin không được phép truy cập API.') return res.status(403).json({ error: err.message });
  if (err instanceof SyntaxError && 'body' in err) return res.status(400).json({ error: 'Nội dung JSON không hợp lệ.' });
  console.error('Server error:', err.message);
  return res.status(500).json({ error: 'Lỗi máy chủ.' });
});

app.listen(PORT, () => console.log(`VietNong Connect AI backend listening on port ${PORT}; model=${MODEL}`));
