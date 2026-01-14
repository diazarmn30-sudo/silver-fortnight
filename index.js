'use strict';

/**
 * index.js (FIXED & OPTIMIZED FOR KOYEB)
 * - Improved Health Check Handling
 * - Fixed Startup Logic (No more silent fails)
 * - Robust Error Handling
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

// Config Fallback (Buat jaga-jaga kalau file config ga ada)
let config = {};
try { config = require('./config'); } catch { config = {}; }

// =======================
// ENV & CONSTANTS
// =======================
// Default port 8000. Pastikan di Koyeb Settings -> Instance -> Port diisi 8000
const PORT = Number(process.env.PORT || 8000); 
const BOT_TOKEN = String(process.env.BOT_TOKEN || config.telegramBotToken || '').trim();
const OWNER_ID = Number(process.env.OWNER_ID || config.ownerId || 0);

const DATA_DIR = String(process.env.DATA_DIR || '.').trim();
const SESSION_NAME = String(process.env.SESSION_NAME || config.sessionName || 'session').trim();

// =======================
// LOGGING & SYSTEM CHECK
// =======================
console.log('[BOOT] Starting Application...');
console.log(`[BOOT] NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`[BOOT] PORT: ${PORT}`);

// Cek Token
if (!BOT_TOKEN) {
  console.error('❌ FATAL: BOT_TOKEN kosong! Set di Environment Variable Koyeb.');
  process.exit(1); // Exit 1 biar Koyeb tau ini error
}

// Helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); } catch {} };

// =======================
// HEALTH SERVER (PENTING UNTUK KOYEB)
// =======================
// Server ini harus jalan duluan biar Koyeb Health Check lulus
const requestListener = (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Koyeb Health Check: OK');
};

const server = http.createServer(requestListener);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ [SERVER] HTTP Health Server running on port ${PORT}`);
});

// Keepalive log agar log tidak sepi (opsional)
setInterval(() => {
  const memUsage = process.memoryUsage().rss / 1024 / 1024;
  console.log(`[HEARTBEAT] Alive - Mem: ${memUsage.toFixed(2)} MB`);
}, 60000); // Tiap 1 menit saja biar ga spam

// =======================
// DATA STORAGE
// =======================
const premiumPath = path.join(DATA_DIR, 'premium.json');

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJsonSafe(file, data) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log('[WRITE_FAIL]', file, e?.message);
  }
}

const getPremiumUsers = () => readJsonSafe(premiumPath, []);
const savePremiumUsers = (users) => writeJsonSafe(premiumPath, users);

// =======================
// WA CONNECTION LOGIC
// =======================
let waClient = null;
let waConnectionStatus = 'closed';

async function startWhatsAppClient() {
  console.log('[WA] Connecting...');
  
  const authPath = path.join(DATA_DIR, SESSION_NAME);
  ensureDir(authPath);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  waClient = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false, // Kita pakai pairing code
    auth: state,
    browser: ['Ubuntu', 'Chrome', '20.0.04'], // Browser signature linux biar lebih stabil
    connectTimeoutMs: 60000, 
  });

  waClient.ev.on('creds.update', saveCreds);

  waClient.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection) waConnectionStatus = connection;

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[WA] Connection closed. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(startWhatsAppClient, 5000);
      } else {
        console.log('❌ [WA] Logged out / Session invalid. Silakan pairing ulang.');
        waClient = null;
      }
    } else if (connection === 'open') {
      console.log('✅ [WA] Connected successfully!');
    }
  });
}

// =======================
// TELEGRAM BOT LOGIC
// =======================
const bot = new Telegraf(BOT_TOKEN);

// Helpers
function extractNumbers(text) {
  return String(text || '').match(/\d{6,}/g) || [];
}
function fmt(n) {
  return Number(n || 0).toLocaleString('id-ID');
}
function escapeMd(text) {
  return String(text || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Middleware Akses
const checkAccess = (level) => async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();

  if (level === 'owner' && userId !== OWNER_ID) {
    return ctx.reply('🚫 Khusus owner bos!');
  }
  if (level === 'premium') {
    const premiumUsers = getPremiumUsers();
    if (userId !== OWNER_ID && !premiumUsers.includes(userId)) {
      return ctx.reply('💎 Fitur Premium. Hubungi owner untuk akses.');
    }
  }
  return next();
};

// --- Bot Commands ---

bot.start((ctx) => {
  const name = escapeMd(ctx.from.first_name);
  ctx.reply(
    `🤖 *Halo ${name}*\n\n` +
    `Gunakan bot ini untuk cek bio WhatsApp massal.\n\n` +
    `*Cara Pakai:*\n` +
    `1. Kirim \`/cekbio 62812xxx 62813xxx\`\n` +
    `2. Reply file .txt dengan \`/cekbio\`\n` +
    `3. Upload file .txt dengan caption \`/cekbio\`\n\n` +
    `_Server: Running on Koyeb_`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('pairing', checkAccess('owner'), async (ctx) => {
  if (!waClient) return ctx.reply('⚠️ Client WA belum siap/error.');
  
  const phoneNumber = ctx.message.text.split(' ')[1];
  if (!phoneNumber) return ctx.reply('Format: /pairing 628xxx');

  try {
    ctx.reply('⏳ Requesting pairing code...');
    const code = await waClient.requestPairingCode(phoneNumber.replace(/[^0-9]/g, ''));
    ctx.reply(`📲 Kode Pairing:\n\`${code}\``, { parse_mode: 'Markdown' });
  } catch (e) {
    ctx.reply(`❌ Gagal: ${e.message}`);
  }
});

bot.command(['addakses', 'delakses'], checkAccess('owner'), (ctx) => {
  const cmd = ctx.message.text.split(' ')[0].replace('/', '');
  const targetId = parseInt(ctx.message.text.split(' ')[1]);

  if (!targetId || isNaN(targetId)) return ctx.reply('Format: /addakses <ID>');
  
  let users = getPremiumUsers();
  
  if (cmd === 'addakses') {
    if (!users.includes(targetId)) users.push(targetId);
    savePremiumUsers(users);
    ctx.reply(`✅ ID ${targetId} added to Premium.`);
  } else {
    users = users.filter(id => id !== targetId);
    savePremiumUsers(users);
    ctx.reply(`✅ ID ${targetId} removed from Premium.`);
  }
});

// --- Cek Bio Logic ---
async function handleBioCheck(ctx, numbers) {
  if (waConnectionStatus !== 'open') return ctx.reply('⚠️ WA belum connect. Hubungi admin.');
  
  const statusMsg = await ctx.reply(`⏳ Memproses ${numbers.length} nomor...`);
  
  const results = {
    bio: [],
    noBio: [],
    notReg: []
  };

  // Cek Registrasi (Batching 50)
  const uniqueNums = [...new Set(numbers)];
  
  // Progress update helper
  const updateLog = async (text) => {
    try { await ctx.telegram.editMessageText(statusMsg.chat.id, statusMsg.message_id, undefined, text); } catch {}
  };

  await updateLog(`🔍 Checking registration (${uniqueNums.length})...`);

  // Proses Cek Bio (Sequential Batch biar aman)
  // Kita batasi batch processing biar memori aman di Koyeb
  const BATCH_SIZE = 10; 
  
  for (let i = 0; i < uniqueNums.length; i += BATCH_SIZE) {
    const chunk = uniqueNums.slice(i, i + BATCH_SIZE);
    
    await Promise.all(chunk.map(async (num) => {
      const jid = num + '@s.whatsapp.net';
      try {
        // Cek exists dulu
        const exists = await waClient.onWhatsApp(jid);
        if (!exists || !exists[0]?.exists) {
          results.notReg.push(num);
          return;
        }

        // Fetch Bio
        const status = await waClient.fetchStatus(jid);
        const bio = status?.status || status?.status?.text; // Handling struktur beda2

        if (bio) {
          results.bio.push(`${num} => ${bio}`);
        } else {
          results.noBio.push(num);
        }
      } catch (e) {
        // Anggap no bio / privasi kalau error fetch status tapi exists
        results.noBio.push(num); 
      }
    }));

    // Update progress tiap batch
    if (i % 20 === 0) {
      await updateLog(`🔄 Progress: ${i + chunk.length}/${uniqueNums.length}\n✅ Bio: ${results.bio.length}`);
    }
    await sleep(50); // Cooling down
  }

  // Generate File
  const report = 
    `RESULT CEK BIO\n` +
    `Total: ${uniqueNums.length}\n` +
    `Ada Bio: ${results.bio.length}\n` +
    `No Bio/Priv: ${results.noBio.length}\n` +
    `Not Reg: ${results.notReg.length}\n\n` +
    `=== WITH BIO ===\n${results.bio.join('\n')}\n\n` +
    `=== NO BIO ===\n${results.noBio.join('\n')}\n\n` +
    `=== NOT REG ===\n${results.notReg.join('\n')}`;

  const filename = `result_${Date.now()}.txt`;
  fs.writeFileSync(filename, report);

  await ctx.replyWithDocument({ source: filename, filename: 'Result_CekBio.txt' }, { caption: '✅ Selesai bos.' });
  fs.unlinkSync(filename);
}

// Handle Command Cekbio
const cekBioHandler = async (ctx) => {
  let text = ctx.message.text || '';
  
  // Handle file reply
  if (ctx.message.reply_to_message?.document) {
    const link = await ctx.telegram.getFileLink(ctx.message.reply_to_message.document.file_id);
    const res = await axios.get(link.href, { responseType: 'text' });
    text += ' ' + res.data;
  }
  // Handle direct file upload
  if (ctx.message.document) {
     const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
     const res = await axios.get(link.href, { responseType: 'text' });
     text += ' ' + res.data;
  }

  const nums = extractNumbers(text);
  if (nums.length === 0) return ctx.reply('Mana nomornya/filenya?');
  
  return handleBioCheck(ctx, nums);
};

bot.command('cekbio', checkAccess('premium'), cekBioHandler);

// =======================
// STARTUP SEQUENCE
// =======================
async function main() {
  try {
    // 1. Start WA
    await startWhatsAppClient();

    // 2. Start Telegram
    console.log('[TG] Launching Bot...');
    
    // Hapus webhook lama kalau ada sisa biar ga conflict polling
    try { await bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch {}

    // Jalankan bot (awaiting launch)
    bot.launch({ dropPendingUpdates: true })
      .then(() => {
        console.log('✅ [TG] Bot Started Successfully!');
      })
      .catch((err) => {
        console.error('❌ [TG] Failed to launch:', err);
        process.exit(1); // Force restart if TG fails
      });

    // Handle Graceful Shutdown
    const stopSignal = (signal) => {
      console.log(`[STOP] Received ${signal}. Shutting down...`);
      bot.stop(signal);
      if (waClient) waClient.end(undefined);
      server.close();
      process.exit(0);
    };

    process.once('SIGINT', () => stopSignal('SIGINT'));
    process.once('SIGTERM', () => stopSignal('SIGTERM'));

  } catch (error) {
    console.error('❌ [MAIN] Startup Error:', error);
    process.exit(1); // Exit 1 triggers Restart in Koyeb
  }
}

main();
