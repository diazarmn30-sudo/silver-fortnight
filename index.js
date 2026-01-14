'use strict';

/**
 * index.js (FULL)
 * - Koyeb worker safe (health server + keepalive)
 * - Baileys session persistent via DATA_DIR (/data) + SESSION_NAME
 * - /cekbio support:
 *    1) /cekbio 628xx 62xx...
 *    2) reply .txt + /cekbio
 *    3) upload .txt with caption /cekbio
 * - Realtime progress output:
 *    - message "progress" di Telegram akan di-edit berkala (sedang batch ke berapa, found bio, no bio, not registered)
 *    - rate-limit biar ga spam edit
 * - Telegraf polling: dropPendingUpdates + graceful shutdown
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

const config = require('./config');

// =======================
// LOG / SIGNAL
// =======================
console.log('[BOOT] file:', __filename);
console.log('[BOOT] cwd :', process.cwd());
try { console.log('[BOOT] ls  :', fs.readdirSync('.').slice(0, 50)); } catch {}

process.on('SIGTERM', () => console.log('[SIGNAL] SIGTERM received (platform stopping container)'));
process.on('SIGINT', () => console.log('[SIGNAL] SIGINT received'));
process.on('uncaughtException', (e) => console.log('[UNCAUGHT]', e));
process.on('unhandledRejection', (e) => console.log('[UNHANDLED]', e));
process.on('exit', (code) => console.log('[EXIT] code =', code));

// =======================
// KEEPALIVE
// =======================
process.stdin.resume();
setInterval(() => console.log('[HB] alive', new Date().toISOString()), 15000);

// =======================
// HEALTH SERVER (wajib di Koyeb biar dianggap "alive")
// =======================
const PORT = Number(process.env.PORT || 8000);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
}).listen(PORT, '0.0.0.0', () => {
  console.log('[HEALTH] listening on', PORT);
});

// =======================
// ENV (ENV > config)
// =======================
const BOT_TOKEN = String(process.env.BOT_TOKEN || config.telegramBotToken || '').trim();
const OWNER_ID = Number(process.env.OWNER_ID || config.ownerId || 0);

// kalau pakai Volume di Koyeb: mount path /data lalu set DATA_DIR=/data
const DATA_DIR = String(process.env.DATA_DIR || '.').trim();
const SESSION_NAME = String(process.env.SESSION_NAME || config.sessionName || 'session').trim();

if (!BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN kosong. Set BOT_TOKEN di Koyeb env atau isi config.telegramBotToken.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); } catch {} };

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
    console.log('[WRITE_FAIL]', file, e?.message || e);
  }
}

// =======================
// PREMIUM STORAGE (persistent kalau DATA_DIR ke /data)
// =======================
const premiumPath = path.join(DATA_DIR, 'premium.json');
const getPremiumUsers = () => readJsonSafe(premiumPath, []);
const savePremiumUsers = (users) => writeJsonSafe(premiumPath, users);

// =======================
// WA GLOBALS
// =======================
let waClient = null;
let waConnectionStatus = 'closed';

// =======================
// START WA (Baileys)
// =======================
async function startWhatsAppClient() {
  console.log('Mencoba memulai koneksi WhatsApp...');

  const authPath = path.join(DATA_DIR, SESSION_NAME);
  ensureDir(authPath);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  waClient = makeWASocket({
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Mac OS', 'Safari', '10.15.7'],
  });

  waClient.ev.on('creds.update', saveCreds);

  waClient.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection) waConnectionStatus = connection;

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        'Koneksi WhatsApp tertutup:',
        new Boom(lastDisconnect?.error).message,
        '|| reconnect:',
        shouldReconnect
      );

      if (shouldReconnect) setTimeout(() => startWhatsAppClient().catch(console.log), 5000);
      else {
        console.log('WA logged out. Pairing ulang diperlukan.');
        waClient = null;
      }
    } else if (connection === 'open') {
      console.log('Berhasil tersambung ke WhatsApp!');
    }
  });
}

// =======================
// HELPERS
// =======================
function extractNumbers(text) {
  // ambil digit >= 6 biar ga nyangkut "2026" doang
  return String(text || '').match(/\d{6,}/g) || [];
}

async function getTxtNumbersFromTelegram(ctx, file_id) {
  const link = await ctx.telegram.getFileLink(file_id);
  const resp = await axios.get(link.href, { responseType: 'text' });
  return extractNumbers(resp.data);
}

function fmt(n) {
  return Number(n || 0).toLocaleString('id-ID');
}

function escapeMd(text) {
  // minimal escape Markdown untuk safe editMessageText
  return String(text || '')
    .replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// =======================
// PROGRESS EDIT (real-time output)
// =======================
async function createProgress(ctx, total) {
  const msg = await ctx.reply(
    `🧾 *CekBio started*\n` +
    `Total input: *${fmt(total)}*\n` +
    `Status: _menyiapkan..._`,
    { parse_mode: 'Markdown' }
  );

  return {
    chatId: msg.chat.id,
    messageId: msg.message_id,
    lastEditAt: 0,
    lastText: '',
    ended: false,
  };
}

async function updateProgress(ctx, p, text, force = false) {
  if (!p || p.ended) return;

  const now = Date.now();
  // edit max 1x tiap 2.5 detik biar ga rate-limit
  if (!force && (now - p.lastEditAt) < 2500) return;
  if (!force && text === p.lastText) return;

  p.lastEditAt = now;
  p.lastText = text;

  try {
    await ctx.telegram.editMessageText(
      p.chatId,
      p.messageId,
      undefined,
      text,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    // kalau edit gagal (misal message terlalu lama / rate limit), yaudah skip
    console.log('[PROGRESS] edit fail:', e?.response?.description || e?.message || e);
  }
}

async function endProgress(ctx, p, text) {
  if (!p) return;
  p.ended = true;
  await updateProgress(ctx, p, text, true);
}

// =======================
// BIO CHECK CORE (dengan realtime output)
// =======================
async function handleBioCheck(ctx, numbersToCheck) {
  if (waConnectionStatus !== 'open' || !waClient) {
    return ctx.reply(config.message?.waNotConnected || '⚠️ WA belum nyambung. /pairing dulu.', { parse_mode: 'Markdown' });
  }
  if (!numbersToCheck || numbersToCheck.length === 0) {
    return ctx.reply('Nomornya mana, bos? (reply/upload .txt + /cekbio juga bisa)');
  }

  const total = numbersToCheck.length;
  const p = await createProgress(ctx, total);

  let withBio = [];
  let noBio = [];
  let notRegistered = [];

  // cleanup dupes
  const uniqueNums = Array.from(new Set(numbersToCheck.map((x) => String(x).trim()).filter(Boolean)));

  await updateProgress(
    ctx, p,
    `🧾 *CekBio started*\n` +
    `Total input: *${fmt(total)}*\n` +
    `Unique: *${fmt(uniqueNums.length)}*\n` +
    `Status: _cek registrasi WhatsApp..._`
  );

  const jids = uniqueNums.map((num) => num + '@s.whatsapp.net');

  let existenceResults = [];
  try {
    existenceResults = await waClient.onWhatsApp(...jids);
  } catch (e) {
    console.log('[WA] onWhatsApp fail:', e?.message || e);
    await endProgress(ctx, p, `❌ *Gagal*\nStatus: _cek registrasi WA error_`);
    return ctx.reply('Gagal cek registrasi WA, coba lagi ntar.');
  }

  const registeredJids = [];
  existenceResults.forEach((res) => {
    if (res?.exists) registeredJids.push(res.jid);
    else if (res?.jid) notRegistered.push(res.jid.split('@')[0]);
  });

  const registeredNumbers = registeredJids.map((jid) => jid.split('@')[0]);

  const batchSize = Math.max(1, Number(config.settings?.cekBioBatchSize || 15));
  const totalReg = registeredNumbers.length;

  await updateProgress(
    ctx, p,
    `🧾 *CekBio started*\n` +
    `Total input: *${fmt(total)}* | Unique: *${fmt(uniqueNums.length)}*\n` +
    `Terdaftar WA: *${fmt(totalReg)}* | Tidak terdaftar: *${fmt(notRegistered.length)}*\n` +
    `Status: _mulai fetch bio..._`
  );

  let processed = 0;
  let batchIndex = 0;
  const totalBatches = Math.ceil(totalReg / batchSize) || 1;

  for (let i = 0; i < registeredNumbers.length; i += batchSize) {
    batchIndex++;
    const batch = registeredNumbers.slice(i, i + batchSize);

    await updateProgress(
      ctx, p,
      `🧾 *CekBio running*\n` +
      `Batch: *${batchIndex}/${totalBatches}* (size ${batch.length})\n` +
      `Progress: *${fmt(processed)}/${fmt(totalReg)}*\n` +
      `✅ Bio: *${fmt(withBio.length)}* | 📵 NoBio: *${fmt(noBio.length)}* | 🚫 NotReg: *${fmt(notRegistered.length)}*\n` +
      `Status: _fetch bio batch ${batchIndex}..._`
    );

    const promises = batch.map(async (nomor) => {
      const jid = nomor + '@s.whatsapp.net';
      try {
        const statusResult = await waClient.fetchStatus(jid);
        const data = Array.isArray(statusResult) ? statusResult[0] : statusResult;

        let bioText = null;
        let setAtText = null;

        if (data) {
          if (typeof data.status === 'string') bioText = data.status;
          else if (typeof data.status === 'object' && data.status !== null)
            bioText = data.status.text || data.status.status;

          setAtText = data.setAt || (data.status && data.status.setAt) || null;
        }

        if (bioText && String(bioText).trim() !== '') {
          withBio.push({ nomor, bio: bioText, setAt: setAtText });
        } else {
          noBio.push(nomor);
        }
      } catch {
        noBio.push(nomor);
      } finally {
        processed++;
      }
    });

    await Promise.allSettled(promises);

    await updateProgress(
      ctx, p,
      `🧾 *CekBio running*\n` +
      `Batch: *${batchIndex}/${totalBatches}* selesai\n` +
      `Progress: *${fmt(processed)}/${fmt(totalReg)}*\n` +
      `✅ Bio: *${fmt(withBio.length)}* | 📵 NoBio: *${fmt(noBio.length)}* | 🚫 NotReg: *${fmt(notRegistered.length)}*\n` +
      `Status: _cooldown..._`
    );

    // delay kecil biar WA ga kebakar
    await sleep(50);
  }

  // =======================
  // OUTPUT FILE
  // =======================
  await updateProgress(
    ctx, p,
    `🧾 *CekBio finishing*\n` +
    `Progress: *${fmt(processed)}/${fmt(totalReg)}*\n` +
    `✅ Bio: *${fmt(withBio.length)}* | 📵 NoBio: *${fmt(noBio.length)}* | 🚫 NotReg: *${fmt(notRegistered.length)}*\n` +
    `Status: _buat file hasil..._`
  );

  let fileContent = 'NIH bos HASIL CEK BIO SEMUA USER\n\n';
  fileContent += `✅ Total input        : ${fmt(total)}\n`;
  fileContent += `🧠 Unique            : ${fmt(uniqueNums.length)}\n`;
  fileContent += `📳 Terdaftar WA      : ${fmt(totalReg)}\n`;
  fileContent += `🚫 Tidak terdaftar   : ${fmt(notRegistered.length)}\n`;
  fileContent += `✅ Dengan Bio        : ${fmt(withBio.length)}\n`;
  fileContent += `📵 Tanpa Bio/privasi : ${fmt(noBio.length)}\n\n`;

  fileContent += `----------------------------------------\n\n`;
  fileContent += `✅ NOMOR DENGAN BIO (${withBio.length})\n\n`;

  if (withBio.length > 0) {
    for (const item of withBio) {
      fileContent += `└─ 📅 ${item.nomor}\n   └─ 📝 "${item.bio}"\n      └─ ⏰ ${item.setAt || '-'}\n\n`;
    }
  } else {
    fileContent += `(Kosong)\n\n`;
  }

  fileContent += `----------------------------------------\n\n`;
  fileContent += `📵 NOMOR TANPA BIO / PRIVASI (${noBio.length})\n\n`;
  fileContent += noBio.length ? noBio.join('\n') + '\n' : '(Kosong)\n';

  fileContent += `\n----------------------------------------\n\n`;
  fileContent += `🚫 TIDAK TERDAFTAR WA (${notRegistered.length})\n\n`;
  fileContent += notRegistered.length ? notRegistered.join('\n') + '\n' : '(Kosong)\n';

  const outPath = `./hasil_cekbio_By_${ctx.from.id}.txt`;
  fs.writeFileSync(outPath, fileContent);

  await endProgress(
    ctx, p,
    `✅ *CekBio selesai*\n` +
    `Total input: *${fmt(total)}* | Unique: *${fmt(uniqueNums.length)}*\n` +
    `✅ Bio: *${fmt(withBio.length)}* | 📵 NoBio: *${fmt(noBio.length)}* | 🚫 NotReg: *${fmt(notRegistered.length)}*\n` +
    `Status: _mengirim file..._`
  );

  await ctx.replyWithDocument({ source: outPath }, { caption: 'Nih hasilnya bos.' });
  try { fs.unlinkSync(outPath); } catch {}
}

// =======================
// TELEGRAM BOT
// =======================
const bot = new Telegraf(BOT_TOKEN);

const checkAccess = (level) => async (ctx, next) => {
  const userId = ctx.from?.id;

  if (level === 'owner' && userId !== OWNER_ID) {
    return ctx.reply(config.message?.owner || '🚫 Khusus owner, bos!', { parse_mode: 'Markdown' });
  }

  if (level === 'premium') {
    const premiumUsers = getPremiumUsers();
    const isPremium = premiumUsers.includes(userId);
    if (userId !== OWNER_ID && !isPremium) {
      return ctx.reply(config.message?.premium || '💎 Khusus member premium, bos!', { parse_mode: 'Markdown' });
    }
  }

  return next();
};

bot.command('start', (ctx) => {
  const userName = ctx.from?.first_name || 'bos';
  const caption =
    `🕊 *Holà ${escapeMd(userName)}!*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `✅ /cekbio 628xx 62xx ...\n` +
    `✅ Reply file .txt + /cekbio\n` +
    `✅ Upload file .txt + caption /cekbio\n\n` +
    `Owner:\n` +
    `- /pairing 628xxxx\n` +
    `- /addakses <id>\n` +
    `- /delakses <id>\n` +
    `- /listallakses\n`;

  if (config.photoStart) return ctx.replyWithPhoto({ url: config.photoStart }, { caption, parse_mode: 'Markdown' });
  return ctx.reply(caption, { parse_mode: 'Markdown' });
});

bot.command('pairing', checkAccess('owner'), async (ctx) => {
  const phoneNumber = ctx.message?.text?.split(' ')[1]?.replace(/[^0-9]/g, '');
  if (!phoneNumber) return ctx.reply('Format: /pairing 62812...');
  if (!waClient) return ctx.reply('WA lagi down bos.');

  try {
    await ctx.reply('Otw minta pairing code...');
    const code = await waClient.requestPairingCode(phoneNumber);
    await ctx.reply(
      `📲 Kode: *${escapeMd(code)}*\nMasukin di WA: *Tautkan Perangkat > Tautkan dengan nomor telepon*`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.log('[pairing] fail:', e?.message || e);
    await ctx.reply('Gagal minta pairing code.');
  }
});

bot.command('cekbio', checkAccess('premium'), async (ctx) => {
  try {
    const text = ctx.message?.text || '';
    const inlineNums = extractNumbers(text);

    // 1) /cekbio 628xx 62xx
    if (inlineNums.length > 0) return handleBioCheck(ctx, inlineNums);

    // 2) reply .txt + /cekbio
    const replied = ctx.message?.reply_to_message;
    if (replied?.document) {
      const doc = replied.document;
      if (doc.mime_type !== 'text/plain') return ctx.reply('Reply file .txt ya bos.');
      const nums = await getTxtNumbersFromTelegram(ctx, doc.file_id);
      return handleBioCheck(ctx, nums);
    }

    // 3) upload .txt + caption /cekbio
    if (ctx.message?.document) {
      const doc = ctx.message.document;
      if (doc.mime_type !== 'text/plain') return ctx.reply('Filenya harus .txt bos.');
      const nums = await getTxtNumbersFromTelegram(ctx, doc.file_id);
      return handleBioCheck(ctx, nums);
    }

    return ctx.reply('Kirim: /cekbio 628xx... atau reply/upload file .txt + /cekbio');
  } catch (e) {
    console.log('[cekbio] error:', e?.message || e);
    return ctx.reply('Error pas proses /cekbio.');
  }
});

// alias lama (kalau mau tetap ada)
bot.command('cekbiotxt', checkAccess('premium'), async (ctx) => {
  const replied = ctx.message?.reply_to_message;
  if (!replied?.document) return ctx.reply('Reply file .txt dulu.');
  const doc = replied.document;
  if (doc.mime_type !== 'text/plain') return ctx.reply('Filenya harus .txt.');
  const nums = await getTxtNumbersFromTelegram(ctx, doc.file_id);
  return handleBioCheck(ctx, nums);
});

bot.command(['addakses', 'delakses'], checkAccess('owner'), (ctx) => {
  const cmd = ctx.message?.text?.split(' ')[0].slice(1);
  const targetId = parseInt(ctx.message?.text?.split(' ')[1], 10);
  if (isNaN(targetId)) return ctx.reply('ID harus angka.');

  let premiumUsers = getPremiumUsers();

  if (cmd === 'addakses') {
    if (premiumUsers.includes(targetId)) return ctx.reply(`ID ${targetId} udah premium.`);
    premiumUsers.push(targetId);
    savePremiumUsers(premiumUsers);
    return ctx.reply(`✅ ID ${targetId} sekarang premium.`);
  }

  if (!premiumUsers.includes(targetId)) return ctx.reply(`ID ${targetId} bukan premium.`);
  premiumUsers = premiumUsers.filter((id) => id !== targetId);
  savePremiumUsers(premiumUsers);
  return ctx.reply(`✅ ID ${targetId} dicabut.`);
});

bot.command('listallakses', checkAccess('owner'), (ctx) => {
  const premiumUsers = getPremiumUsers();
  if (premiumUsers.length === 0) return ctx.reply('Belum ada member premium.');
  return ctx.reply(`*Daftar premium:*\n${premiumUsers.map((x) => `- ${x}`).join('\n')}`, { parse_mode: 'Markdown' });
});

// =======================
// STARTUP
// =======================
async function startAll() {
  console.log('Memulai bot...');

  await startWhatsAppClient();

  console.log('[TG] launching...');
  bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('[TG] launched OK'))
    .catch((e) => console.log('[TG] launch error:', e?.response?.description || e?.message || e));

  console.log('RUNNING...');
  await new Promise(() => {}); // keep alive forever
}

startAll().catch((e) => {
  console.log('[FATAL]', e);
  process.exit(1);
});

// Stop bersih (biar polling berhenti sebelum instance baru start)
async function gracefulShutdown(sig) {
  console.log('[SHUTDOWN] start by', sig);
  try { bot.stop(sig); } catch {}
  try { waClient?.end?.(); } catch {}
  await sleep(800);
  console.log('[SHUTDOWN] done');
  process.exit(0);
}

process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.once('SIGINT', () => gracefulShutdown('SIGINT'));
