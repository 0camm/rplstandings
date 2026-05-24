/*
  rpl_server.js  —  RPL Standings API Bridge
  ============================================
  Deploy on Render (or any Node host).
  Set environment variables:
    RPL_SECRET       = RPLSTANDINGS$
    SUPABASE_URL     = https://xxxx.supabase.co
    SUPABASE_KEY     = your anon/service key

  Endpoints
  ─────────────────────────────────────────────────────
  POST /rpl/standings          ← Roblox posts game results here
  GET  /rpl/standings          ← Website polls current standings
  GET  /rpl/standings/events   ← SSE stream for instant push
  POST /rpl/standings/team     ← Manual W/L override
  GET  /                       ← Health check
*/

"use strict";

const http  = require("http");
const https = require("https");

// ── Config ────────────────────────────────────────────────────
const PORT         = process.env.PORT         || 3000;
const SECRET       = process.env.RPL_SECRET   || "RPLSTANDINGS$";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const RESULTS_MAX  = 20;

// ── In-memory state ───────────────────────────────────────────
let state = {
  teams:       {},
  results:     [],
  lastUpdated: null,
};

// ── SSE client registry ───────────────────────────────────────
const sseClients = new Set();

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// ── Supabase helpers ──────────────────────────────────────────
function supabaseFetch(method, table, body, matchQuery) {
  return new Promise((resolve, reject) => {
    let path = `/rest/v1/${table}`;
    if (matchQuery) path += `?${matchQuery}`;

    const url = new URL(SUPABASE_URL);
    const options = {
      hostname: url.hostname,
      path,
      method,
      headers: {
        "Content-Type":  "application/json",
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Prefer":        "return=minimal",
      },
    };

    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch (_) { resolve({}); }
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Persistence ───────────────────────────────────────────────
async function loadState() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("[RPL] No Supabase config — starting with empty state.");
    return;
  }
  try {
    const rows = await supabaseFetch("GET", "rpl_state", null, "select=key,value");
    if (Array.isArray(rows)) {
      const map = {};
      for (const row of rows) map[row.key] = row.value;
      if (map.teams)       state.teams       = map.teams;
      if (map.results)     state.results     = map.results;
      if (map.lastUpdated) state.lastUpdated = map.lastUpdated;
      console.log("[RPL] Loaded from Supabase:", Object.keys(state.teams).length, "teams,", state.results.length, "results");
    }
  } catch (e) {
    console.error("[RPL] Failed to load from Supabase:", e.message);
  }
}

async function saveState() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const rows = [
      { key: "teams",       value: state.teams },
      { key: "results",     value: state.results },
      { key: "lastUpdated", value: state.lastUpdated },
    ];
    await supabaseFetch("POST", "rpl_state", rows, null);
  } catch (e) {
    console.error("[RPL] Failed to save to Supabase:", e.message);
  }
}

// ── Auth helper ───────────────────────────────────────────────
function isAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === SECRET;
  const url = new URL(req.url, `http://localhost`);
  return url.searchParams.get("secret") === SECRET;
}

// ── W/L record updater ────────────────────────────────────────
function ensureTeam(abb, logo) {
  if (!abb) return;
  if (!state.teams[abb]) {
    state.teams[abb] = { wins: 0, losses: 0, pct: "0.000", streak: "—", logo: logo || "" };
  } else if (logo) {
    state.teams[abb].logo = logo;
  }
}

function updateRecord(winnerABB, loserABB) {
  if (!winnerABB || !loserABB) return;
  ensureTeam(winnerABB);
  ensureTeam(loserABB);
  state.teams[winnerABB].wins  += 1;
  state.teams[loserABB].losses += 1;
  state.teams[winnerABB].streak = updateStreak(state.teams[winnerABB].streak, true);
  state.teams[loserABB].streak  = updateStreak(state.teams[loserABB].streak,  false);
  for (const abb of [winnerABB, loserABB]) {
    const t = state.teams[abb];
    const total = t.wins + t.losses;
    t.pct = total > 0 ? (t.wins / total).toFixed(3) : "0.000";
  }
}

function updateStreak(current, won) {
  const letter = won ? "W" : "L";
  if (!current || current === "—") return `${letter}1`;
  const curLetter = current[0];
  const curNum    = parseInt(current.slice(1), 10) || 0;
  if (curLetter === letter) return `${letter}${curNum + 1}`;
  return `${letter}1`;
}

// ── Body reader ───────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
    req.on("end",  () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// ── CORS + JSON helpers ───────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function sendJSON(res, status, data) {
  setCORS(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Route: POST /rpl/standings ────────────────────────────────
async function handlePostResult(req, res) {
  if (!isAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });

  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const {
    status, homeABB, awayABB, homeLogo, awayLogo,
    homeScore, awayScore, winnerABB, quarter, note,
    season, timestamp, playerOfGame, homeStats, awayStats,
  } = body;

  if (!homeABB || !awayABB || !status)
    return sendJSON(res, 422, { error: "Missing required fields: homeABB, awayABB, status" });

  const now = Date.now();
  const duplicate = state.results.find(r => {
    const age = now - new Date(r.timestamp).getTime();
    return age < 30000 && r.homeABB === homeABB && r.awayABB === awayABB && r.status === status;
  });
  if (duplicate) {
    console.log(`[RPL] Duplicate result ignored: ${awayABB} @ ${homeABB} (${status})`);
    return sendJSON(res, 200, { ok: true, duplicate: true });
  }

  ensureTeam(homeABB, homeLogo);
  ensureTeam(awayABB, awayLogo);

  if (status === "final" || status === "forfeit") {
    if (winnerABB) {
      const loserABB = winnerABB === homeABB ? awayABB : homeABB;
      updateRecord(winnerABB, loserABB);
    }
  }

  const result = {
    id:           Date.now(),
    timestamp:    timestamp || new Date().toISOString(),
    season:       season    || "Season 10",
    status, quarter: quarter || "---", note: note || "",
    homeABB, awayABB,
    homeLogo:     homeLogo  || "",
    awayLogo:     awayLogo  || "",
    homeScore:    homeScore ?? 0,
    awayScore:    awayScore ?? 0,
    winnerABB:    winnerABB || null,
    playerOfGame: playerOfGame || null,
    homeStats:    homeStats || [],
    awayStats:    awayStats || [],
  };

  state.results.unshift(result);
  if (state.results.length > RESULTS_MAX) state.results.length = RESULTS_MAX;
  state.lastUpdated = new Date().toISOString();

  await saveState();

  broadcast("standings", buildPublicPayload());
  broadcast("result",    result);

  console.log(`[RPL] Result saved: ${awayABB} @ ${homeABB} | ${status} | ${awayScore}-${homeScore}`);
  return sendJSON(res, 200, { ok: true, result });
}

// ── Route: GET /rpl/standings ─────────────────────────────────
function handleGetStandings(req, res) {
  setCORS(res);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(buildPublicPayload()));
}

// ── Route: GET /rpl/standings/events (SSE) ────────────────────
function handleSSE(req, res) {
  setCORS(res);
  res.writeHead(200, {
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    "Connection":        "keep-alive",
    "X-Accel-Buffering": "no",
  });

  res.write(`event: standings\ndata: ${JSON.stringify(buildPublicPayload())}\n\n`);
  sseClients.add(res);
  console.log(`[RPL] SSE client connected (${sseClients.size} total)`);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); }
    catch (_) { clearInterval(heartbeat); sseClients.delete(res); }
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    console.log(`[RPL] SSE client disconnected (${sseClients.size} remaining)`);
  });
}

// ── Route: POST /rpl/standings/team ───────────────────────────
async function handleTeamOverride(req, res) {
  if (!isAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });

  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { abb, wins, losses, streak, logo } = body;
  if (!abb) return sendJSON(res, 422, { error: "Missing abb" });

  ensureTeam(abb, logo);
  const t = state.teams[abb];
  if (wins   !== undefined) t.wins   = Math.max(0, parseInt(wins,   10) || 0);
  if (losses !== undefined) t.losses = Math.max(0, parseInt(losses, 10) || 0);
  if (streak !== undefined) t.streak = streak;
  if (logo   !== undefined) t.logo   = logo;

  const total = t.wins + t.losses;
  t.pct = total > 0 ? (t.wins / total).toFixed(3) : "0.000";

  state.lastUpdated = new Date().toISOString();
  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RPL] Manual override: ${abb} → ${t.wins}W-${t.losses}L`);
  return sendJSON(res, 200, { ok: true, team: { abb, ...t } });
}

// ── Public payload builder ────────────────────────────────────
function buildPublicPayload() {
  const sorted = Object.entries(state.teams)
    .map(([abb, data]) => ({ abb, ...data }))
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.losses - b.losses;
    });
  return { standings: sorted, results: state.results.slice(0, 10), lastUpdated: state.lastUpdated };
}

// ── Main router ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url    = req.url.split("?")[0];
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") { setCORS(res); res.writeHead(204); return res.end(); }

  if (url === "/" || url === "/health")
    return sendJSON(res, 200, { status: "ok", clients: sseClients.size, teams: Object.keys(state.teams).length });

  if (url === "/rpl/standings") {
    if (method === "POST") return handlePostResult(req, res);
    if (method === "GET")  return handleGetStandings(req, res);
  }

  if (url === "/rpl/standings/events" && method === "GET") return handleSSE(req, res);
  if (url === "/rpl/standings/team"   && method === "POST") return handleTeamOverride(req, res);

  sendJSON(res, 404, { error: "Not found" });
});

// ── Boot ──────────────────────────────────────────────────────
loadState().then(() => {
  server.listen(PORT, () => {
    console.log(`[RPL] Server running on port ${PORT}`);
    console.log(`[RPL] Supabase: ${SUPABASE_URL ? "connected" : "NOT configured"}`);
  });
});

server.on("error", err => {
  console.error("[RPL] Server error:", err.message);
  process.exit(1);
});
