// index.js (FULL) — Koyeb Worker ready + anti-exit + debug token + Baileys session persist
// NOTE: jangan taruh token di repo publik. Paling aman pakai env TELEGRAM_BOT_TOKEN.

setInterval(() => {}, 1 << 30); // keep-alive ekstra (boleh)

console.log("Memulai bot...");

const { Telegraf } = require("telegraf");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const fs = require("fs");
const axios = require("axios");
const path = require("path");

const config = require("./config");

// kalau kamu mau override dari env (recommended):
if (process.env.TELEGRAM_BOT_TOKEN) config.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;

config.telegramBotToken = String(config.telegramBotToken || "").trim();

// === DEBUG token (biar kebukti yg kebaca di Koyeb token yg bener) ===
console.log("[DBG] TG token length:", config.telegramBotToken.length);
console.log("[DBG] TG token head:", config.telegramBotToken.slice(0, 12));
console.log("[DBG] TG token tail:", config.telegramBotToken.slice(-6));

(async () => {
  try {
    const r = await axios.get(`https://api.telegram.org/bot${config.telegramBotToken}/getMe`);
    console.log("[DBG] getMe ok:", r.data?.ok, "username:", r.data?.result?.username);
  } catch (e) {
    console.log("[DBG] getMe failed:", e?.response?.status, e?.response?.data || e.message);
  }
})();

// === DATA DIR untuk Koyeb Volume (/data) ===
const DATA_DIR = process.env.DATA_DIR || ".";
const premiumPath = path.join(DATA_DIR, "premium.json");

const getPremiumUsers = () => {
  try {
    return JSON.parse(fs.readFileSync(premiumPath, "utf8"));
  } catch (e) {
    try {
      fs.writeFileSync(premiumPath, "[]");
    } catch {}
    return [];
  }
};

const savePremiumUsers = (users) => {
  fs.writeFileSync(premiumPath, JSON.stringify(users, null, 2));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let waClient = null;
let waConnectionStatus = "closed";

async function startWhatsAppClient() {
  console.log("Mencoba memulai koneksi WhatsApp...");

  const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, config.sessionName));

  waClient = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: ["Mac OS", "Safari", "10.15.7"],
  });

  waClient.ev.on("creds.update", saveCreds);

  waClient.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    waConnectionStatus = connection;

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        "Koneksi WhatsApp tertutup. Alasan:",
        new Boom(lastDisconnect?.error).message,
        "|| Coba sambung ulang:",
        shouldReconnect
      );

      if (shouldReconnect) setTimeout(startWhatsAppClient, 5000);
      else {
        console.log("Tidak bisa menyambung ulang (logged out).");
        waClient = null;
      }
    } else if (connection === "open") {
      console.log("Berhasil tersambung ke WhatsApp!");
    }
  });
}

async function handleBioCheck(ctx, numbersToCheck) {
  if (waConnectionStatus !== "open")
    return ctx.reply(config.message.waNotConnected || "WA belum nyambung. /pairing dulu.", {
      parse_mode: "Markdown",
    });

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

  if (registeredNumbers.length > 0) {
    const batchSize = config.settings?.cekBioBatchSize || config.settings?.cekBioBatchSize || 15;

    for (let i = 0; i < registeredNumbers.length; i += batchSize) {
      const batch = registeredNumbers.slice(i, i + batchSize);

      const promises = batch.map(async (nomor) => {
        const jid = nomor.trim() + "@s.whatsapp.net";
        try {
          const statusResult = await waClient.fetchStatus(jid);

          let bioText = null;
          let setAtText = null;

          if (Array.isArray(statusResult) && statusResult.length > 0) {
            const data = statusResult[0];
            if (data) {
              if (typeof data.status === "string") bioText = data.status;
              else if (typeof data.status === "object" && data.status !== null)
                bioText = data.status.text || data.status.status;

              setAtText = data.setAt || (data.status && data.status.setAt);
            }
          }

          if (bioText && bioText.trim() !== "") withBio.push({ nomor, bio: bioText, setAt: setAtText });
          else noBio.push(nomor);
        } catch (e) {
          notRegistered.push(nomor.trim());
        }
      });

      await Promise.allSettled(promises);
      await sleep(1000);
    }
  }

  let fileContent = "NIH bos HASIL CEK BIO SEMUA USER\n\n";
  fileContent += `✅ Total nomor dicek : ${numbersToCheck.length}\n`;
  fileContent += `📳 Dengan Bio       : ${withBio.length}\n`;
  fileContent += `📵 Tanpa Bio        : ${noBio.length}\n`;
  fileContent += `🚫 Tidak Terdaftar  : ${notRegistered.length}\n\n`;

  if (withBio.length > 0) {
    fileContent += `----------------------------------------\n\n`;
    fileContent += `✅ NOMOR DENGAN BIO (${withBio.length})\n\n`;

    const groupedByYear = withBio.reduce((acc, item) => {
      const year = new Date(item.setAt).getFullYear() || "Tahun Tidak Diketahui";
      if (!acc[year]) acc[year] = [];
      acc[year].push(item);
      return acc;
    }, {});

    const sortedYears = Object.keys(groupedByYear).sort();

    for (const year of sortedYears) {
      fileContent += `Tahun ${year}\n\n`;
      groupedByYear[year]
        .sort((a, b) => new Date(a.setAt) - new Date(b.setAt))
        .forEach((item) => {
          const date = new Date(item.setAt);
          let formattedDate = "...";
          if (!isNaN(date)) {
            const datePart = date.toLocaleDateString("id-ID", { day: "2-digit", month: "2-digit", year: "numeric" });
            const timePart = date
              .toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
              .replace(/\./g, ":");
            formattedDate = `${datePart}, ${timePart.replace(/:/g, ".")}`;
          }
          fileContent += `└─ 📅 ${item.nomor}\n   └─ 📝 "${item.bio}"\n      └─ ⏰ ${formattedDate}\n\n`;
        });
    }
  }

  fileContent += `----------------------------------------\n\n`;
  fileContent += `📵 NOMOR TANPA BIO / PRIVASI (${noBio.length})\n\n`;
  if (noBio.length > 0) noBio.forEach((nomor) => (fileContent += `${nomor}\n`));
  else fileContent += `(Kosong)\n`;

  const filePath = `./hasil_cekbio_By_bos${ctx.from.id}.txt`;
  fs.writeFileSync(filePath, fileContent);

  await ctx.replyWithDocument({ source: filePath }, { caption: "Nih hasilnya bos." });
  fs.unlinkSync(filePath);
}

// === TELEGRAM BOT ===
const bot = new Telegraf(config.telegramBotToken);

const checkAccess = (level) => async (ctx, next) => {
  const userId = ctx.from?.id;

  if (level === "owner" && userId !== config.ownerId) {
    return ctx.reply(config.message.owner || "Khusus owner.", { parse_mode: "Markdown" });
  }

  if (level === "premium") {
    const isPremium = getPremiumUsers().includes(userId);
    if (userId !== config.ownerId && !isPremium) {
      return ctx.reply(config.message.premium || "Khusus premium.", { parse_mode: "Markdown" });
    }
  }

  await next();
};

bot.command("start", (ctx) => {
  const userName = ctx.from?.first_name || "bos";
  const premiumStatus = "ON";

  const caption = `🕊 *(!) Holà ${userName}!*
Gw siap bantu lu cek bio & info WhatsApp.

━━━━━━━━━━━━━━━━━━━━━━━━

⬡ Author : bos Mmk
⬡ Version : 1.0
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
      `📲 Nih kodenya bos: *${code}*\n\nMasukin di WA lu:\n*Tautkan Perangkat > Tautkan dengan nomor telepon*`,
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
  if (doc.mime_type !== "text/plain") return ctx.reply("Filenya harus .txt, jangan yang lain.");

  try {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios.get(fileLink.href);
    const numbersToCheck = response.data.match(/\d+/g) || [];
    await handleBioCheck(ctx, numbersToCheck);
  } catch (error) {
    console.error("Gagal proses file:", error);
    ctx.reply("Gagal ngambil nomor dari file, coba lagi.");
  }
});

bot.command(["addakses", "delakses"], checkAccess("owner"), (ctx) => {
  const command = ctx.message?.text?.split(" ")[0].slice(1);
  const targetId = parseInt(ctx.message?.text?.split(" ")[1], 10);

  if (isNaN(targetId)) return ctx.reply("ID-nya angka, bos.");

  let premiumUsers = getPremiumUsers();

  if (command === "addakses") {
    if (premiumUsers.includes(targetId)) return ctx.reply(`ID ${targetId} udah premium.`);
    premiumUsers.push(targetId);
    savePremiumUsers(premiumUsers);
    return ctx.reply(`✅ Siap! ID ${targetId} sekarang premium.`);
  }

  if (!premiumUsers.includes(targetId)) return ctx.reply(`ID ${targetId} bukan premium.`);
  premiumUsers = premiumUsers.filter((id) => id !== targetId);
  savePremiumUsers(premiumUsers);
  return ctx.reply(`✅ Oke, ID ${targetId} udah dicabut.`);
});

bot.command("listallakses", checkAccess("owner"), (ctx) => {
  const premiumUsers = getPremiumUsers();
  if (premiumUsers.length === 0) return ctx.reply("Belum ada member premium, bos.");

  let text = "*Nih daftar member premium:*\n";
  premiumUsers.forEach((id) => (text += `- ${id}\n`));
  return ctx.reply(text, { parse_mode: "Markdown" });
});

// === STARTUP ===
(async () => {
  await startWhatsAppClient();

  try {
    await bot.launch();
    console.log("Telegram bot launched");
  } catch (e) {
    // tampilkan detail biar jelas unauthorized dari mana
    console.error("Telegraf launch error raw:", {
      message: e?.message,
      status: e?.response?.error_code,
      desc: e?.response?.description,
      on: e?.on,
    });
  }

  console.log("BOT READY");

  // tahan proses selamanya (ini yang nge-stop loop Koyeb)
  await new Promise(() => {});
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
