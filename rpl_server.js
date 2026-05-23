/*
  rpl_server.js  —  RPL Standings API Bridge
  ============================================
  Deploy on Railway (or any Node host).
  Set environment variable:  RPL_SECRET = RPLSTANDINGS$

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
const fs    = require("fs");
const path  = require("path");

// ── Config ────────────────────────────────────────────────────
const PORT        = process.env.PORT        || 3000;
const SECRET      = process.env.RPL_SECRET  || "RPLSTANDINGS$";
const DATA_FILE = process.env.DATA_FILE || path.join("/data", "standings.json");
const RESULTS_MAX = 20;   // keep last N game results

// ── In-memory state (persisted to standings.json) ─────────────
let state = {
  teams:   {},   // { "LAL": { wins:0, losses:0, pct:"0.000", streak:"—", logo:"" }, … }
  results: [],   // last N game result objects
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

// ── Persistence ───────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        state = { teams: {}, results: [], lastUpdated: null, ...parsed };
        console.log("[RPL] Loaded standings from disk:", Object.keys(state.teams).length, "teams,", state.results.length, "results");
      }
    }
  } catch (e) {
    console.error("[RPL] Failed to load standings.json:", e.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("[RPL] Failed to save standings.json:", e.message);
  }
}

// ── Auth helper ───────────────────────────────────────────────
function isAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) {
    return auth.slice(7) === SECRET;
  }
  // Also accept as query param for easy testing
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

  state.teams[winnerABB].wins   += 1;
  state.teams[loserABB].losses  += 1;

  // Streak
  state.teams[winnerABB].streak = updateStreak(state.teams[winnerABB].streak, true);
  state.teams[loserABB].streak  = updateStreak(state.teams[loserABB].streak,  false);

  // PCT
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
    status,       // "final" | "forfeit" | "incomplete"
    homeABB, awayABB,
    homeLogo, awayLogo,
    homeScore, awayScore,
    winnerABB,
    quarter,
    note,
    season,
    timestamp,
    playerOfGame,
    homeStats,
    awayStats,
  } = body;

  // Validate minimum fields
  if (!homeABB || !awayABB || !status) {
    return sendJSON(res, 422, { error: "Missing required fields: homeABB, awayABB, status" });
  }

  // Ensure teams exist in standings
  ensureTeam(homeABB, homeLogo);
  ensureTeam(awayABB, awayLogo);

  // Update W/L only for conclusive results
  if (status === "final" || status === "forfeit") {
    if (winnerABB) {
      const loserABB = winnerABB === homeABB ? awayABB : homeABB;
      updateRecord(winnerABB, loserABB);
    }
  }

  // Prepend to results list
  const result = {
    id:           Date.now(),
    timestamp:    timestamp || new Date().toISOString(),
    season:       season    || "Season 10",
    status,
    quarter:      quarter   || "---",
    note:         note      || "",
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

  saveState();

  // Push to all open SSE connections instantly
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
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Send current state immediately
  res.write(`event: standings\ndata: ${JSON.stringify(buildPublicPayload())}\n\n`);

  sseClients.add(res);
  console.log(`[RPL] SSE client connected (${sseClients.size} total)`);

  // Heartbeat every 25 s
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
  if (wins    !== undefined) t.wins    = Math.max(0, parseInt(wins,    10) || 0);
  if (losses  !== undefined) t.losses  = Math.max(0, parseInt(losses,  10) || 0);
  if (streak  !== undefined) t.streak  = streak;
  if (logo    !== undefined) t.logo    = logo;

  const total = t.wins + t.losses;
  t.pct = total > 0 ? (t.wins / total).toFixed(3) : "0.000";

  state.lastUpdated = new Date().toISOString();
  saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RPL] Manual override: ${abb} → ${t.wins}W-${t.losses}L`);
  return sendJSON(res, 200, { ok: true, team: { abb, ...t } });
}

// ── Public payload builder ─────────────────────────────────────
function buildPublicPayload() {
  // Sort teams by wins desc, then by losses asc
  const sorted = Object.entries(state.teams)
    .map(([abb, data]) => ({ abb, ...data }))
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.losses - b.losses;
    });

  return {
    standings:   sorted,
    results:     state.results.slice(0, 10),
    lastUpdated: state.lastUpdated,
  };
}

// ── Main router ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url    = req.url.split("?")[0];
  const method = req.method.toUpperCase();

  // OPTIONS preflight
  if (method === "OPTIONS") {
    setCORS(res);
    res.writeHead(204);
    return res.end();
  }

  // Health check
  if (url === "/" || url === "/health") {
    return sendJSON(res, 200, { status: "ok", clients: sseClients.size, teams: Object.keys(state.teams).length });
  }

  // Routes
  if (url === "/rpl/standings") {
    if (method === "POST") return handlePostResult(req, res);
    if (method === "GET")  return handleGetStandings(req, res);
  }

  if (url === "/rpl/standings/events" && method === "GET") {
    return handleSSE(req, res);
  }

  if (url === "/rpl/standings/team" && method === "POST") {
    return handleTeamOverride(req, res);
  }

  // 404
  sendJSON(res, 404, { error: "Not found" });
});

// ── Boot ──────────────────────────────────────────────────────
loadState();

server.listen(PORT, () => {
  console.log(`[RPL] Server running on port ${PORT}`);
  console.log(`[RPL] Secret key: ${SECRET.slice(0, 4)}${"*".repeat(SECRET.length - 4)}`);
  console.log(`[RPL] Data file:  ${DATA_FILE}`);
});

server.on("error", err => {
  console.error("[RPL] Server error:", err.message);
  process.exit(1);
});
