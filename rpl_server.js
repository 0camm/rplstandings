/*
  rpl_server.js  —  RPL Standings API Bridge
  ============================================
  Deploy on Render (or any Node host).
  Set environment variables:
    RPL_SECRET       = your-new-secret   (change this!)
    SUPABASE_URL     = https://xxxx.supabase.co
    SUPABASE_KEY     = your anon/service key
*/

"use strict";

const http  = require("http");
const https = require("https");

const PORT         = process.env.PORT         || 3000;
const SECRET       = process.env.RPL_SECRET   || "CHANGE_ME"; // set via env var, never hardcode
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

// Store and serve the same number — no more storing 20 and serving 10
const RESULTS_MAX  = 10;

let state = {
  teams:       {},
  results:     [],
  lastUpdated: null,
};

const sseClients = new Set();

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

// ── Supabase ──────────────────────────────────────────────────
function supabaseRequest(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    if (!SUPABASE_URL) return resolve({ status: 0, body: {} });
    const parsed = new URL(SUPABASE_URL);
    const bodyStr = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsed.hostname,
      path: `/rest/v1/${path}`,
      method,
      headers: {
        "Content-Type":  "application/json",
        "apikey":        SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        ...extraHeaders,
      },
    };

    if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const req = https.request(options, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        console.log(`[RPL] Supabase ${method} ${path} → ${res.statusCode}`);
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on("error", e => {
      console.error("[RPL] Supabase request error:", e.message);
      reject(e);
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function loadState() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn("[RPL] No Supabase config — starting empty.");
    return;
  }
  try {
    const { body } = await supabaseRequest("GET", "rpl_state?select=key,value", null);
    if (Array.isArray(body)) {
      for (const row of body) {
        if (row.key === "teams")       state.teams       = row.value;
        if (row.key === "results")     state.results     = row.value;
        if (row.key === "lastUpdated") state.lastUpdated = row.value;
      }
      console.log("[RPL] Loaded from Supabase:", Object.keys(state.teams).length, "teams");
    }
  } catch (e) {
    console.error("[RPL] loadState error:", e.message);
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
    await supabaseRequest("POST", "rpl_state", rows, {
      "Prefer": "resolution=merge-duplicates,return=representation",
    });
  } catch (e) {
    console.error("[RPL] saveState error:", e.message);
  }
}

// ── Auth ──────────────────────────────────────────────────────
function isAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === SECRET;
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("secret") === SECRET;
}

// ── Team helpers ──────────────────────────────────────────────
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
  state.teams[loserABB].streak  = updateStreak(state.teams[loserABB].streak, false);
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
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// ── CORS + JSON ───────────────────────────────────────────────
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

// ── Duplicate / double-result guard ───────────────────────────
const GAME_SESSION_WINDOW = 5 * 60 * 1000; // 5 minutes
const recentTerminalGames = new Map();

function makeMatchupKey(homeABB, awayABB) {
  return [homeABB, awayABB].sort().join("|");
}

function isTerminalStatus(status) {
  return status === "final" || status === "forfeit";
}

function isDuplicateTerminal(homeABB, awayABB, status) {
  if (!isTerminalStatus(status)) return false;
  const key = makeMatchupKey(homeABB, awayABB);
  const last = recentTerminalGames.get(key);
  if (!last) return false;
  return (Date.now() - last) < GAME_SESSION_WINDOW;
}

function markTerminal(homeABB, awayABB, status) {
  if (!isTerminalStatus(status)) return;
  const key = makeMatchupKey(homeABB, awayABB);
  recentTerminalGames.set(key, Date.now());
  setTimeout(() => recentTerminalGames.delete(key), GAME_SESSION_WINDOW);
}

// ── Routes ────────────────────────────────────────────────────
async function handlePostResult(req, res) {
  if (!isAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const {
    status, homeABB, awayABB, homeLogo, awayLogo, homeScore, awayScore,
    winnerABB, quarter, note, season, timestamp, playerOfGame,
    homeStats, awayStats,
    referees, // ← now accepted from Roblox
  } = body;

  if (!homeABB || !awayABB || !status)
    return sendJSON(res, 422, { error: "Missing required fields" });

  // 30-second exact-duplicate guard
  const now30 = Date.now();
  const exactDupe = state.results.find(r => {
    const age = now30 - new Date(r.timestamp).getTime();
    return age < 30000 && r.homeABB === homeABB && r.awayABB === awayABB && r.status === status;
  });
  if (exactDupe) return sendJSON(res, 200, { ok: true, duplicate: true });

  // Cross-status duplicate guard
  if (isDuplicateTerminal(homeABB, awayABB, status)) {
    console.log(`[RPL] Blocked duplicate terminal result: ${awayABB} @ ${homeABB} | ${status}`);
    return sendJSON(res, 200, { ok: true, duplicate: true, reason: "terminal_already_recorded" });
  }

  ensureTeam(homeABB, homeLogo);
  ensureTeam(awayABB, awayLogo);

  if (isTerminalStatus(status) && winnerABB) {
    const loserABB = winnerABB === homeABB ? awayABB : homeABB;
    updateRecord(winnerABB, loserABB);
    markTerminal(homeABB, awayABB, status);
  }

  const result = {
    id: Date.now(), timestamp: timestamp || new Date().toISOString(),
    season: season || "Season 11", status, quarter: quarter || "---", note: note || "",
    homeABB, awayABB, homeLogo: homeLogo || "", awayLogo: awayLogo || "",
    homeScore: homeScore ?? 0, awayScore: awayScore ?? 0,
    winnerABB: winnerABB || null, playerOfGame: playerOfGame || null,
    referees: referees || "None", // stored alongside result
    homeStats: homeStats || [], awayStats: awayStats || [],
  };

  state.results.unshift(result);
  if (state.results.length > RESULTS_MAX) state.results.length = RESULTS_MAX;
  state.lastUpdated = new Date().toISOString();

  await saveState();
  broadcast("standings", buildPublicPayload());
  broadcast("result", result);

  console.log(`[RPL] Result saved: ${awayABB} @ ${homeABB} | ${status} | refs: ${result.referees}`);
  return sendJSON(res, 200, { ok: true, result });
}

function handleGetStandings(req, res) {
  setCORS(res);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(buildPublicPayload()));
}

function handleSSE(req, res) {
  setCORS(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`event: standings\ndata: ${JSON.stringify(buildPublicPayload())}\n\n`);
  sseClients.add(res);

  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); }
    catch (_) { clearInterval(heartbeat); sseClients.delete(res); }
  }, 25000);

  req.on("close", () => { clearInterval(heartbeat); sseClients.delete(res); });
}

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

  console.log(`[RPL] Team override: ${abb} → ${t.wins}W-${t.losses}L logo=${t.logo ? '✓' : '—'}`);
  return sendJSON(res, 200, { ok: true, team: { abb, ...t } });
}

function buildPublicPayload() {
  const sorted = Object.entries(state.teams)
    .map(([abb, data]) => ({ abb, ...data }))
    .sort((a, b) => {
      const pctA = parseFloat(a.pct) || 0;
      const pctB = parseFloat(b.pct) || 0;
      if (pctB !== pctA) return pctB - pctA;
      const gpA = a.wins + a.losses;
      const gpB = b.wins + b.losses;
      if (gpB !== gpA) return gpB - gpA;
      return b.wins - a.wins;
    });
  // Serve all stored results — consistent with RESULTS_MAX
  return { standings: sorted, results: state.results, lastUpdated: state.lastUpdated };
}

// ── Router ────────────────────────────────────────────────────
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

server.on("error", err => { console.error("[RPL] Server error:", err.message); process.exit(1); });
