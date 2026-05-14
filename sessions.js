import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { toDataURL } from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/var/data/sessions';
const sessions = new Map();

// Тихий логгер чтобы не засорять Render logs
const logger = pino({ level: 'silent' });

export function startSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  const tenants = fs.readdirSync(SESSIONS_DIR).filter(f => {
    const full = path.join(SESSIONS_DIR, f);
    return fs.statSync(full).isDirectory();
  });
  for (const tenantId of tenants) {
    console.log(`Starting session for tenant: ${tenantId}`);
    createSession(tenantId);
  }
  console.log(`Loaded ${sessions.size} sessions`);

  // Если ни одной сессии нет — создаём default чтобы был QR
  if (sessions.size === 0) {
    console.log('No sessions found, creating default session for QR pairing');
    createSession('default');
  }
}

async function createSession(tenantId) {
  const sessionDir = path.join(SESSIONS_DIR, tenantId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  // ВАЖНО: запрашиваем актуальную версию протокола WhatsApp
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[${tenantId}] Using WA version ${version.join('.')}, isLatest: ${isLatest}`);

  const proxyUrl = process.env.PROXY_URL;
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    agent: agent,
    logger: logger,
    // ВАЖНО: представляемся как Chrome для корректного pairing
    browser: Browsers.macOS('Chrome'),
    // Синхронизировать историю не нужно — экономим память
    syncFullHistory: false,
    // Помечать сообщения как прочитанные не нужно
    markOnlineOnConnect: false,
    // Таймауты
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  });

  let currentQR = null;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      console.log(`[${tenantId}] QR code received, length: ${qr.length}`);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : (lastDisconnect?.error?.output?.statusCode || 0);

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[${tenantId}] Connection closed. Code: ${statusCode}, reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        // Увеличенная задержка чтобы не банило за частые попытки
        setTimeout(() => createSession(tenantId), 10000);
      } else {
        console.log(`[${tenantId}] Logged out, removing session`);
        sessions.delete(tenantId);
        try {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) {
          console.error(`Error removing session dir:`, e.message);
        }
      }
    } else if (connection === 'open') {
      console.log(`[${tenantId}] ✅ Connected successfully`);
      currentQR = null;
    } else if (connection === 'connecting') {
      console.log(`[${tenantId}] Connecting...`);
    }
  });

  sessions.set(tenantId, { sock, getQR: () => currentQR, dir: sessionDir });
}

export async function getSession(tenantId) {
  if (sessions.has(tenantId)) {
    return sessions.get(tenantId).sock;
  }
  await createSession(tenantId);
  await new Promise(resolve => setTimeout(resolve, 2000));
  return sessions.get(tenantId)?.sock || null;
}

export async function getSessionStatus(tenantId) {
  if (!sessions.has(tenantId)) {
    const sessionDir = path.join(SESSIONS_DIR, tenantId);
    if (fs.existsSync(sessionDir)) {
      await createSession(tenantId);
    } else {
      return { connected: false, hasSession: false };
    }
  }
  const session = sessions.get(tenantId);
  return {
    connected: session?.sock?.user !== undefined && session?.sock?.user !== null,
    hasSession: true,
    user: session?.sock?.user?.id || null,
  };
}

export async function getQR(tenantId) {
  if (!sessions.has(tenantId)) {
    await createSession(tenantId);
    // Ждём чтобы QR успел сгенерироваться
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  const session = sessions.get(tenantId);
  if (!session) return null;
  const qr = session.getQR();
  if (!qr) return null;
  return await toDataURL(qr);
}

export async function logoutSession(tenantId) {
  const session = sessions.get(tenantId);
  if (session) {
    try {
      await session.sock.logout();
    } catch (e) {
      console.error(`Logout error for ${tenantId}:`, e.message);
    }
    sessions.delete(tenantId);
    try {
      fs.rmSync(session.dir, { recursive: true, force: true });
    } catch (e) {
      console.error(`Error removing session dir:`, e.message);
    }
  }
}
