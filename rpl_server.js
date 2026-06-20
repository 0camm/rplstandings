"use strict";

const http  = require("http");
const https = require("https");

const PORT         = process.env.PORT                              || 3000;
const SECRET       = (process.env.RPL_SECRET   || "").trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || "").trim();
const RESULTS_MAX  = 500;
const ADMIN_SECRET = (process.env.ADMIN_SECRET || "").trim();
const UPSTASH_URL   = (process.env.UPSTASH_URL   || "").trim();
const UPSTASH_TOKEN = (process.env.UPSTASH_TOKEN || "").trim();
const ARCHIVE_KEY   = "rpl-standings-archive";

if (!SECRET || !ADMIN_SECRET) {
  console.error("[RPL] FATAL: RPL_SECRET and ADMIN_SECRET must be set as environment variables. Refusing to start with no/default credentials.");
  process.exit(1);
}

let state = {
  teams:       {},
  results:     [],
  lastUpdated: null,
  auditLog:    [],
  refLog:      [],
};

const sseClients = new Set();

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

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
    req.on("error", e => { console.error("[RPL] Supabase request error:", e.message); reject(e); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function upstashRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return resolve({ status: 0, body: {} });
    const parsed = new URL(`${UPSTASH_URL}${path}`);
    const bodyStr = body !== undefined ? JSON.stringify(body) : null;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        "Authorization": `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type":  "application/json",
      },
    };
    if (bodyStr) options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    const req = https.request(options, res => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", e => { console.error("[RPL] Upstash request error:", e.message); reject(e); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function loadState() {
  if (!SUPABASE_URL || !SUPABASE_KEY) { console.warn("[RPL] No Supabase config — starting empty."); return; }
  try {
    const { body } = await supabaseRequest("GET", "rpl_state?select=key,value", null);
    if (Array.isArray(body)) {
      for (const row of body) {
        if (row.key === "teams")       state.teams       = row.value;
        if (row.key === "results")     state.results     = row.value;
        if (row.key === "lastUpdated") state.lastUpdated = row.value;
        if (row.key === "auditLog")    state.auditLog    = row.value || [];
        if (row.key === "refLog")      state.refLog      = row.value || [];
      }
      console.log("[RPL] Loaded from Supabase:", Object.keys(state.teams).length, "teams");
    }
  } catch (e) { console.error("[RPL] loadState error:", e.message); }
}

async function saveState() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const rows = [
      { key: "teams",       value: state.teams },
      { key: "results",     value: state.results },
      { key: "lastUpdated", value: state.lastUpdated },
      { key: "auditLog",    value: state.auditLog },
      { key: "refLog",      value: state.refLog },
    ];
    await supabaseRequest("POST", "rpl_state", rows, {
      "Prefer": "resolution=merge-duplicates,return=representation",
    });
  } catch (e) { console.error("[RPL] saveState error:", e.message); }
}

function isAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === SECRET;
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("secret") === SECRET;
}

function isAdminAuthorized(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7) === ADMIN_SECRET;
  const url = new URL(req.url, "http://localhost");
  return url.searchParams.get("secret") === ADMIN_SECRET;
}

function rebuildStandings() {
  for (const abb of Object.keys(state.teams)) {
    state.teams[abb].wins = 0;
    state.teams[abb].losses = 0;
    state.teams[abb].pct = "0.000";
    state.teams[abb].streak = "—";
  }
  const ordered = [...state.results].reverse();
  for (const r of ordered) {
    if (r.voided) continue;
    if (!isTerminalStatus(r.status)) continue;
    let winnerABB = r.winnerABB;
    if (!winnerABB && r.status === "final") {
      if (r.homeScore > r.awayScore) winnerABB = r.homeABB;
      else if (r.awayScore > r.homeScore) winnerABB = r.awayABB;
    }
    if (!winnerABB) continue;
    const loserABB = winnerABB === r.homeABB ? r.awayABB : r.homeABB;
    ensureTeam(winnerABB, winnerABB === r.homeABB ? r.homeLogo : r.awayLogo);
    ensureTeam(loserABB,  loserABB  === r.homeABB ? r.homeLogo : r.awayLogo);
    state.teams[winnerABB].wins += 1;
    state.teams[loserABB].losses += 1;
    state.teams[winnerABB].streak = updateStreak(state.teams[winnerABB].streak, true);
    state.teams[loserABB].streak  = updateStreak(state.teams[loserABB].streak, false);
  }
  for (const abb of Object.keys(state.teams)) {
    const t = state.teams[abb];
    const total = t.wins + t.losses;
    t.pct = total > 0 ? (t.wins / total).toFixed(3) : "0.000";
  }
}

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

/* Simple in-memory rate limiter for auth/write endpoints.
   Not distributed (resets on restart, per-instance only) but stops
   naive brute-force / scripted abuse against a single process. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_HITS  = 20;
const rateBuckets = new Map();

function getClientIP(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(req) {
  const ip  = getClientIP(req);
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 5000) {
    for (const [k, v] of rateBuckets) { if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) rateBuckets.delete(k); }
  }
  return bucket.count > RATE_LIMIT_MAX_HITS;
}

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

const GAME_SESSION_WINDOW = 5 * 60 * 1000;
const recentTerminalGames = new Map();

function makeMatchupKey(homeABB, awayABB) { return [homeABB, awayABB].sort().join("|"); }
function isTerminalStatus(status) { return status === "final" || status === "forfeit"; }

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

function parseRefs(refString) {
  if (!refString || refString === "None" || refString === "") return [];
  return refString.split(/[,;\/]/).map(r => r.trim()).filter(r => {
    if (!r) return false;
    if (r.includes(":"))   return false; // Discord emoji format e.g. :notepad_spiral: Note
    if (r.length > 40)     return false; // suspiciously long
    return true;
  });
}

function logRefActivity(refString, gameId, homeABB, awayABB, timestamp) {
  const names = parseRefs(refString);
  const ts = timestamp || new Date().toISOString();
  for (const name of names) {
    state.refLog.unshift({ name, gameId, homeABB, awayABB, timestamp: ts });
  }
  if (state.refLog.length > 5000) state.refLog.length = 5000;
}

function buildRefStats() {
  const map = {};
  // Derive from results (source of truth — covers all historical games)
  for (const result of [...state.results].reverse()) {
    const names = parseRefs(result.referees);
    for (const name of names) {
      if (!map[name]) map[name] = { name, games: 0, lastActive: null, recentGames: [] };
      const r = map[name];
      r.games += 1;
      if (!r.lastActive || result.timestamp > r.lastActive) r.lastActive = result.timestamp;
      if (r.recentGames.length < 5) r.recentGames.push({ gameId: result.id, homeABB: result.homeABB, awayABB: result.awayABB, timestamp: result.timestamp });
    }
  }
  return Object.values(map).sort((a, b) => b.games - a.games || b.lastActive.localeCompare(a.lastActive));
}

function handleGetRefs(req, res) {
  return sendJSON(res, 200, { refs: buildRefStats(), lastUpdated: state.lastUpdated });
}

function handleAuth(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  return sendJSON(res, 200, { ok: true });
}

async function handlePostResult(req, res) {
  if (!isAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const {
    status, homeABB, awayABB, homeLogo, awayLogo, homeScore, awayScore,
    winnerABB, quarter, note, season, timestamp, playerOfGame,
    homeStats, awayStats, referees,
  } = body;

  if (!homeABB || !awayABB || !status)
    return sendJSON(res, 422, { error: "Missing required fields" });

  const now30 = Date.now();
  const exactDupe = state.results.find(r => {
    const age = now30 - new Date(r.timestamp).getTime();
    return age < 30000 && r.homeABB === homeABB && r.awayABB === awayABB && r.status === status;
  });
  if (exactDupe) return sendJSON(res, 200, { ok: true, duplicate: true });

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
    referees: referees || "None",
    homeStats: homeStats || [], awayStats: awayStats || [],
  };

  state.results.unshift(result);
  if (state.results.length > RESULTS_MAX) state.results.length = RESULTS_MAX;
  state.lastUpdated = new Date().toISOString();

  logRefActivity(result.referees, result.id, homeABB, awayABB, result.timestamp);

  await saveState();
  broadcast("standings", buildPublicPayload());
  broadcast("result", result);

  console.log(`[RPL] Result saved: ${awayABB} @ ${homeABB} | ${status} | refs: ${result.referees}`);
  return sendJSON(res, 200, { ok: true, result });
}

async function handleVoidResult(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { id, voided } = body;
  if (id === undefined) return sendJSON(res, 422, { error: "Missing result id" });

  const result = state.results.find(r => r.id === id);
  if (!result) return sendJSON(res, 404, { error: "Result not found" });

  result.voided = !!voided;
  state.lastUpdated = new Date().toISOString();

  const action = voided ? "voided" : "unvoided";
  state.auditLog.unshift({
    action,
    gameId:    result.id,
    matchup:   `${result.awayABB} @ ${result.homeABB}`,
    score:     `${result.awayScore}–${result.homeScore}`,
    status:    result.status,
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  rebuildStandings();
  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RPL] Result ${action}: ${result.awayABB} @ ${result.homeABB} | id=${id}`);
  return sendJSON(res, 200, { ok: true, action, result });
}

async function handleRemoveResult(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { id } = body;
  if (id === undefined) return sendJSON(res, 422, { error: "Missing result id" });

  const idx = state.results.findIndex(r => r.id === id);
  if (idx === -1) return sendJSON(res, 404, { error: "Result not found" });

  const removed = state.results.splice(idx, 1)[0];
  state.lastUpdated = new Date().toISOString();

  state.auditLog.unshift({
    action:    "removed",
    gameId:    removed.id,
    matchup:   `${removed.awayABB} @ ${removed.homeABB}`,
    score:     `${removed.awayScore}–${removed.homeScore}`,
    status:    removed.status,
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  rebuildStandings();
  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log(`[RPL] Result removed: ${removed.awayABB} @ ${removed.homeABB} | id=${id}`);
  return sendJSON(res, 200, { ok: true, removed });
}

async function handleReset(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });

  state.teams       = {};
  state.results     = [];
  state.lastUpdated = new Date().toISOString();
  state.auditLog.unshift({
    action:    "reset",
    gameId:    null,
    matchup:   "ALL",
    score:     "—",
    status:    "reset",
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  await saveState();
  broadcast("standings", buildPublicPayload());

  console.log("[RPL] Full standings reset.");
  return sendJSON(res, 200, { ok: true });
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

  console.log(`[RPL] Team override: ${abb} → ${t.wins}W-${t.losses}L logo=${t.logo ? "✓" : "—"}`);
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
  return { standings: sorted, results: state.results, lastUpdated: state.lastUpdated };
}

async function handleAddGame(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  let body;
  try { body = await readBody(req); }
  catch (e) { return sendJSON(res, 400, { error: "Bad JSON" }); }

  const { homeABB, awayABB, homeScore, awayScore, status, quarter, note, season, timestamp } = body;
  if (!homeABB || !awayABB || !status)
    return sendJSON(res, 422, { error: "Missing required fields: homeABB, awayABB, status" });

  const safeStatus = ["final", "forfeit", "incomplete"].includes(status) ? status : "final";
  const hs  = parseInt(homeScore, 10) || 0;
  const as_ = parseInt(awayScore, 10) || 0;

  ensureTeam(homeABB);
  ensureTeam(awayABB);

  let winnerABB = null;
  if (isTerminalStatus(safeStatus)) {
    if (hs > as_)       winnerABB = homeABB;
    else if (as_ > hs)  winnerABB = awayABB;
    if (winnerABB) {
      const loserABB = winnerABB === homeABB ? awayABB : homeABB;
      updateRecord(winnerABB, loserABB);
    }
  }

  const result = {
    id:           Date.now(),
    timestamp:    timestamp || new Date().toISOString(),
    season:       season || "Season 11",
    status:       safeStatus,
    quarter:      quarter || "---",
    note:         note || "",
    homeABB,      awayABB,
    homeLogo:     "",
    awayLogo:     "",
    homeScore:    hs,
    awayScore:    as_,
    winnerABB,
    playerOfGame: null,
    referees:     "None",
    homeStats:    [],
    awayStats:    [],
    manualEntry:  true,
  };

  state.results.unshift(result);
  if (state.results.length > RESULTS_MAX) state.results.length = RESULTS_MAX;
  state.lastUpdated = new Date().toISOString();

  state.auditLog.unshift({
    action:    "added",
    gameId:    result.id,
    matchup:   `${awayABB} @ ${homeABB}`,
    score:     `${as_}–${hs}`,
    status:    safeStatus,
    timestamp: new Date().toISOString(),
  });
  if (state.auditLog.length > 200) state.auditLog.length = 200;

  logRefActivity(result.referees, result.id, homeABB, awayABB, result.timestamp);

  await saveState();
  broadcast("standings", buildPublicPayload());
  broadcast("result", result);

  console.log(`[RPL] Manual game added: ${awayABB} @ ${homeABB} | ${safeStatus} | ${as_}–${hs}`);
  return sendJSON(res, 200, { ok: true, result });
}

function handleGetAuditLog(req, res) {
  if (!isAdminAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  return sendJSON(res, 200, { auditLog: state.auditLog || [] });
}

async function handleGetArchive(req, res) {
  try {
    const { body } = await upstashRequest("GET", `/get/${ARCHIVE_KEY}`);
    const data = body && body.result ? JSON.parse(body.result) : null;
    return sendJSON(res, 200, { data });
  } catch (e) {
    return sendJSON(res, 500, { error: "Archive fetch failed" });
  }
}

async function handleSetArchive(req, res) {
  if (!isAuthorized(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  try {
    const payload = await readBody(req);
    await upstashRequest("POST", `/set/${ARCHIVE_KEY}`, { value: JSON.stringify(payload) });
    return sendJSON(res, 200, { ok: true });
  } catch (e) {
    return sendJSON(res, 400, { error: "Invalid request" });
  }
}

const server = http.createServer(async (req, res) => {
  const url    = req.url.split("?")[0];
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") { setCORS(res); res.writeHead(204); return res.end(); }
  if (url === "/" || url === "/health")
    return sendJSON(res, 200, { status: "ok", clients: sseClients.size, teams: Object.keys(state.teams).length });

  if (method === "POST" && isRateLimited(req)) {
    return sendJSON(res, 429, { error: "Too many requests — please slow down." });
  }

  if (url === "/rpl/standings") {
    if (method === "POST") return handlePostResult(req, res);
    if (method === "GET")  return handleGetStandings(req, res);
  }
  if (url === "/rpl/standings/events"   && method === "GET")  return handleSSE(req, res);
  if (url === "/rpl/standings/auth"     && method === "POST") return handleAuth(req, res);
  if (url === "/rpl/standings/void"     && method === "POST") return handleVoidResult(req, res);
  if (url === "/rpl/standings/remove"   && method === "POST") return handleRemoveResult(req, res);
  if (url === "/rpl/standings/reset"    && method === "POST") return handleReset(req, res);
  if (url === "/rpl/standings/add"      && method === "POST") return handleAddGame(req, res);
  if (url === "/rpl/standings/auditlog" && method === "GET")  return handleGetAuditLog(req, res);
  if (url === "/rpl/standings/team"     && method === "POST") return handleTeamOverride(req, res);
  if (url === "/rpl/refs"               && method === "GET")  return handleGetRefs(req, res);
  if (url === "/rpl/archive"            && method === "GET")  return handleGetArchive(req, res);
  if (url === "/rpl/archive"            && method === "POST") return handleSetArchive(req, res);

  sendJSON(res, 404, { error: "Not found" });
});

loadState().then(() => {
  server.listen(PORT, () => {
    console.log(`[RPL] Server running on port ${PORT}`);
    console.log(`[RPL] Supabase: ${SUPABASE_URL ? "connected" : "NOT configured"}`);
  });
});

server.on("error", err => { console.error("[RPL] Server error:", err.message); process.exit(1); });
