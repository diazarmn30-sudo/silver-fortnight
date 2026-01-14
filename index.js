'use strict';

// =======================
// BOOT DEBUG + ANTI EXIT
// =======================
const fs = require('fs');
console.log('[BOOT] file:', __filename);
console.log('[BOOT] cwd :', process.cwd());
try { console.log('[BOOT] ls  :', fs.readdirSync('.').slice(0, 25)); } catch {}

process.on("SIGTERM", () => console.log("[SIGNAL] SIGTERM received (platform stopping container)"));
process.on("SIGINT", () => console.log("[SIGNAL] SIGINT received"));
process.on("exit", (code) => console.log("[EXIT] code =", code));
process.on("uncaughtException", (e) => console.log("[UNCAUGHT]", e));
process.on("unhandledRejection", (e) => console.log("[UNHANDLED]", e));

// paling kebal nahan process
process.stdin.resume();
setInterval(() => console.log("[HB] alive", new Date().toISOString()), 15000);

console.log("Memulai bot...");
console.log("Thank you for using Yuzuki-baileys.");
console.log("Read apis api.kriszzyy.xyz");

const http = require("http");
const { Telegraf } = require("telegraf");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const axios = require("axios");
const path = require("path");

const config = require("./config");

// =======================
// HEALTH SERVER (AMAN DI KOYEB)
// =======================
const PORT = Number(process.env.PORT || 8000);
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
}).listen(PORT, "0.0.0.0", () => {
  console.log("[HEALTH] listening on", PORT);
});

// =======================
// TOKEN (ENV > config)
// =======================
const BOT_TOKEN = String(process.env.BOT_TOKEN || config.telegramBotToken || "").trim();
if (!BOT_TOKEN) {
  console.error("FATAL: BOT_TOKEN kosong. Set BOT_TOKEN di Koyeb Secrets atau isi config.telegramBotToken.");
  process.exit(1);
}

// =======================
// DATA DIR
// =======================
const DATA_DIR = process.env.DATA_DIR || ".";
const premiumPath = path.join(DATA_DIR, "premium.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (dir) => { try { fs.mkdirSync(dir, { recursive: true }); } catch {} };

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonSafe(file, data) {
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log("[WRITE_FAIL]", file, e?.message || e);
  }
}

const getPremiumUsers = () => readJsonSafe(premiumPath, []);
const savePremiumUsers = (users) => writeJsonSafe(premiumPath, users);

// =======================
// WHATSAPP
// =======================
let waClient = null;
let waConnectionStatus = "closed";

async function startWhatsAppClient() {
  console.log("Mencoba memulai koneksi WhatsApp...");

  const sessionName = process.env.SESSION_NAME || config.sessionName || "session";
  const authPath = path.join(DATA_DIR, sessionName);
  ensureDir(authPath);

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  waClient = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: ["Mac OS", "Safari", "10.15.7"],
  });

  waClient.ev.on("creds.update", saveCreds);

  waClient.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection) waConnectionStatus = connection;

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        "Koneksi WhatsApp tertutup:",
        new Boom(lastDisconnect?.error).message,
        "|| reconnect:",
        shouldReconnect
      );

      if (shouldReconnect) setTimeout(startWhatsAppClient, 5000);
      else {
        console.log("WA logged out. Pairing ulang diperlukan.");
        waClient = null;
      }
    } else if (connection === "open") {
      console.log("Berhasil tersambung ke WhatsApp!");
    }
  });
}

// =======================
// CEK BIO
// =======================
async function handleBioCheck(ctx, numbersToCheck) {
  if (waConnectionStatus !== "open") {
    return ctx.reply(config.message?.waNotConnected || "WA belum nyambung. /pairing dulu.", { parse_mode: "Markdown" });
  }
  if (!numbersToCheck || numbersToCheck.length === 0) return ctx.reply("Nomornya mana, bos?");

  await ctx.reply(`Otw bos! ... ngecek ${numbersToCheck.length} nomor.`);

  let withBio = [];
  let noBio = [];
  let notRegistered = [];

  const jids = numbersToCheck.map((num) => num.trim() + "@s.whatsapp.net");
  const existenceResults = await waClient.onWhatsApp(...jids);

  const registeredJids = [];
  existenceResults.forEach((res) => {
    if (res.exists) registeredJids.push(res.jid);
    else notRegistered.push(res.jid.split("@")[0]);
  });

  const registeredNumbers = registeredJids.map((jid) => jid.split("@")[0]);
  const batchSize = config.settings?.cekBioBatchSize || 15;

  for (let i = 0; i < registeredNumbers.length; i += batchSize) {
    const batch = registeredNumbers.slice(i, i + batchSize);

    const promises = batch.map(async (nomor) => {
      const jid = nomor.trim() + "@s.whatsapp.net";
      try {
        const statusResult = await waClient.fetchStatus(jid);
        const data = Array.isArray(statusResult) ? statusResult[0] : statusResult;

        let bioText = null;
        let setAtText = null;

        if (data) {
          if (typeof data.status === "string") bioText = data.status;
          else if (typeof data.status === "object" && data.status !== null)
            bioText = data.status.text || data.status.status;

          setAtText = data.setAt || (data.status && data.status.setAt) || null;
        }

        if (bioText && String(bioText).trim() !== "") withBio.push({ nomor, bio: bioText, setAt: setAtText });
        else noBio.push(nomor);
      } catch {
        noBio.push(nomor.trim());
      }
    });

    await Promise.allSettled(promises);
    await sleep(800);
  }

  let fileContent = "NIH bos HASIL CEK BIO SEMUA USER\n\n";
  fileContent += `✅ Total nomor dicek : ${numbersToCheck.length}\n`;
  fileContent += `📳 Dengan Bio       : ${withBio.length}\n`;
  fileContent += `📵 Tanpa Bio        : ${noBio.length}\n`;
  fileContent += `🚫 Tidak Terdaftar  : ${notRegistered.length}\n\n`;

  fileContent += `----------------------------------------\n\n`;
  fileContent += `✅ NOMOR DENGAN BIO (${withBio.length})\n\n`;

  if (withBio.length > 0) {
    for (const item of withBio) {
      fileContent += `└─ 📅 ${item.nomor}\n   └─ 📝 "${item.bio}"\n      └─ ⏰ ${item.setAt || "-"}\n\n`;
    }
  } else {
    fileContent += `(Kosong)\n\n`;
  }

  fileContent += `----------------------------------------\n\n`;
  fileContent += `📵 NOMOR TANPA BIO / PRIVASI (${noBio.length})\n\n`;
  fileContent += noBio.length ? noBio.join("\n") + "\n" : "(Kosong)\n";

  const filePath = `./hasil_cekbio_By_bos${ctx.from.id}.txt`;
  fs.writeFileSync(filePath, fileContent);
  await ctx.replyWithDocument({ source: filePath }, { caption: "Nih hasilnya bos." });
  fs.unlinkSync(filePath);
}

// =======================
// TELEGRAM BOT + COMMANDS
// =======================
const bot = new Telegraf(BOT_TOKEN);

const checkAccess = (level) => async (ctx, next) => {
  const userId = ctx.from?.id;

  if (level === "owner" && userId !== config.ownerId) {
    return ctx.reply(config.message?.owner || "Khusus owner.", { parse_mode: "Markdown" });
  }

  if (level === "premium") {
    const isPremium = getPremiumUsers().includes(userId);
    if (userId !== config.ownerId && !isPremium) {
      return ctx.reply(config.message?.premium || "Khusus premium.", { parse_mode: "Markdown" });
    }
  }

  await next();
};

bot.command("start", (ctx) => {
  const userName = ctx.from?.first_name || "bos";
  const premiumStatus = "ON";

  const caption = `🕊 *(!) Holà ${userName}!*
━━━━━━━━━━━━━━━━━━━━━━━━
⬡ Prefix : /
⬡ Status : ${premiumStatus}

😮‍💨 *FITUR UTAMA*
/cekbio <Nomor1> <Nomor2> ...
/cekbiotxt (Reply File .txt)

🕊 *KHUSUS OWNER*
/pairing <Nomor>
/addakses <Id_User>
/delakses <Id_User>
/listallakses
━━━━━━━━━━━━━━━━━━━━━━━━`;

  if (config.photoStart) {
    return ctx.replyWithPhoto({ url: config.photoStart }, { caption, parse_mode: "Markdown" });
  }
  return ctx.reply(caption, { parse_mode: "Markdown" });
});

bot.command("pairing", checkAccess("owner"), async (ctx) => {
  const phoneNumber = ctx.message?.text?.split(" ")[1]?.replace(/[^0-9]/g, "");
  if (!phoneNumber) return ctx.reply("Format salah.\nContoh: /pairing 62812...");
  if (!waClient) return ctx.reply("Koneksi WA lagi down bos, sabar bentar.");

  try {
    await ctx.reply("Otw minta kode pairing bos...");
    const code = await waClient.requestPairingCode(phoneNumber);
    await ctx.reply(
      `📲 Nih kodenya bos: *${code}*\n\nMasukin di WA:\n*Tautkan Perangkat > Tautkan dengan nomor telepon*`,
      { parse_mode: "Markdown" }
    );
  } catch (e) {
    console.error("Gagal pairing:", e);
    await ctx.reply("Gagal minta pairing code, bos. Coba lagi ntar.");
  }
});

bot.command("cekbio", checkAccess("premium"), async (ctx) => {
  const numbersToCheck = ctx.message?.text?.split(" ").slice(1).join(" ").match(/\d+/g) || [];
  await handleBioCheck(ctx, numbersToCheck);
});

bot.command("cekbiotxt", checkAccess("premium"), async (ctx) => {
  const replied = ctx.message?.reply_to_message;
  if (!replied?.document) return ctx.reply("Reply file .txt nya dulu, bos.");

  const doc = replied.document;
  if (doc.mime_type !== "text/plain") return ctx.reply("Filenya harus .txt.");

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios.get(fileLink.href);
    const numbersToCheck = String(response.data || "").match(/\d+/g) || [];
    await handleBioCheck(ctx, numbersToCheck);
  } catch (error) {
    console.error("Gagal proses file:", error);
    ctx.reply("Gagal ngambil nomor dari file, coba lagi.");
  }
});

bot.command(["addakses", "delakses"], checkAccess("owner"), (ctx) => {
  const cmd = ctx.message?.text?.split(" ")[0].slice(1);
  const targetId = parseInt(ctx.message?.text?.split(" ")[1], 10);
  if (isNaN(targetId)) return ctx.reply("ID-nya angka, bos.");

  let premiumUsers = getPremiumUsers();

  if (cmd === "addakses") {
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

bot.command("listallakses", checkAccess("owner"), (ctx) => {
  const premiumUsers = getPremiumUsers();
  if (premiumUsers.length === 0) return ctx.reply("Belum ada member premium, bos.");

  let text = "*Nih daftar member premium:*\n";
  premiumUsers.forEach((id) => (text += `- ${id}\n`));
  return ctx.reply(text, { parse_mode: "Markdown" });
});

// =======================
// STARTUP (pasti nahan process)
// =======================
async function startAll() {
  await startWhatsAppClient();

  // Launch Telegraf sekali saja. Kalau gagal, jangan exit.
  // (Kalau token conflict, kamu harus matiin instance lain yang pakai token itu.)
  try {
    console.log("[TG] launching...");
    await bot.launch();
    console.log("[TG] launched");
  } catch (e) {
    const msg = e?.response?.description || e?.message || String(e);
    console.log("[TG] launch error:", msg);
  }

  console.log("𝗗𝗛 𝗢𝗡 𝗕𝗔𝗭𝗭 𝗚𝗔𝗦𝗦 𝗖𝗘𝗞!!!");

  // Double-lock biar ga mungkin exit
  await new Promise(() => {});
}

startAll().catch((e) => {
  console.log("[FATAL]", e);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
