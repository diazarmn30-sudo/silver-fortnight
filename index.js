'use strict';

/**
 * index.js (FULL)
 * - Koyeb safe: keepalive + health server + block process.exit(0)
 * - /cekbio bisa:
 *    A) /cekbio 628xx 62xx ...
 *    B) Reply file .txt lalu ketik: /cekbio
 *    C) Kirim file .txt + caption: /cekbio
 * - (opsional) /cekbiotxt tetap ada (alias lama)
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
// BOOT DEBUG + SIGNAL LOG
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
// BLOCK process.exit(0)
// =======================
const _exit = process.exit.bind(process);
process.exit = (code = 0) => {
  console.log('[BLOCK_EXIT] process.exit(', code, ') blocked');
  if (process.env.ALLOW_EXIT === '1') return _exit(code);
};

// =======================
// HARD KEEPALIVE
// =======================
process.stdin.resume();
setInterval(() => console.log('[HB] alive', new Date().toISOString()), 15000);

// =======================
// HEALTH SERVER (WAJIB)
// =======================
const PORT = Number(process.env.PORT || 8000);
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
}).listen(PORT, '0.0.0.0', () => {
  console.log('[HEALTH] listening on', PORT);
});

// =======================
// ENV OVERRIDE (ENV > config)
// =======================
const BOT_TOKEN = String(process.env.BOT_TOKEN || config.telegramBotToken || '').trim();
const OWNER_ID = Number(process.env.OWNER_ID || config.ownerId || 0);

const DATA_DIR = process.env.DATA_DIR || '.';
const SESSION_NAME = String(process.env.SESSION_NAME || config.sessionName || 'session').trim();

if (!BOT_TOKEN) {
  console.error('FATAL: BOT_TOKEN kosong. Set BOT_TOKEN di Koyeb env atau isi config.telegramBotToken.');
  _exit(1);
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
// PREMIUM STORAGE
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
// START WA
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
// HELPERS: parse numbers
// =======================
function extractNumbers(text) {
  return String(text || '').match(/\d{6,}/g) || []; // minimal 6 digit biar gak keambil angka kecil
}

async function getTxtNumbersFromTelegram(ctx, file_id) {
  const link = await ctx.telegram.getFileLink(file_id);
  const resp = await axios.get(link.href, { responseType: 'text' });
  return extractNumbers(resp.data);
}

// =======================
// BIO CHECK CORE
// =======================
async function handleBioCheck(ctx, numbersToCheck) {
  if (waConnectionStatus !== 'open' || !waClient) {
    return ctx.reply(
      config.message?.waNotConnected || 'WA belum nyambung. /pairing dulu lah.',
      { parse_mode: 'Markdown' }
    );
  }

  if (!numbersToCheck || numbersToCheck.length === 0) {
    return ctx.reply('Nomornya mana, bos? (kirim /cekbio 628xx... atau reply/upload .txt + /cekbio)');
  }

  await ctx.reply(`Otw bos! ... ngecek ${numbersToCheck.length} nomor.`);

  let withBio = [];
  let noBio = [];
  let notRegistered = [];

  const jids = numbersToCheck.map((num) => String(num).trim() + '@s.whatsapp.net');

  let existenceResults = [];
  try {
    existenceResults = await waClient.onWhatsApp(...jids);
  } catch (e) {
    console.log('[WA] onWhatsApp fail:', e?.message || e);
    return ctx.reply('Gagal cek registrasi WA, coba lagi ntar.');
  }

  const registeredJids = [];
  existenceResults.forEach((res) => {
    if (res?.exists) registeredJids.push(res.jid);
    else if (res?.jid) notRegistered.push(res.jid.split('@')[0]);
  });

  const registeredNumbers = registeredJids.map((jid) => jid.split('@')[0]);
  const batchSize = Number(config.settings?.cekBioBatchSize || 15);

  for (let i = 0; i < registeredNumbers.length; i += batchSize) {
    const batch = registeredNumbers.slice(i, i + batchSize);

    const promises = batch.map(async (nomor) => {
      const jid = nomor.trim() + '@s.whatsapp.net';
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

        if (bioText && String(bioText).trim() !== '') withBio.push({ nomor, bio: bioText, setAt: setAtText });
        else noBio.push(nomor);
      } catch {
        noBio.push(nomor.trim());
      }
    });

    await Promise.allSettled(promises);
    await sleep(800);
  }

  // output txt
  let fileContent = 'NIH bos HASIL CEK BIO SEMUA USER\n\n';
  fileContent += `✅ Total nomor dicek : ${numbersToCheck.length}\n`;
  fileContent += `📳 Dengan Bio       : ${withBio.length}\n`;
  fileContent += `📵 Tanpa Bio        : ${noBio.length}\n`;
  fileContent += `🚫 Tidak Terdaftar  : ${notRegistered.length}\n\n`;

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

  const outPath = `./hasil_cekbio_By_bos${ctx.from.id}.txt`;
  fs.writeFileSync(outPath, fileContent);

  await ctx.replyWithDocument({ source: outPath }, { caption: 'Nih hasilnya bos.' });
  try { fs.unlinkSync(outPath); } catch {}
}

// =======================
// TELEGRAM BOT
// =======================
console.log('Memulai bot...');
console.log('Thank you for using Yuzuki-baileys.');
console.log('Read apis api.kriszzyy.xyz');

const bot = new Telegraf(BOT_TOKEN);

const checkAccess = (level) => async (ctx, next) => {
  const userId = ctx.from?.id;

  if (level === 'owner' && userId !== OWNER_ID) {
    return ctx.reply(config.message?.owner || 'Khusus owner, bos!', { parse_mode: 'Markdown' });
  }

  if (level === 'premium') {
    const premiumUsers = getPremiumUsers();
    const isPremium = premiumUsers.includes(userId);
    if (userId !== OWNER_ID && !isPremium) {
      return ctx.reply(config.message?.premium || 'Khusus member premium, bos!', { parse_mode: 'Markdown' });
    }
  }

  return next();
};

bot.command('start', (ctx) => {
  const userName = ctx.from?.first_name || 'bos';
  const caption = `🕊 *(!) Holà ${userName}!*
━━━━━━━━━━━━━━━━━━━━━━━━
⬡ Prefix : /
⬡ Status : ON

😮‍💨 *FITUR UTAMA*
/cekbio <Nomor1> <Nomor2> ...
✅ Bisa juga:
- Reply file .txt lalu ketik: /cekbio
- Kirim file .txt + caption: /cekbio

🕊 *KHUSUS OWNER*
/pairing <Nomor>
/addakses <Id_User>
/delakses <Id_User>
/listallakses
━━━━━━━━━━━━━━━━━━━━━━━━`;

  if (config.photoStart) {
    return ctx.replyWithPhoto({ url: config.photoStart }, { caption, parse_mode: 'Markdown' });
  }
  return ctx.reply(caption, { parse_mode: 'Markdown' });
});

bot.command('pairing', checkAccess('owner'), async (ctx) => {
  const phoneNumber = ctx.message?.text?.split(' ')[1]?.replace(/[^0-9]/g, '');
  if (!phoneNumber) return ctx.reply('Format salah.\nContoh: /pairing 62812...');
  if (!waClient) return ctx.reply('Koneksi WA lagi down bos, sabar bentar.');

  try {
    await ctx.reply('Otw minta kode pairing bos...');
    const code = await waClient.requestPairingCode(phoneNumber);
    await ctx.reply(
      `📲 Nih kodenya bos: *${code}*\n\nMasukin di WA:\n*Tautkan Perangkat > Tautkan dengan nomor telepon*`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('Gagal pairing:', e);
    await ctx.reply('Gagal minta pairing code, bos. Coba lagi ntar.');
  }
});

/**
 * /cekbio:
 * - kalau ada angka di command -> pakai angka itu
 * - else kalau reply dokumen .txt -> ambil angka dari file itu
 * - else kalau message punya document .txt (upload + caption /cekbio) -> ambil angka dari file itu
 */
bot.command('cekbio', checkAccess('premium'), async (ctx) => {
  try {
    const text = ctx.message?.text || '';
    const inlineNums = extractNumbers(text);

    // 1) /cekbio 628xx ...
    if (inlineNums.length > 0) {
      return handleBioCheck(ctx, inlineNums);
    }

    // 2) Reply dokumen .txt + /cekbio
    const replied = ctx.message?.reply_to_message;
    if (replied?.document) {
      const doc = replied.document;
      if (doc.mime_type !== 'text/plain') return ctx.reply('Reply file .txt ya bos.');
      const nums = await getTxtNumbersFromTelegram(ctx, doc.file_id);
      return handleBioCheck(ctx, nums);
    }

    // 3) Upload file .txt + caption /cekbio
    if (ctx.message?.document) {
      const doc = ctx.message.document;
      if (doc.mime_type !== 'text/plain') return ctx.reply('Filenya harus .txt bos.');
      const nums = await getTxtNumbersFromTelegram(ctx, doc.file_id);
      return handleBioCheck(ctx, nums);
    }

    return ctx.reply('Kirim: /cekbio 628xx ... atau reply/upload file .txt + /cekbio');
  } catch (e) {
    console.log('[cekbio] error:', e?.message || e);
    return ctx.reply('Error pas proses /cekbio, coba lagi.');
  }
});

// Alias lama (biar kompatibel)
bot.command('cekbiotxt', checkAccess('premium'), async (ctx) => {
  const replied = ctx.message?.reply_to_message;
  if (!replied?.document) return ctx.reply('Reply file .txt nya dulu, bos.');

  const doc = replied.document;
  if (doc.mime_type !== 'text/plain') return ctx.reply('Filenya harus .txt.');

  try {
    const numbersToCheck = await getTxtNumbersFromTelegram(ctx, doc.file_id);
    await handleBioCheck(ctx, numbersToCheck);
  } catch (error) {
    console.error('Gagal proses file:', error);
    ctx.reply('Gagal ngambil nomor dari file, coba lagi.');
  }
});

bot.command(['addakses', 'delakses'], checkAccess('owner'), (ctx) => {
  const cmd = ctx.message?.text?.split(' ')[0].slice(1);
  const targetId = parseInt(ctx.message?.text?.split(' ')[1], 10);
  if (isNaN(targetId)) return ctx.reply('ID-nya angka, bos.');

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
  return ctx.reply(`✅ ID ${targetId} udah dicabut.`);
});

bot.command('listallakses', checkAccess('owner'), (ctx) => {
  const premiumUsers = getPremiumUsers();
  if (premiumUsers.length === 0) return ctx.reply('Belum ada member premium, bos.');

  let text = '*Nih daftar member premium:*\n';
  premiumUsers.forEach((id) => (text += `- ${id}\n`));
  return ctx.reply(text, { parse_mode: 'Markdown' });
});

// =======================
// STARTUP
// =======================
async function startAll() {
  await startWhatsAppClient();

  console.log('[TG] launching...');
  bot.launch()
    .then(() => console.log('[TG] launched OK'))
    .catch((e) => console.log('[TG] launch error:', e?.response?.description || e?.message || e));

  console.log('𝗗𝗛 𝗢𝗡 𝗕𝗔𝗭𝗭 𝗚𝗔𝗦𝗦 𝗖𝗘𝗞!!!');
  await new Promise(() => {});
}

startAll().catch((e) => {
  console.log('[FATAL]', e);
  _exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```0
