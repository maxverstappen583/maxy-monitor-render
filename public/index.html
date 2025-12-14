// index.js
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const Fastify = require("fastify");
const staticPlugin = require("@fastify/static");
const formBody = require("@fastify/formbody");
const { Client, GatewayIntentBits } = require("discord.js");

// ================= ENV =================
const {
  MONITOR_BOT_TOKEN,
  OWNER_USER_ID,
  MAXY_BOT_ID,
  PANEL_PASSWORD
} = process.env;

if (!MONITOR_BOT_TOKEN || !OWNER_USER_ID || !MAXY_BOT_ID || !PANEL_PASSWORD) {
  console.error("❌ Missing env variables");
  process.exit(1);
}

// ================= DATABASE =================
const db = new sqlite3.Database("./bot.db");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY,
      channel_id TEXT,
      command TEXT,
      interval_ms INTEGER,
      timeout_ms INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      ts INTEGER,
      online INTEGER
    )
  `);

  db.run(`
    INSERT OR IGNORE INTO settings
    (id, channel_id, command, interval_ms, timeout_ms)
    VALUES (1, '', '!ping', 15000, 5000)
  `);
});

// ================= FASTIFY =================
const app = Fastify();
app.register(formBody);
app.register(staticPlugin, {
  root: path.join(__dirname, "public")
});

let session = false;

// Login
app.post("/login", async (req, reply) => {
  if (req.body.password === PANEL_PASSWORD) {
    session = true;
    reply.redirect("/panel.html");
  } else {
    reply.code(401).send("Wrong password");
  }
});

app.get("/logout", async (_, reply) => {
  session = false;
  reply.redirect("/");
});

function auth(req, reply, done) {
  if (!session) return reply.code(401).send("Unauthorized");
  done();
}

app.get("/get-settings", { preHandler: auth }, async () => {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM settings WHERE id=1`, (_, row) => resolve(row));
  });
});

app.post("/set-test", { preHandler: auth }, async (req, reply) => {
  const { channel_id, command, interval_ms, timeout_ms } = req.body;
  db.run(
    `UPDATE settings SET channel_id=?, command=?, interval_ms=?, timeout_ms=? WHERE id=1`,
    [channel_id, command, interval_ms, timeout_ms]
  );
  reply.redirect("/panel.html");
});

app.get("/status.json", async () => {
  return new Promise((resolve) => {
    db.get(`SELECT online FROM logs ORDER BY ts DESC LIMIT 1`, (_, row) => {
      resolve({ status: row?.online ? "online" : "down" });
    });
  });
});

// ================= DISCORD MONITOR BOT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

let wasOnline = true;
let downSince = null;

client.once("ready", () => {
  console.log("🤖 Monitor bot ready");
  startLoop();
});

client.login(MONITOR_BOT_TOKEN);

// ================= CHECK LOGIC =================
async function checkOnce() {
  return new Promise(async (resolve) => {
    db.get(`SELECT * FROM settings WHERE id=1`, async (_, s) => {
      if (!s.channel_id) return resolve(false);

      try {
        const channel = await client.channels.fetch(s.channel_id);
        await channel.send(s.command);

        const filter = (m) =>
          m.author.id === MAXY_BOT_ID &&
          m.content.toLowerCase().includes("pong");

        await channel.awaitMessages({
          filter,
          max: 1,
          time: s.timeout_ms
        });

        resolve(true);
      } catch {
        resolve(false);
      }
    });
  });
}

function startLoop() {
  setInterval(async () => {
    const ok = await checkOnce();
    db.run(`INSERT INTO logs VALUES (?, ?)`, [Date.now(), ok ? 1 : 0]);

    const owner = await client.users.fetch(OWNER_USER_ID);

    if (!ok && wasOnline) {
      downSince = Date.now();
      wasOnline = false;
      owner.send("❌ **Maxy is DOWN**");
    }

    if (ok && !wasOnline) {
      const downtime = Math.floor((Date.now() - downSince) / 1000);
      wasOnline = true;
      downSince = null;
      owner.send(`✅ **Maxy is BACK UP** (downtime: ${downtime}s)`);
    }
  }, 15000);
}

// Immediate check
app.post("/run-check", { preHandler: auth }, async () => {
  const ok = await checkOnce();
  return { ok };
});

// ================= START =================
const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: "0.0.0.0" }, () => {
  console.log("🌐 Server running on", PORT);
});
