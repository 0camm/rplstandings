/**
 * RPL Standings API Server
 * ─────────────────────────────────────────────────────────────
 * A minimal Node.js server (no framework required) that:
 *   • Accepts POST  /rpl/standings   from the Roblox Script
 *   • Serves  GET   /rpl/standings   to the HTML page
 *   • Streams GET   /rpl/standings/events  (SSE) for instant refresh
 *
 * Setup:
 *   1. node server.js                 (port 3000 by default)
 *   2. Deploy on Railway / Render / Fly.io / any Node host
 *   3. Set STANDINGS_API_URL in both the Lua module and the HTML
 *      to https://your-host.com/rpl/standings
 *   4. Set SECRET_KEY below (same value in Lua CONFIG.SECRET_KEY)
 *
 * No database needed — data is stored in memory and persisted to
 * standings.json on disk so it survives restarts.
 */

const http  = require("http");
const fs    = require("fs");
const path  = require("path");
const PORT  = process.env.PORT || 3000;

// ── Auth ─────────────────────────────────────────────────────
const SECRET_KEY = process.env.RPL_SECRET || "";  // "" = no auth

// ── Persistence file ─────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "standings.json");

// ── In-memory state ──────────────────────────────────────────
let state = {
  lastUpdated : null,
  recentGames : [],      // newest-first, capped at 10
  standings   : {
    eastern : [],
    western : [],
  },
};

// Load persisted data on startup
if (fs.existsSync(DATA_FILE)) {
  try {
    state = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    console.log("[RPL] Loaded standings from disk.");
  } catch (e) {
    console.warn("[RPL] Could not parse standings.json, starting fresh.", e.message);
  }
}

function persist() {
  fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), () => {});
}

// ── SSE clients ──────────────────────────────────────────────
const sseClients = new Set();

function broadcastUpdate() {
  for (const res of sseClients) {
    try { res.write("event: update\ndata: {}\n\n"); } catch (_) {}
  }
}

// ── CORS helper ───────────────────────────────────────────────
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ── Auth check ───────────────────────────────────────────────
function isAuthorized(req) {
  if (!SECRET_KEY) return true;
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${SECRET_KEY}`;
}

// ── Body parser ───────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end",  () => {
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ── Merge a game result into state ───────────────────────────
function applyResult(payload) {
  // Update last-updated timestamp
  state.lastUpdated = payload.timestamp || new Date().toISOString();

  // Push to recentGames (newest first, max 10)
  state.recentGames.unshift({
    homeABB    : payload.homeABB,
    awayABB    : payload.awayABB,
    homeLogo   : payload.homeLogo,
    awayLogo   : payload.awayLogo,
    homeScore  : payload.homeScore,
    awayScore  : payload.awayScore,
    status     : payload.status,
    quarter    : payload.quarter,
    note       : payload.note || "",
    timestamp  : payload.timestamp,
  });
  if (state.recentGames.length > 10) state.recentGames.length = 10;

  // Update standings records if it's a real result
  if (payload.status === "final" && payload.homeABB && payload.awayABB) {
    const homeWin = payload.homeScore > payload.awayScore;
    updateRecord(payload.homeABB, homeWin  ? 1 : 0, homeWin  ? 0 : 1);
    updateRecord(payload.awayABB, !homeWin ? 1 : 0, !homeWin ? 0 : 1);
  }
  // Forfeits: winner gets a win, loser gets a loss
  if (payload.status === "forfeit" && payload.winnerABB) {
    const loserABB = payload.winnerABB === payload.homeABB ? payload.awayABB : payload.homeABB;
    updateRecord(payload.winnerABB, 1, 0);
    updateRecord(loserABB, 0, 1);
  }

  persist();
  broadcastUpdate();
  console.log(`[RPL] Result stored: ${payload.awayABB} @ ${payload.homeABB} — ${payload.status}`);
}

// ── Find or create a team record and update W/L ──────────────
const EASTERN = new Set([
  "ATL","BOS","BKN","CHA","CHI","CLE","DET","IND","MIA","MIL","NYK","ORL","PHI","TOR","WAS"
]);

function updateRecord(abbr, wDelta, lDelta) {
  const confKey = EASTERN.has(abbr) ? "eastern" : "western";
  const list    = state.standings[confKey];
  let team      = list.find(t => t.abbr === abbr);
  if (!team) {
    team = { abbr, name: abbr, w: 0, l: 0, status: "" };
    list.push(team);
  }
  team.w += wDelta;
  team.l += lDelta;
}

// ── HTTP server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);

  // Pre-flight
  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  const url = req.url.split("?")[0];

  // ── GET /rpl/standings/events  (SSE) ──────────────────────
  if (req.method === "GET" && url === "/rpl/standings/events") {
    res.writeHead(200, {
      "Content-Type"  : "text/event-stream",
      "Cache-Control" : "no-cache",
      "Connection"    : "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // ── GET /rpl/standings ────────────────────────────────────
  if (req.method === "GET" && url === "/rpl/standings") {
    const body = JSON.stringify(state);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  // ── POST /rpl/standings ───────────────────────────────────
  if (req.method === "POST" && url === "/rpl/standings") {
    if (!isAuthorized(req)) {
      res.writeHead(401); res.end("Unauthorized"); return;
    }
    try {
      const payload = await readBody(req);
      applyResult(payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error("[RPL] POST parse error:", e.message);
      res.writeHead(400); res.end("Bad JSON");
    }
    return;
  }

  // ── POST /rpl/standings/team  (manual W/L override) ──────
  // Body: { "abbr": "NYK", "w": 12, "l": 4, "status": "x" }
  if (req.method === "POST" && url === "/rpl/standings/team") {
    if (!isAuthorized(req)) {
      res.writeHead(401); res.end("Unauthorized"); return;
    }
    try {
      const payload = await readBody(req);
      if (!payload.abbr) throw new Error("Missing abbr");

      const confKey = EASTERN.has(payload.abbr) ? "eastern" : "western";
      const list    = state.standings[confKey];
      let team      = list.find(t => t.abbr === payload.abbr);
      if (!team) {
        team = { abbr: payload.abbr, name: payload.name || payload.abbr, w: 0, l: 0, status: "" };
        list.push(team);
      }
      if (payload.name   !== undefined) team.name   = payload.name;
      if (payload.w      !== undefined) team.w      = Number(payload.w);
      if (payload.l      !== undefined) team.l      = Number(payload.l);
      if (payload.status !== undefined) team.status = payload.status;

      state.lastUpdated = new Date().toISOString();
      persist();
      broadcastUpdate();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, team }));
    } catch (e) {
      res.writeHead(400); res.end(e.message);
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`[RPL] Standings server running on port ${PORT}`);
  console.log(`[RPL] Auth: ${SECRET_KEY ? "enabled" : "DISABLED — set RPL_SECRET env var"}`);
});
