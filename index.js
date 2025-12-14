// server.js
// Render-ready Node monitor (Discord + web UI + keepalive endpoint)
// Run with: node server.js
// IMPORTANT: set env vars in Render dashboard or in your environment:
//   MONITOR_BOT_TOKEN, OWNER_USER_ID, MAXY_BOT_ID, PANEL_PASSWORD
// Optionally:
//   TARGET_KEEPALIVE_URL (a URL the process will ping periodically, e.g. itself or another resource)
//   KEEPALIVE_INTERVAL (seconds, default 300)

const express = require("express");
const session = require("express-session");
const path = require("path");
const Database = require("better-sqlite3");
const fetch = require("node-fetch");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

// ===== CONFIG (fill via env vars in Render) =====
const MONITOR_BOT_TOKEN = process.env.MONITOR_BOT_TOKEN || "YOUR_MONITOR_BOT_TOKEN";
const OWNER_USER_ID = process.env.OWNER_USER_ID || "YOUR_DISCORD_USER_ID";
const MAXY_BOT_ID = process.env.MAXY_BOT_ID || "MAXY_BOT_ID";
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "CHANGE_THIS_PANEL_PASSWORD";
const DEFAULT_INTERVAL = Number(process.env.DEFAULT_INTERVAL) || 15000; // ms
// Optional keepalive target (if you want this app to ping an external URL periodically)
const TARGET_KEEPALIVE_URL = process.env.TARGET_KEEPALIVE_URL || null;
const KEEPALIVE_INTERVAL = Number(process.env.KEEPALIVE_INTERVAL) || 300; // seconds
// =================================================

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, "bot.db");
const db = new Database(DB_PATH);

// === DB schema ===
db.prepare(`CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  test_type TEXT DEFAULT 'prefix',
  command TEXT DEFAULT '!ping',
  channel_id TEXT DEFAULT '',
  timeout_ms INTEGER DEFAULT 5000,
  interval_ms INTEGER DEFAULT 15000,
  response_match TEXT DEFAULT 'pong',
  last_status TEXT DEFAULT 'online'
)`).run();

const exists = db.prepare("SELECT COUNT(*) as c FROM settings WHERE id = 1").get().c;
if (!exists) db.prepare(`INSERT INTO settings (id) VALUES (1)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  up INTEGER NOT NULL
)`).run();

function readSettings() {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get();
}

function saveSettings(obj) {
  const stmt = db.prepare(`
    UPDATE settings SET
    test_type = @test_type,
    command = @command,
    channel_id = @channel_id,
    timeout_ms = @timeout_ms,
    interval_ms = @interval_ms,
    response_match = @response_match
    WHERE id = 1
  `);
  stmt.run(obj);
}

function setLastStatus(status) {
  db.prepare("UPDATE settings SET last_status = ? WHERE id = 1").run(status);
}

function addCheck(up) {
  db.prepare("INSERT INTO checks (ts, up) VALUES (?, ?)").run(Date.now(), up ? 1 : 0);
  // prune > 90 days
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  db.prepare("DELETE FROM checks WHERE ts < ?").run(cutoff);
}

function getChecksSince(msAgo) {
  const since = Date.now() - msAgo;
  return db.prepare("SELECT ts, up FROM checks WHERE ts >= ? ORDER BY ts ASC").all(since);
}

function calcUptime(hours) {
  const ms = hours * 60 * 60 * 1000;
  const rows = getChecksSince(ms);
  if (rows.length === 0) return 100.0;
  const upCount = rows.filter(r => r.up === 1).length;
  return ((upCount / rows.length) * 100).toFixed(2);
}

function getMonthlyStats() {
  const rows = db.prepare("SELECT ts, up FROM checks ORDER BY ts ASC").all();
  const days = {};
  rows.forEach(r => {
    const d = new Date(r.ts);
    const k = d.toISOString().slice(0,10);
    if (!days[k]) days[k] = { up: 0, total: 0 };
    days[k].total++;
    if (r.up === 1) days[k].up++;
  });
  const result = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000);
    const k = d.toISOString().slice(0,10);
    const v = days[k] || { up: 0, total: 0 };
    const uptime = v.total === 0 ? 100.00 : ((v.up / v.total) * 100);
    result.push({ day: k, uptime: Number(uptime.toFixed(2)), checks: v.total });
  }
  return result;
}

// === Discord monitor bot ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once("ready", () => {
  console.log("Monitor bot ready as", client.user.tag);
});

client.login(MONITOR_BOT_TOKEN).catch(err => {
  console.error("Failed to login monitor bot:", err);
  process.exit(1);
});

async function sendDMToOwner(text) {
  try {
    if (!OWNER_USER_ID) return;
    const user = await client.users.fetch(OWNER_USER_ID);
    await user.send(text);
  } catch (err) {
    console.error("Failed to send DM:", err);
  }
}

function waitForResponse(maxyId, matcher, timeoutMs) {
  return new Promise(resolve => {
    let resolved = false;
    function handler(msg) {
      if (!msg.author) return;
      if (String(msg.author.id) !== String(maxyId)) return;
      const content = (msg.content || "");
      try {
        const rx = new RegExp(matcher, "i");
        if (rx.test(content)) {
          resolved = true;
          client.off("messageCreate", handler);
          resolve(true);
        }
      } catch (e) {
        if (content.toLowerCase().includes(String(matcher).toLowerCase())) {
          resolved = true;
          client.off("messageCreate", handler);
          resolve(true);
        }
      }
    }
    client.on("messageCreate", handler);
    setTimeout(() => {
      if (!resolved) {
        client.off("messageCreate", handler);
        resolve(false);
      }
    }, timeoutMs);
  });
}

async function runSingleCheck() {
  const s = readSettings();
  if (!s.channel_id) {
    console.log("No channel set; skipping check.");
    return false;
  }
  let channel;
  try {
    channel = await client.channels.fetch(s.channel_id);
    if (!channel) throw new Error("channel not found");
  } catch (e) {
    console.error("Failed to fetch channel:", e.message);
    addCheck(false);
    const last = readSettings().last_status || "online";
    if (last !== "down") {
      setLastStatus("down");
      await sendDMToOwner("❌ Monitor: failed to fetch channel or missing perms — marking Maxy as DOWN.");
    }
    return false;
  }

  const testType = s.test_type || "prefix";
  const command = s.command || "!ping";
  const timeoutMs = s.timeout_ms || 5000;
  const matcher = s.response_match || "pong";

  try {
    if (testType === "prefix") {
      await channel.send(command);
    } else if (testType === "mention") {
      await channel.send(`<@${MAXY_BOT_ID}> ${command}`);
    } else {
      await channel.send(command);
    }
  } catch (err) {
    console.error("Failed to send test message:", err.message);
    addCheck(false);
    const last = readSettings().last_status || "online";
    if (last !== "down") {
      setLastStatus("down");
      await sendDMToOwner("❌ Monitor: failed to send test message — marking Maxy as DOWN (or missing perms).");
    }
    return false;
  }

  const ok = await waitForResponse(MAXY_BOT_ID, matcher, timeoutMs);
  addCheck(ok);

  const lastStatus = readSettings().last_status || "online";
  if (!ok && lastStatus !== "down") {
    setLastStatus("down");
    console.log("Maxy seems DOWN");
    await sendDMToOwner("❌ Maxy is DOWN — no matching response within timeout.");
  } else if (ok && lastStatus === "down") {
    setLastStatus("online");
    console.log("Maxy back ONLINE");
    await sendDMToOwner("✅ Maxy is back ONLINE (response detected).");
  }

  return ok;
}

let loopHandle = null;
function startLoop() {
  if (loopHandle) clearInterval(loopHandle);
  const s = readSettings();
  const interval = s.interval_ms && s.interval_ms > 1000 ? s.interval_ms : DEFAULT_INTERVAL;
  runSingleCheck().catch(console.error);
  loopHandle = setInterval(() => {
    runSingleCheck().catch(console.error);
  }, interval);
}

function restartLoop() {
  startLoop();
}

client.on("ready", () => startLoop());

// === Keepalive internal pinger & endpoint ===
let lastKeepalive = { time: null, success: null, status: null, error: null, body_snippet: null };

async function doKeepalivePing() {
  if (!TARGET_KEEPALIVE_URL) return;
  try {
    const r = await fetch(TARGET_KEEPALIVE_URL, { timeout: 10000, headers: { "User-Agent": "maxy-monitor-keepalive/1.0" } });
    const txt = await r.text().catch(()=>"");
    lastKeepalive = {
      time: Date.now(),
      success: r.ok,
      status: r.status,
      error: null,
      body_snippet: txt.slice(0,200)
    };
    console.log(`[keepalive] pinged ${TARGET_KEEPALIVE_URL} -> ${r.status}`);
  } catch (e) {
    lastKeepalive = {
      time: Date.now(),
      success: false,
      status: null,
      error: String(e),
      body_snippet: null
    };
    console.warn("[keepalive] error pinging target:", e && e.message ? e.message : e);
  }
}

if (TARGET_KEEPALIVE_URL) {
  // start background pinger
  setInterval(doKeepalivePing, Math.max(60, KEEPALIVE_INTERVAL) * 1000);
  // ping once on startup
  setTimeout(() => { doKeepalivePing().catch(()=>{}); }, 2000);
}

// === Express web server & panel ===
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: "maxy-monitor-secret",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

app.use(express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
  if (req.session && req.session.auth) return next();
  return res.redirect("/login.html");
}

app.post("/login", (req, res) => {
  const pw = req.body.password;
  if (pw && pw === PANEL_PASSWORD) {
    req.session.auth = true;
    return res.redirect("/panel.html");
  }
  return res.send("Wrong password");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login.html"));
});

// settings getter for panel
app.get("/get-settings", requireAuth, (req, res) => {
  const s = readSettings();
  res.json({
    test_type: s.test_type,
    command: s.command,
    channel_id: s.channel_id,
    timeout_ms: s.timeout_ms,
    interval_ms: s.interval_ms,
    response_match: s.response_match,
    last_status: s.last_status
  });
});

// save settings
app.post("/set-test", requireAuth, (req, res) => {
  const obj = {
    test_type: req.body.test_type || "prefix",
    command: req.body.command || "!ping",
    channel_id: req.body.channel_id || "",
    timeout_ms: Number(req.body.timeout_ms) || 5000,
    interval_ms: Number(req.body.interval_ms) || DEFAULT_INTERVAL,
    response_match: req.body.response_match || "pong"
  };
  saveSettings(obj);
  restartLoop();
  res.redirect("/panel.html");
});

// run immediate check
app.post("/run-check", requireAuth, async (req, res) => {
  try {
    const ok = await runSingleCheck();
    return res.json({ ok, message: ok ? "Maxy responded (UP)" : "No response (DOWN)" });
  } catch (e) {
    console.error("Immediate check error:", e);
    return res.status(500).json({ ok: false, message: "Error running check" });
  }
});

// status JSON for public status page
app.get("/status.json", (req, res) => {
  const s = readSettings();
  res.json({
    status: s.last_status || "online",
    lastDown: (() => {
      const row = db.prepare("SELECT ts FROM checks WHERE up = 0 ORDER BY ts DESC LIMIT 1").get();
      return row ? row.ts : null;
    })(),
    uptime24h: calcUptime(24),
    uptime7d: calcUptime(168)
  });
});

// monthly graph data
app.get("/monthly.json", (req, res) => {
  res.json(getMonthlyStats());
});

// keepalive endpoint for external pings (UptimeRobot can ping this)
app.get("/keepalive", (req, res) => {
  res.json({
    ok: true,
    target_keepalive_url: TARGET_KEEPALIVE_URL,
    last_keepalive: lastKeepalive,
    note: "Ping this endpoint from an external monitor (UptimeRobot) to keep the service awake."
  });
});

// simple health
app.get("/_health", (req, res) => res.send("ok"));

// start server
app.listen(PORT, () => {
  console.log(`Web UI listening on port ${PORT}`);
});
