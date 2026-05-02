import express from 'express';
import { startSessions, getSessionStatus, getQR, logoutSession } from './sessions.js';

const app = express();
app.use(express.json());

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'dev-token-change-me';

function auth(req, res, next) {
  const token = req.headers['x-internal-token'];
  if (token !== INTERNAL_TOKEN) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Статус сессии
app.get('/session/:tenantId', auth, async (req, res) => {
  const status = await getSessionStatus(req.params.tenantId);
  res.json(status);
});

// Получить QR
app.get('/session/:tenantId/qr', auth, async (req, res) => {
  const qr = await getQR(req.params.tenantId);
  if (!qr) return res.json({ qr: null, message: 'Already connected or initializing' });
  res.json({ qr });
});

// Отправить сообщение
app.post('/send', auth, async (req, res) => {
  const { tenantId, phone, message } = req.body;
  if (!tenantId || !phone || !message) {
    return res.status(400).json({ error: 'tenantId, phone, message required' });
  }
  try {
    const { getSession } = await import('./sessions.js');
    const session = await getSession(tenantId);
    const jid = phone.includes('@s.whatsapp.net') ? phone : `${phone}@s.whatsapp.net`;
    await session.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Выйти из сессии
app.post('/session/:tenantId/logout', auth, async (req, res) => {
  await logoutSession(req.params.tenantId);
  res.json({ success: true });
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`WA Service running on port ${PORT}`);
  startSessions();
});