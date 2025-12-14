'use strict';
const path = require('path');
const Fastify = require('fastify');
const staticPlugin = require('@fastify/static');
const formBody = require('@fastify/formbody');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder } = require('discord.js');

// ========== CONFIG FROM ENV ==========
const {
  MONITOR_BOT_TOKEN,
  OWNER_USER_ID,
  MAXY_BOT_ID,
  PANEL_PASSWORD,
  GUILD_ID,
  QUICKCHART_URL,
  TARGET_KEEPALIVE_URL
} = process.env;

if (!MONITOR_BOT_TOKEN || !OWNER_USER_ID || !MAXY_BOT_ID || !PANEL_PASSWORD) {
  console.error('ERROR: Missing required env variables. Set MONITOR_BOT_TOKEN, OWNER_USER_ID, MAXY_BOT_ID, PANEL_PASSWORD');
  process.exit(1);
}
const PORT = Number(process.env.PORT) || 3000;
const QUICKCHART = QUICKCHART_URL || 'https://quickchart.io/chart';

// ========== DATABASE ==========
const DB_PATH = path.join(__dirname, 'bot.db');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    channel_id TEXT DEFAULT '1432361053437689898',
    test_type TEXT DEFAULT 'prefix',
    command TEXT DEFAULT '.ping',
    interval_ms INTEGER DEFAULT 150000,
    timeout_ms INTEGER DEFAULT 5000,
    response_match TEXT DEFAULT 'pong',
    status_override TEXT DEFAULT NULL,
    auto_ping_url TEXT DEFAULT NULL,
    auto_ping_interval_s INTEGER DEFAULT 300
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS logs ( ts INTEGER, up INTEGER )`);

  db.run(`CREATE TABLE IF NOT EXISTS downtimes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_ts INTEGER,
    end_ts INTEGER
  )`);

  db.get('SELECT COUNT(*) as c FROM settings WHERE id = 1', (err, row) => {
    if (!row || !row.c) {
      db.run('INSERT INTO settings (id) VALUES (1)');
    }
  });
});

function dbGet(sql, params=[]) { return new Promise((res, rej) => db.get(sql, params, (e, r)=> e ? rej(e) : res(r))); }
function dbAll(sql, params=[]) { return new Promise((res, rej) => db.all(sql, params, (e, r)=> e ? rej(e) : res(r))); }
function dbRun(sql, params=[]) { return new Promise((res, rej) => db.run(sql, params, function(e){ e ? rej(e) : res(this); })); }

// ========== FASTIFY SETUP ==========
const app = Fastify({ logger: false });
app.register(formBody);
app.register(staticPlugin, { root: path.join(__dirname, 'public'), prefix: '/' });

let adminSession = false;
function requireAuth(req, reply, done) { if (!adminSession) return reply.code(401).send('Unauthorized'); done(); }

// LOGIN/LOGOUT
app.post('/login', async (req, reply) => {
  const pw = req.body && req.body.password;
  if (pw === PANEL_PASSWORD) { adminSession = true; return reply.redirect('/panel.html'); }
  return reply.code(401).send('Wrong password');
});
app.get('/logout', async (req, reply) => { adminSession = false; return reply.redirect('/'); });

// Settings endpoints (protected)
app.get('/get-settings', { preHandler: requireAuth }, async (req, reply) => {
  const s = await dbGet('SELECT * FROM settings WHERE id = 1');
  return reply.send(s);
});
app.post('/set-test', { preHandler: requireAuth }, async (req, reply) => {
  const b = req.body || {};
  await dbRun(`UPDATE settings SET channel_id=?, test_type=?, command=?, interval_ms=?, timeout_ms=?, response_match=?, auto_ping_url=?, auto_ping_interval_s=? WHERE id=1`, [
    b.channel_id || '', b.test_type || 'prefix', b.command || '!ping',
    Number(b.interval_ms) || 15000, Number(b.timeout_ms) || 5000, b.response_match || 'pong',
    b.auto_ping_url || null, Number(b.auto_ping_interval_s) || 300
  ]);
  restartMonitorLoop();
  restartAutoPingLoop();
  return reply.redirect('/panel.html');
});

// override
app.post('/set-override', { preHandler: requireAuth }, async (req, reply) => {
  const status = req.body.status || null;
  await dbRun('UPDATE settings SET status_override = ? WHERE id = 1', [status]);
  return reply.send({ ok: true });
});

// run immediate check
app.post('/run-check', { preHandler: requireAuth }, async (req, reply) => {
  try {
    const ok = await runSingleCheck();
    return reply.send({ ok, message: ok ? 'Maxy responded (UP)' : 'No response (DOWN)' });
  } catch (e) { console.error('run-check error', e); return reply.code(500).send({ ok:false, message:'error' }); }
});

// public status (override first)
app.get('/status.json', async (req, reply) => {
  const s = await dbGet('SELECT status_override FROM settings WHERE id = 1');
  if (s && s.status_override) return reply.send({ status: s.status_override });
  const last = await dbGet('SELECT up FROM logs ORDER BY ts DESC LIMIT 1');
  return reply.send({ status: last && last.up ? 'online' : 'down' });
});

// monthly data
app.get('/monthly.json', async (req, reply) => {
  const rows = await dbAll('SELECT ts, up FROM logs ORDER BY ts ASC');
  const days = {};
  rows.forEach(r => {
    const d = new Date(r.ts).toISOString().slice(0,10);
    if (!days[d]) days[d] = { up:0, total:0 };
    days[d].total++; if (r.up) days[d].up++;
  });
  const result = [];
  for (let i=29;i>=0;i--) {
    const d = new Date(Date.now() - i*24*3600*1000).toISOString().slice(0,10);
    const v = days[d] || { up:0, total:0 };
    const uptime = v.total===0 ? 100.00 : (v.up / v.total * 100);
    result.push({ day: d, uptime: Number(uptime.toFixed(2)), checks: v.total });
  }
  return reply.send(result);
});

// last incident
app.get('/last-incident', async (req, reply) => {
  const row = await dbGet('SELECT * FROM downtimes ORDER BY id DESC LIMIT 1');
  return reply.send(row || null);
});

app.get('/_health', async (req, reply) => reply.send('ok'));

// ========== DISCORD MONITOR BOT ==========
const client = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages ]
});

async function sendDMToOwner(text) {
  try { const u = await client.users.fetch(OWNER_USER_ID); if (u) await u.send(text); } catch (e) { console.error('DM failed', e); }
}

function waitForMaxyResponse(matcher, timeoutMs) {
  return new Promise(resolve => {
    let resolved = false;
    function handler(m) {
      if (!m.author) return;
      if (String(m.author.id) !== String(MAXY_BOT_ID)) return;
      const content = (m.content || '');
      try { const rx = new RegExp(matcher, 'i'); if (rx.test(content)) { resolved = true; client.off('messageCreate', handler); resolve(true); } }
      catch { if (content.toLowerCase().includes(String(matcher).toLowerCase())) { resolved = true; client.off('messageCreate', handler); resolve(true); } }
    }
    client.on('messageCreate', handler);
    setTimeout(()=>{ if (!resolved) { client.off('messageCreate', handler); resolve(false); } }, timeoutMs);
  });
}

let monitorHandle = null;
let autoPingHandle = null;
let wasOnline = true;
let downtimeStart = null;

async function runSingleCheck() {
  const s = await dbGet('SELECT * FROM settings WHERE id = 1');
  if (!s || !s.channel_id) { console.log('No channel configured; skipping check'); return false; }
  try {
    const ch = await client.channels.fetch(s.channel_id);
    if (!ch) throw new Error('channel not found');
    if (s.test_type === 'prefix') await ch.send(s.command);
    else if (s.test_type === 'mention') await ch.send(`<@${MAXY_BOT_ID}> ${s.command}`);
    else await ch.send(s.command);

    const ok = await waitForMaxyResponse(s.response_match || 'pong', s.timeout_ms || 5000);
    await dbRun('INSERT INTO logs(ts, up) VALUES(?, ?)', [Date.now(), ok ? 1 : 0]);

    const owner = await client.users.fetch(OWNER_USER_ID).catch(()=>null);

    if (!ok && wasOnline) {
      wasOnline = false; downtimeStart = Date.now();
      await dbRun('INSERT INTO downtimes (start_ts, end_ts) VALUES(?, NULL)', [downtimeStart]);
      if (owner) await owner.send('❌ **Maxy is DOWN**');
    } else if (ok && !wasOnline) {
      wasOnline = true;
      const end = Date.now();
      await dbRun('UPDATE downtimes SET end_ts = ? WHERE id = (SELECT id FROM downtimes ORDER BY id DESC LIMIT 1)', [end]);
      const sec = Math.floor((end - downtimeStart)/1000); downtimeStart = null;
      if (owner) await owner.send(`✅ **Maxy is BACK UP** (downtime: ${sec}s)`);
    }
    return ok;
  } catch (e) {
    console.error('runSingleCheck error', e);
    await dbRun('INSERT INTO logs(ts, up) VALUES(?, ?)', [Date.now(), 0]);
    if (wasOnline) {
      wasOnline = false; downtimeStart = Date.now();
      await dbRun('INSERT INTO downtimes (start_ts, end_ts) VALUES(?, NULL)', [downtimeStart]);
      await sendDMToOwner('❌ **Maxy is DOWN (error sending test message)**');
    }
    return false;
  }
}

async function startMonitorLoop() {
  const s = await dbGet('SELECT interval_ms FROM settings WHERE id = 1');
  const interval = s && s.interval_ms ? s.interval_ms : 15000;
  if (monitorHandle) clearInterval(monitorHandle);
  runSingleCheck().catch(console.error);
  monitorHandle = setInterval(() => runSingleCheck().catch(console.error), interval);
}
function restartMonitorLoop() { if (monitorHandle) clearInterval(monitorHandle); startMonitorLoop().catch(console.error); }

// Auto ping external target
async function doAutoPing() {
  const s = await dbGet('SELECT auto_ping_url, auto_ping_interval_s FROM settings WHERE id = 1');
  if (!s || !s.auto_ping_url) return;
  try { const res = await fetch(s.auto_ping_url, { timeout: 10000 }); console.log('[auto-ping]', s.auto_ping_url, res.status); }
  catch (e) { console.warn('[auto-ping] error', e && e.message ? e.message : e); }
}
function startAutoPingLoop() {
  dbGet('SELECT auto_ping_url, auto_ping_interval_s FROM settings WHERE id = 1').then(s => {
    if (!s || !s.auto_ping_url) return;
    const intr = s.auto_ping_interval_s && s.auto_ping_interval_s >= 60 ? s.auto_ping_interval_s : 300;
    if (autoPingHandle) clearInterval(autoPingHandle);
    doAutoPing().catch(()=>{});
    autoPingHandle = setInterval(()=>doAutoPing().catch(()=>{}), intr*1000);
  }).catch(console.error);
}
function restartAutoPingLoop() { if (autoPingHandle) clearInterval(autoPingHandle); startAutoPingLoop(); }

// uptime helper
async function calcUptime(hours) {
  const ms = hours * 60 * 60 * 1000;
  const since = Date.now() - ms;
  const rows = await dbAll('SELECT up FROM logs WHERE ts >= ? ORDER BY ts ASC', [since]);
  if (!rows || rows.length === 0) return 100.00;
  const upCount = rows.filter(r => r.up === 1).length;
  return Number(((upCount / rows.length) * 100).toFixed(2));
}

// QuickChart image builder
async function buildQuickChartPng(uptimeSeries) {
  const chartConfig = {
    type: 'line',
    data: {
      labels: uptimeSeries.labels,
      datasets: [{ label:'Uptime %', data: uptimeSeries.data, fill:true, borderColor:'#39d353', backgroundColor:'rgba(57,211,83,0.08)' }]
    },
    options: { scales: { y: { min:0, max:100 } }, plugins:{ legend:{ display:false } } }
  };
  const url = QUICKCHART + '?c=' + encodeURIComponent(JSON.stringify(chartConfig)) + '&format=png&width=800&height=300&devicePixelRatio=1';
  const res = await fetch(url);
  if (!res.ok) throw new Error('QuickChart fetch failed');
  const buf = await res.buffer();
  return buf;
}

// /health building
async function handleHealthInteraction() {
  const u24 = await calcUptime(24);
  const u7 = await calcUptime(24*7);
  const u30 = await calcUptime(24*30);

  const rows = await dbAll('SELECT ts, up FROM logs ORDER BY ts ASC');
  const now = Date.now();
  const buckets = Array.from({length:24}, (_,i)=>({t: now - (23-i)*3600*1000, up:0, total:0}));
  rows.forEach(r => {
    const ageH = Math.floor((now - r.ts) / 3600000);
    if (ageH >=0 && ageH < 24) {
      const idx = 23 - ageH;
      buckets[idx].total++;
      if (r.up) buckets[idx].up++;
    }
  });
  const labels = buckets.map(b => new Date(b.t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));
  const data = buckets.map(b => b.total === 0 ? 100 : Math.round((b.up / b.total) * 100));

  const png = await buildQuickChartPng({ labels, data });
  const lastInc = await dbGet('SELECT * FROM downtimes ORDER BY id DESC LIMIT 1');
  const lastStr = lastInc ? (lastInc.end_ts ? `Last incident: ${new Date(lastInc.start_ts).toLocaleString()} (ended ${new Date(lastInc.end_ts).toLocaleString()})` : `Ongoing since ${new Date(lastInc.start_ts).toLocaleString()}`) : 'No incidents recorded';
  const text = `Maxy health summary\\n24h: ${u24}%  •  7d: ${u7}%  •  30d: ${u30}%\\n${lastStr}`;
  return { png, text };
}

// Slash registration
async function registerSlash() {
  if (!GUILD_ID) return;
  try {
    const rest = new REST({ version: '10' }).setToken(MONITOR_BOT_TOKEN);
    const command = new SlashCommandBuilder().setName('health').setDescription('Show Maxy health summary').toJSON();
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: [command] });
    console.log('Registered /health in guild', GUILD_ID);
  } catch (e) { console.warn('Slash register failed', e && e.message ? e.message : e); }
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'health') {
      await interaction.deferReply();
      const { png, text } = await handleHealthInteraction();
      const attachment = new AttachmentBuilder(png, { name: 'health.png' });
      await interaction.editReply({ content: text, files: [attachment] });
    }
  } catch (e) {
    console.error('interaction handler error', e);
    try { if (interaction.deferred || interaction.replied) await interaction.editReply('Error'); else await interaction.reply('Error'); } catch {}
  }
});

// Prefix fallback !health
client.on('messageCreate', async (msg) => {
  if (msg.author?.bot) return;
  const t = (msg.content || '').trim();
  if (t === '!health' || t === '!status') {
    try {
      const { png, text } = await handleHealthInteraction();
      const attachment = new AttachmentBuilder(png, { name: 'health.png' });
      await msg.channel.send({ content: text, files: [attachment] });
    } catch (e) { console.error('!health error', e); await msg.channel.send('Error generating health summary'); }
  }
});

// Start loops on ready
client.once('ready', async () => {
  console.log('Monitor bot ready as', client.user.tag);
  await registerSlash();
  startMonitorLoop().catch(console.error);
  startAutoPingLoop();
});
client.login(MONITOR_BOT_TOKEN).catch(e=>{ console.error('Discord login failed', e); process.exit(1); });

// Start the Fastify server
app.listen({ port: PORT, host: '0.0.0.0' }).then(()=>console.log('Server listening on', PORT)).catch(console.error);
