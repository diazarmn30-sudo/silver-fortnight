'use strict';

/**
 * index.js - FIXED VERSION FOR KOYEB
 * Features:
 * - Auto-Fix Session (Delete session if 401/Logout)
 * - Koyeb Health Check Server (Port 8000)
 * - Telegraf + Baileys Integration
 * - Pairing Code Support
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const axios = require('axios');

const { Telegraf } = require('telegraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

// ==========================================
// CONFIG & ENVIRONMENT
// ==========================================
// Fallback config file jika ada
let config = {};
try { config = require('./config'); } catch { config = {}; }

// Environment Variables (Set di Koyeb)
const PORT = Number(process.env.PORT || 8000);
const BOT_TOKEN = String(process.env.BOT_TOKEN || config.telegramBotToken || '').trim();
const OWNER_ID = Number(process.env.OWNER_ID || config.ownerId || 0);

// Path Data
const DATA_DIR = String(process.env.DATA_DIR || '.').trim();
const SESSION_NAME = String(process.env.SESSION_NAME || config.sessionName || 'session').trim();
const AUTH_PATH = path.join(DATA_DIR, SESSION_NAME);
const PREMIUM_PATH = path.join(DATA_DIR, 'premium.json');

// Validasi Token
if (!BOT_TOKEN) {
  console.error('❌ FATAL: BOT_TOKEN is missing! Set it in Koyeb Env Vars.');
  process.exit(1);
}

// Helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); } catch {} };

// ==========================================
// 1. HEALTH SERVER (Koyeb Requirement)
// ==========================================
const requestListener = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Koyeb Service is Healthy');
};

const server = http.createServer(requestListener);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ [SERVER] Health Check running on port ${PORT}`);
});

// ==========================================
// 2. DATA MANAGEMENT (Premium Users)
// ==========================================
function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}

function writeJsonSafe(file, data) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) { console.error('[SAVE ERROR]', e.message); }
}

const getPremiumUsers = () => readJsonSafe(PREMIUM_PATH, []);
const savePremiumUsers = (users) => writeJsonSafe(PREMIUM_PATH, users);

// ==========================================
// 3. WHATSAPP LOGIC (With Auto-Fix)
// ==========================================
let waClient = null;
let waConnectionStatus = 'closed';

async function startWhatsAppClient() {
  console.log('[WA] Initializing...');
  ensureDir(AUTH_PATH);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

  waClient = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Ubuntu', 'Chrome', '20.0.04'], // Linux signature for stability
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 10000,
    syncFullHistory: false,
  });

  waClient.ev.on('creds.update', saveCreds);

  waClient.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection) {
        waConnectionStatus = connection;
        console.log(`[WA] Status Update: ${connection}`);
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error;
      const statusCode = new Boom(error)?.output?.statusCode;
      
      console.log(`[WA] Disconnected. Code: ${statusCode}`);

      // DETEKSI LOGOUT / SESI RUSAK (401)
      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.error('❌ [WA] Session Invalid/Logged Out. Menghapus sesi lama...');
        
        try {
            // Hapus folder session
            if (fs.existsSync(AUTH_PATH)) {
                fs.rmSync(AUTH_PATH, { recursive: true, force: true });
                console.log('✅ [WA] Folder sesi berhasil dihapus.');
            }
        } catch (e) {
            console.error('⚠️ [WA] Gagal hapus sesi:', e.message);
        }

        // Restart fresh
        console.log('🔄 [WA] Restarting client for new pairing...');
        waClient = null;
        setTimeout(startWhatsAppClient, 3000); 

      } else {
        // Disconnect biasa, reconnect
        console.log('🔄 [WA] Reconnecting...');
        setTimeout(startWhatsAppClient, 5000);
      }
      
    } else if (connection === 'open') {
      console.log('✅ [WA] Connected & Ready!');
    }
  });
}

// ==========================================
// 4. TELEGRAM BOT LOGIC
// ==========================================
const bot = new Telegraf(BOT_TOKEN);

// --- Helpers ---
function extractNumbers(text) { return String(text || '').match(/\d{6,}/g) || []; }
function escapeMd(text) { return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }

// --- Middleware ---
const checkAccess = (level) => async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();

  if (level === 'owner' && userId !== OWNER_ID) {
    return ctx.reply('🚫 Akses ditolak: Khusus Owner.');
  }
  if (level === 'premium') {
    const premiums = getPremiumUsers();
    if (userId !== OWNER_ID && !premiums.includes(userId)) {
      return ctx.reply('💎 Fitur Premium. Hubungi Owner untuk akses.');
    }
  }
  return next();
};

// --- Commands ---

bot.start((ctx) => {
  const name = escapeMd(ctx.from.first_name);
  ctx.reply(
    `👋 *Halo ${name}*\n\n` +
    `Bot Cek Bio WhatsApp Massal.\n` +
    `Status Server: *Online (Koyeb)*\n\n` +
    `*Commands:*\n` +
    `1. \`/cekbio <nomor>\` - Cek manual\n` +
    `2. Reply file .txt dgn \`/cekbio\` - Cek massal\n` +
    `3. \`/pairing <nomor>\` - (Owner) Login WA\n`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('pairing', checkAccess('owner'), async (ctx) => {
  if (!waClient) return ctx.reply('⚠️ WA Client sedang restart, tunggu sebentar...');
  
  const text = ctx.message.text.split(' ')[1];
  if (!text) return ctx.reply('Format: /pairing 628xxxxxxxx');
  const phoneNumber = text.replace(/[^0-9]/g, '');

  try {
    ctx.reply('⏳ Meminta kode pairing...');
    const code = await waClient.requestPairingCode(phoneNumber);
    ctx.reply(`📲 Kode Pairing Kamu:\n\`${code}\`\n\n_Masukkan di WhatsApp > Perangkat Tertaut_`, { parse_mode: 'Markdown' });
  } catch (e) {
    ctx.reply(`❌ Gagal request pairing: ${e.message}`);
  }
});

bot.command(['addakses', 'delakses'], checkAccess('owner'), (ctx) => {
  const cmd = ctx.message.text.split(' ')[0].replace('/', '');
  const targetId = parseInt(ctx.message.text.split(' ')[1]);
  if (!targetId || isNaN(targetId)) return ctx.reply('Format: /addakses <ID Telegram>');

  let users = getPremiumUsers();
  if (cmd === 'addakses') {
    if (!users.includes(targetId)) users.push(targetId);
    savePremiumUsers(users);
    ctx.reply(`✅ ID ${targetId} jadi Premium.`);
  } else {
    users = users.filter(id => id !== targetId);
    savePremiumUsers(users);
    ctx.reply(`✅ ID ${targetId} dihapus dari Premium.`);
  }
});

// --- Logic Cek Bio ---
async function handleBioCheck(ctx, numbers) {
  if (waConnectionStatus !== 'open') return ctx.reply('⚠️ WhatsApp belum connect. Owner harus /pairing dulu.');

  const statusMsg = await ctx.reply(`⏳ Memproses ${numbers.length} nomor...`);
  const uniqueNums = [...new Set(numbers)];
  
  const results = { bio: [], noBio: [], notReg: [] };
  
  // Update log helper
  const updateLog = async (text) => {
    try { await ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, text); } catch {}
  };

  await updateLog(`🔍 Checking registration (${uniqueNums.length} nums)...`);

  // Batch Processing (Biar Ram Koyeb Aman)
  const BATCH_SIZE = 15;
  for (let i = 0; i < uniqueNums.length; i += BATCH_SIZE) {
    const batch = uniqueNums.slice(i, i + BATCH_SIZE);
    
    await Promise.all(batch.map(async (num) => {
      const jid = num + '@s.whatsapp.net';
      try {
        // 1. Cek Exists
        const exists = await waClient.onWhatsApp(jid);
        if (!exists || !exists[0]?.exists) {
          results.notReg.push(num);
          return;
        }
        // 2. Fetch Status
        const status = await waClient.fetchStatus(jid);
        const bio = status?.status || status?.status?.text;
        
        if (bio) results.bio.push(`${num} => ${bio}`);
        else results.noBio.push(num);
      } catch {
        // Error biasanya karena privasi / tidak ada bio
        results.noBio.push(num);
      }
    }));

    if (i % 30 === 0) {
      await updateLog(`🔄 Progress: ${Math.min(i + BATCH_SIZE, uniqueNums.length)}/${uniqueNums.length}\n✅ Found Bio: ${results.bio.length}`);
    }
    await sleep(500); // Jeda antar batch
  }

  // Generate Report File
  const reportContent = 
    `RESULT CEK BIO\n` +
    `Total Check: ${uniqueNums.length}\n` +
    `✅ With Bio: ${results.bio.length}\n` +
    `📵 No Bio/Priv: ${results.noBio.length}\n` +
    `🚫 Not Reg: ${results.notReg.length}\n\n` +
    `--- DATA BIO ---\n${results.bio.join('\n')}\n\n` +
    `--- NO BIO ---\n${results.noBio.join('\n')}\n\n` +
    `--- NOT REG ---\n${results.notReg.join('\n')}`;

  const filename = `Result_${Date.now()}.txt`;
  fs.writeFileSync(filename, reportContent);

  await ctx.replyWithDocument({ source: filename }, { caption: '✅ Done bos.' });
  try { fs.unlinkSync(filename); } catch {}
}

const cekBioHandler = async (ctx) => {
  let text = ctx.message.text || '';
  
  // Support Reply File
  if (ctx.message.reply_to_message?.document) {
    const link = await ctx.telegram.getFileLink(ctx.message.reply_to_message.document.file_id);
    const res = await axios.get(link.href, { responseType: 'text' });
    text += ' ' + res.data;
  }
  // Support Upload File
  if (ctx.message.document) {
     const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
     const res = await axios.get(link.href, { responseType: 'text' });
     text += ' ' + res.data;
  }

  const nums = extractNumbers(text);
  if (nums.length === 0) return ctx.reply('⚠️ Mana nomornya? Kirim text atau file txt.');
  
  return handleBioCheck(ctx, nums);
};

bot.command('cekbio', checkAccess('premium'), cekBioHandler);

// ==========================================
// 5. MAIN STARTUP
// ==========================================
async function main() {
  // A. Start WA
  await startWhatsAppClient();

  // B. Start Telegram
  console.log('[TG] Starting Telegraf...');
  try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch {}
  
  bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('✅ [TG] Bot Launched!'))
    .catch((err) => {
        console.error('❌ [TG] Launch Failed:', err);
        process.exit(1); 
    });

  // C. Signal Handling (Graceful Shutdown)
  const shutdown = (signal) => {
    console.log(`[STOP] ${signal} received.`);
    bot.stop(signal);
    if (waClient) waClient.end(undefined);
    server.close();
    process.exit(0);
  };
  
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main();
