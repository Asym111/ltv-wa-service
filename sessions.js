import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { toDataURL } from 'qrcode';
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/var/data/sessions';
const sessions = new Map();

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
}

async function createSession(tenantId) {
  const sessionDir = path.join(SESSIONS_DIR, tenantId);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const proxyUrl = process.env.PROXY_URL;
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    agent: agent,
  });

  let currentQR = null;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      currentQR = qr;
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`Connection closed for ${tenantId}, reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => createSession(tenantId), 5000);
      } else {
        sessions.delete(tenantId);
      }
    } else if (connection === 'open') {
      console.log(`Connected: ${tenantId}`);
      currentQR = null;
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
    connected: session?.sock?.user !== undefined,
    hasSession: true
  };
}

export async function getQR(tenantId) {
  if (!sessions.has(tenantId)) {
    await createSession(tenantId);
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
    fs.rmSync(session.dir, { recursive: true, force: true });
  }
}