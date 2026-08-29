// server.js
// Chip War (MSG v2.0) - real-time multiplayer prototype server.
// Stack: Node.js + Express (static hosting) + Socket.io (real-time sync).
// State is in-memory only, per GDD section 1 ("No external database
// required for live gameplay matches").
//
// Optional env var: ANTHROPIC_API_KEY
//   If set, each round's "market shock" (see decideRoundShock below) is
//   generated live by Claude so the flavor text/events never repeat the
//   same fixed pool. If unset, missing, or the API call fails/times out for
//   any reason, the game falls back to a 14-template procedural generator
//   instead - gameplay never blocks on or breaks from this being absent.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const engine = require('./engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/broadcast', (req, res) => res.sendFile(path.join(__dirname, 'public', 'broadcast.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;

// roomCode -> room state object
const rooms = {};
// socket.id -> { roomCode, teamId?, memberId?, role: 'player' | 'host' }
const socketMeta = {};

const NEXT_ROUND_DELAY_MS = 20000; // auto-advance this long after results, host can skip it

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L, easy to read aloud
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? genRoomCode() : code;
}

// ---- Team membership (up to MAX_MEMBERS_PER_TEAM real people sharing one
// company's game state) ------------------------------------------------
function addMember(team, socketId, memberName) {
  const memberId = genId('member');
  const cleanName = (memberName || '').trim().slice(0, 24) || `Member ${team.members.length + 1}`;
  team.members.push({ memberId, socketId, memberName: cleanName, connected: true });
  return memberId;
}
function findMember(team, memberId) {
  return team.members.find((m) => m.memberId === memberId);
}
function findMemberBySocket(team, socketId) {
  return team.members.find((m) => m.socketId === socketId);
}
function teamIsConnected(team) {
  return team.members.some((m) => m.connected);
}

// ---- Team "leader" (GDD extension: team-private + all-teams channels) ----
// No stored/assignable field on purpose - the leader is always just
// "whichever of this team's members is currently connected, earliest in
// the roster" (falling back to the first member at all if nobody's
// connected). That means leadership auto-hands-off the moment the current
// leader disconnects, instead of a classroom negotiation going silent
// because the one person who could speak for the team stepped away.
function getTeamLeader(team) {
  if (!team || !team.members || team.members.length === 0) return null;
  return team.members.find((m) => m.connected) || team.members[0];
}
function isTeamLeader(team, memberId) {
  const leader = getTeamLeader(team);
  return !!leader && !!memberId && leader.memberId === memberId;
}

function createTeamState(teamId, teamName, startingCapital, isBot = false, botStrategy = null) {
  return {
    teamId,
    teamName,
    members: [], // {memberId, socketId, memberName, connected} - up to MAX_MEMBERS_PER_TEAM
    isBot,
    botStrategy,
    chatLog: [], // this team's PRIVATE channel - never broadcast outside its own members
    capital: startingCapital,
    inventory: engine.CONFIG.INITIAL_INVENTORY,
    techLevel: engine.CONFIG.INITIAL_TECH,
    capacityLevel: engine.CONFIG.INITIAL_CAPACITY,
    price: 50,
    quantity: 0,
    locked: false,
    lockOrder: 0,
    lastRoundPrice: 50,
    // Snapshot of levels at the START of the current round + a stack of what
    // was paid for each purchase made THIS round - together these are what
    // let TEAM_UNDO_INVEST reverse only this round's buys, never eating
    // into levels the team already owned before this round began.
    roundStartTechLevel: 0,
    roundStartCapacityLevel: 0,
    techPurchasesThisRound: [],
    capacityPurchasesThisRound: []
  };
}

function createRoom(hostSocketId) {
  const code = genRoomCode();
  rooms[code] = {
    code,
    hostSocketId,
    teams: {},
    round: 0,
    phase: 'lobby', // lobby | round_active | round_results | game_over
    timeLeft: 0,
    paused: false,
    timerHandle: null,
    nextRoundHandle: null,
    marketPrice: 0,
    globalChatLog: [], // the All-Teams channel: every leader (+ HOST) can post, everyone can read
    history: [],
    lockCounter: 0,
    lastActivityAt: Date.now(),
    activeShock: null,
    shockHistory: [],
    lastResultsPayload: null,
    finalPayload: null,
    // Read-only "broadcast" viewers (the classroom-projector screen) - never
    // tied to a team, never see anyone's capital. See SPECTATE_ROOM below.
    spectatorSocketIds: new Set(),
    config: {
      weights: { ...engine.CONFIG.WEIGHTS_DEFAULT },
      demandPerTeam: engine.CONFIG.DEMAND_PER_TEAM,
      roundTimerSeconds: engine.CONFIG.ROUND_TIMER_SECONDS,
      maxTeams: 8,
      startingCapital: engine.CONFIG.INITIAL_CAPITAL, // Starting Budget, default $5,000
      inflationRatePerRound: 0, // compounds onto upgrade costs each round, 0-0.5
      marketVolatility: 1 // scales how far each round's shock swings from neutral, 0.5-2.0
    }
  };
  return rooms[code];
}

// ---- Hidden-information rules (GDD 2.10 / 2.11) --------------------------
// Price, quantity, tech level and capacity level are always public.
// Capital ("cash reserves") is only shown to the owning team and to the host.
function publicTeam(team, viewerTeamId, isPrivileged, room) {
  const showCapital = isPrivileged || team.teamId === viewerTeamId;
  // isLeader is a boolean, never the raw memberId - memberId doubles as the
  // reconnection secret (see JOIN_ROOM), so it must never leave the server
  // for anyone but its own owning socket.
  const leader = getTeamLeader(team);
  return {
    teamId: team.teamId,
    teamName: team.teamName,
    connected: teamIsConnected(team),
    isBot: team.isBot,
    memberCount: team.members.length,
    maxMembers: engine.CONFIG.MAX_MEMBERS_PER_TEAM,
    members: team.members.map((m) => ({ memberName: m.memberName, connected: m.connected, isLeader: !!leader && m === leader })),
    price: team.price,
    quantity: team.quantity,
    techLevel: team.techLevel,
    capacityLevel: team.capacityLevel,
    inventory: team.inventory,
    locked: team.locked,
    nextTechCost: team.techLevel < engine.CONFIG.TECH_MAX ? roomUpgradeCost(room, 'tech', team.techLevel) : null,
    nextCapacityCost: team.capacityLevel < engine.CONFIG.CAPACITY_MAX ? roomUpgradeCost(room, 'capacity', team.capacityLevel) : null,
    canUndoTech: (team.techPurchasesThisRound || []).length > 0,
    canUndoCapacity: (team.capacityPurchasesThisRound || []).length > 0,
    capital: showCapital ? Math.round(team.capital) : null
  };
}

function broadcastState(room) {
  room.lastActivityAt = Date.now();
  const teamList = Object.values(room.teams);
  const effectiveDemandPerTeam = roomDemandPerTeam(room);
  const totalDemand = effectiveDemandPerTeam * teamList.length;
  const preview =
    room.phase === 'round_active'
      ? engine.computeLivePreview({ teams: teamList, weights: roomWeights(room), demandPerTeam: effectiveDemandPerTeam })
      : {};

  teamList.forEach((team) => {
    const connectedMembers = team.members.filter((m) => m.socketId && m.connected);
    if (connectedMembers.length === 0) return;
    const payload = {
      round: room.round,
      totalRounds: engine.CONFIG.ROUNDS,
      phase: room.phase,
      timeLeft: room.timeLeft,
      paused: room.paused,
      marketPrice: room.marketPrice,
      maxPrice: engine.calcMaxPrice(room.marketPrice),
      demandPerTeam: effectiveDemandPerTeam,
      totalDemand,
      shock: publicShock(room.activeShock, false),
      preview: preview[team.teamId] || null,
      teams: teamList.map((t) => publicTeam(t, team.teamId, false, room))
    };
    // Same payload object, fanned out to every device this team currently
    // has connected - any of them can act on it, per the "up to 4 people,
    // one shared company" design. amILeader is the one field that's NOT
    // shared verbatim: it's computed fresh per socket, since exactly one
    // connected member of the team is ever the leader.
    connectedMembers.forEach((m) => io.to(m.socketId).emit('STATE_SYNC', { ...payload, amILeader: isTeamLeader(team, m.memberId) }));
  });

  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit('STATE_SYNC', {
      round: room.round,
      totalRounds: engine.CONFIG.ROUNDS,
      phase: room.phase,
      timeLeft: room.timeLeft,
      paused: room.paused,
      marketPrice: room.marketPrice,
      maxPrice: engine.calcMaxPrice(room.marketPrice),
      demandPerTeam: effectiveDemandPerTeam,
      totalDemand,
      shock: publicShock(room.activeShock, true),
      teams: teamList.map((t) => publicTeam(t, null, true, room))
    });
  }

  // Broadcast/spectator view (the shared projector screen): same shape a
  // regular player already sees for every OTHER team - no capital, no
  // privileged host fields. viewerTeamId=null + isPrivileged=false is
  // exactly that "public only" case publicTeam() already implements, so
  // this is the same trust boundary as the live ticker, just fanned out to
  // sockets that aren't on any team.
  if (room.spectatorSocketIds && room.spectatorSocketIds.size) {
    const spectatorPayload = {
      round: room.round,
      totalRounds: engine.CONFIG.ROUNDS,
      phase: room.phase,
      timeLeft: room.timeLeft,
      paused: room.paused,
      marketPrice: room.marketPrice,
      demandPerTeam: effectiveDemandPerTeam,
      totalDemand,
      shock: publicShock(room.activeShock, false),
      teams: teamList.map((t) => publicTeam(t, null, false, room))
    };
    room.spectatorSocketIds.forEach((sid) => io.to(sid).emit('STATE_SYNC', spectatorPayload));
  }
}

function broadcastLobby(room) {
  room.lastActivityAt = Date.now();
  const payload = {
    roomCode: room.code,
    config: room.config,
    phase: room.phase,
    teams: Object.values(room.teams).map((t) => {
      const leader = getTeamLeader(t);
      return {
        teamId: t.teamId,
        teamName: t.teamName,
        connected: teamIsConnected(t),
        isBot: t.isBot,
        memberCount: t.members.length,
        maxMembers: engine.CONFIG.MAX_MEMBERS_PER_TEAM,
        members: t.members.map((m) => ({ memberName: m.memberName, connected: m.connected, isLeader: !!leader && m === leader }))
      };
    })
  };
  io.to(room.code).emit('LOBBY_UPDATE', payload);
}

// ---- Market Shocks: "오점 1" fix -------------------------------------------
// Every round gets exactly one shock, decided in decideRoundShock(). AI is
// tried first (if configured); engine.pickProceduralShock() is the always-
// available fallback, so this feature can never take the game down.

function publicShock(shock, detailed) {
  if (!shock) return null;
  const base = { title: shock.title, categoryTag: shock.categoryTag, description: shock.description, source: shock.source, impact: engine.summarizeShockImpact(shock.effects) };
  return detailed ? { ...base, effects: shock.effects } : base;
}

// Small per-room wrappers so call sites don't have to remember to pass
// room.config.weights + room.activeShock into engine.js every time.
//
// "Market Volatility" (Advanced Setting, default 1.0x) scales how far every
// shock effect deviates from "no change" (1.0) - it's how "물가상승률/소비자
// 감수성/광고 효율성 같은 외부 변수의 난이도" turned into ONE well-defined
// dial instead of three underspecified ones: at 0.5x a shock that would have
// been "-40% Capacity" becomes "-20%"; at 2.0x it becomes "-80%". 1.0x = the
// shock plays out exactly as generated.
function getVolatilityAdjustedShock(room) {
  const shock = room.activeShock;
  const v = room.config.marketVolatility != null ? room.config.marketVolatility : 1;
  if (!shock || v === 1) return shock;
  const dev = (x) => 1 + ((x != null ? x : 1) - 1) * v;
  const b = shock.effects.weightBias || {};
  return {
    ...shock,
    effects: {
      capacityProductionMultiplier: dev(shock.effects.capacityProductionMultiplier),
      techUpgradeCostMultiplier: dev(shock.effects.techUpgradeCostMultiplier),
      capacityUpgradeCostMultiplier: dev(shock.effects.capacityUpgradeCostMultiplier),
      demandMultiplier: dev(shock.effects.demandMultiplier),
      weightBias: { price: dev(b.price), tech: dev(b.tech), capacity: dev(b.capacity) }
    }
  };
}

function roomWeights(room) {
  return engine.getEffectiveWeights(room.config.weights, getVolatilityAdjustedShock(room));
}
function roomDemandPerTeam(room) {
  return engine.getEffectiveDemandPerTeam(room.config.demandPerTeam, getVolatilityAdjustedShock(room));
}
function roomCostMultiplier(room, kind) {
  return engine.getCostMultiplier(getVolatilityAdjustedShock(room), kind);
}
function roomCapacityProdMultiplier(room) {
  return engine.getCapacityProdMultiplier(getVolatilityAdjustedShock(room));
}
// The ONE place that decides what a team's next Tech/Capacity upgrade
// actually costs: engine's 1.5x-per-purchase curve, compounded by this
// room's inflation rate (per round elapsed) and this round's shock. Used
// both to charge the team AND to show them the true number beforehand.
function roomUpgradeCost(room, kind, currentLevel) {
  const base = engine.calcUpgradeCost(kind, currentLevel);
  const inflationRate = room.config.inflationRatePerRound || 0;
  const roundsElapsed = Math.max(0, room.round - 1);
  const inflationFactor = Math.pow(1 + inflationRate, roundsElapsed);
  const shockFactor = roomCostMultiplier(room, kind);
  return Math.max(1, Math.round(base * inflationFactor * shockFactor));
}

const SHOCK_SCHEMA_HINT = `Respond with ONLY one JSON object - no markdown fences, no commentary before or after - shaped exactly like this:
{
  "title": "short punchy name, max 6 words, no emoji",
  "description": "ONE plain sentence, under 140 characters, shaped exactly like 'A war broke out, so tanks are more needed and umbrellas are less useful' - a real-world-sounding cause, a comma, then 'so <plain consequence>'. Write it for a reader who has never taken an economics class and will read it exactly once. The ONLY game words allowed are Price, Tech, Capacity, Apple, and chips - do not use words like multiplier, elasticity, margin, valuation, efficiency, capex, weight, or any other finance/economics jargon. No emoji, no cutesy language.",
  "effects": {
    "capacityProductionMultiplier": number 0.5-1.5 (1 = no change; below 1 hurts teams who invested in Capacity, above 1 helps them),
    "techUpgradeCostMultiplier": number 0.5-2.0 (1 = no change),
    "capacityUpgradeCostMultiplier": number 0.5-2.0 (1 = no change),
    "demandMultiplier": number 0.6-1.8 (1 = no change; scales how many chips Apple buys this round),
    "weightBias": { "price": number 0.5-2.0, "tech": number 0.5-2.0, "capacity": number 0.5-2.0 } (1 = no change each; how much MORE that factor counts in Apple's purchase decision this round)
  }
}
Omit any effect field you don't want to change. Most good shocks touch only 1-2 fields, not all five at once.`;

function buildShockPrompt(room) {
  const teams = Object.values(room.teams);
  const avg = (fn) => (teams.length ? (teams.reduce((s, t) => s + fn(t), 0) / teams.length).toFixed(1) : '0');
  const recent = (room.shockHistory || []).slice(-5).map((s) => s.title);
  return `You are the "market shock" generator for a classroom economics game called Chip War. ${teams.length} teams compete to sell chips to Apple over ${engine.CONFIG.ROUNDS} rounds by setting a Price and investing in Tech level (0-5) and Capacity level (0-5).

This is round ${room.round} of ${engine.CONFIG.ROUNDS}.
Current match snapshot: average Tech level ${avg((t) => t.techLevel)}/5, average Capacity level ${avg((t) => t.capacityLevel)}/5, average price $${avg((t) => t.price || 0)}.
Shocks used in recent rounds - invent something different from these, do not reuse them: ${recent.length ? recent.join(', ') : '(none yet)'}.

Invent ONE fresh, plausible market/news event for this round (supply chains, geopolitics, Apple's shifting priorities, engineering talent, trade policy, competitor news, consumer demand, etc). Prefer surprising, specific flavor over a generic reused idea. If the snapshot above suggests most teams are leaning on one strategy (e.g. everyone maxed Capacity, or everyone priced very low), you may - but don't always have to - pick an event that makes that specific strategy riskier this round, so no single build order is safe to repeat every match.

${SHOCK_SCHEMA_HINT}`;
}

async function generateAIShock(room) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        temperature: 1,
        messages: [{ role: 'user', content: buildShockPrompt(room) }]
      }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = (data.content || [])
      .map((block) => (block && block.type === 'text' ? block.text : ''))
      .join('')
      .trim();
    return engine.parseShockResponseText(text);
  } catch (err) {
    return null; // network error, timeout, malformed JSON - any failure just means "no AI shock this round"
  } finally {
    clearTimeout(timer);
  }
}

async function decideRoundShock(room) {
  const aiShock = await generateAIShock(room).catch(() => null);
  if (aiShock) return aiShock;
  const recentTitles = (room.shockHistory || []).slice(-4).map((s) => s.title);
  return engine.pickProceduralShock(recentTitles);
}

// ---- Round lifecycle -------------------------------------------------------

async function startRound(room) {
  if (room.timerHandle) clearInterval(room.timerHandle);
  if (room.nextRoundHandle) clearTimeout(room.nextRoundHandle);

  room.round += 1;
  room.phase = 'round_active'; // set synchronously, before any `await`, so a
  // second trigger (e.g. a host double-click) can't re-enter this function
  // while we're still waiting on the shock decision below.
  room.lockCounter = 0;
  room.paused = false;

  // Let clients show a brief "deciding this round's market shock..." beat
  // instead of looking frozen while decideRoundShock() may be calling out
  // to the Anthropic API (capped at 7s, usually much faster or instant).
  io.to(room.code).emit('ROUND_STARTING', { round: room.round });

  const shock = await decideRoundShock(room);
  room.activeShock = shock;
  room.shockHistory = room.shockHistory || [];
  room.shockHistory.push({ title: shock.title, round: room.round });
  if (room.shockHistory.length > 8) room.shockHistory.shift();

  // Phase 1: Revenue Collection & Production (uses capacity level as it
  // stood at the END of the previous round - this round's investments only
  // pay off in production from next round onward). A capacity-hitting shock
  // (e.g. Supply Chain Crisis) scales the per-level bonus right here.
  const capMultiplier = roomCapacityProdMultiplier(room);
  Object.values(room.teams).forEach((team) => {
    const production = engine.calcProduction(team.capacityLevel, capMultiplier);
    team.inventory += production;
    team.locked = false;
    // Fresh snapshot + ledger for this round's undo support - last round's
    // purchases are already permanent, only THIS round's are reversible.
    team.roundStartTechLevel = team.techLevel;
    team.roundStartCapacityLevel = team.capacityLevel;
    team.techPurchasesThisRound = [];
    team.capacityPurchasesThisRound = [];
    // Default offer = everything you have. Resetting this to 0 every round
    // was a trap: players who only touched the Price field would silently
    // lock in a 0-quantity offer. Defaulting to "offer it all" means doing
    // nothing is still a real (if aggressive) strategy, not an accident.
    team.quantity = team.inventory;
    if (!team.price) team.price = room.marketPrice > 0 ? room.marketPrice : 50;
  });

  room.timeLeft = room.config.roundTimerSeconds;
  io.to(room.code).emit('ROUND_START', {
    round: room.round,
    totalRounds: engine.CONFIG.ROUNDS,
    timeLeft: room.timeLeft,
    shock: publicShock(room.activeShock, false)
  });
  broadcastState(room);
  scheduleBots(room);

  room.timerHandle = setInterval(() => {
    if (room.paused) return;
    room.timeLeft -= 1;
    io.to(room.code).emit('TIMER_TICK', { timeLeft: room.timeLeft });
    if (room.timeLeft <= 0) {
      clearInterval(room.timerHandle);
      resolveRound(room);
    }
  }, 1000);
}

// ---- AI bots (prototype-only convenience, not in the original GDD) -------
// Lets one person load-test or solo-test the full 3-8 team loop without
// needing a full classroom. Each bot commits once, at a random point during
// the round, following one of three simple heuristics mirroring the GDD's
// "Three Strategic Paths".
function scheduleBots(room) {
  Object.values(room.teams)
    .filter((t) => t.isBot)
    .forEach((bot) => {
      const delay = (0.3 + Math.random() * 0.5) * room.config.roundTimerSeconds * 1000;
      setTimeout(() => {
        if (room.phase === 'round_active' && !bot.locked) botAct(room, bot);
      }, delay);
    });
}

function botAct(room, team) {
  const strat = team.botStrategy || 'balanced';
  let budget = Math.max(0, team.capital) * (strat === 'balanced' ? 0.35 : 0.55);
  const priority =
    strat === 'tech' ? ['tech', 'capacity'] : strat === 'capacity' ? ['capacity', 'tech'] : Math.random() < 0.5 ? ['tech', 'capacity'] : ['capacity', 'tech'];

  for (let guard = 0; guard < 10 && budget > 0; guard++) {
    let bought = false;
    for (const kind of priority) {
      const level = kind === 'tech' ? team.techLevel : team.capacityLevel;
      const max = kind === 'tech' ? engine.CONFIG.TECH_MAX : engine.CONFIG.CAPACITY_MAX;
      const cost = roomUpgradeCost(room, kind, level);
      if (budget >= cost && level < max && Math.random() < 0.7) {
        if (kind === 'tech') team.techLevel += 1;
        else team.capacityLevel += 1;
        team.capital -= cost;
        budget -= cost;
        bought = true;
        postActivity(room, team, kind === 'tech' ? 'tech_up' : 'capacity_up', `upgraded ${kind === 'tech' ? 'Tech' : 'Capacity'} to Lv${kind === 'tech' ? team.techLevel : team.capacityLevel}`);
        break;
      }
    }
    if (!bought) break;
  }

  const base = room.marketPrice > 0 ? room.marketPrice : 50;
  const jitter = Math.round(Math.random() * 10 - 5);
  const priceMultiplier = strat === 'tech' ? 1.15 : strat === 'capacity' ? 0.9 : 1.0;
  team.price = Math.max(1, Math.round(base * priceMultiplier + jitter));

  const qtyFraction = strat === 'capacity' ? 1 : strat === 'tech' ? 0.6 : 0.8;
  team.quantity = Math.round(team.inventory * qtyFraction);

  team.locked = true;
  team.lockOrder = ++room.lockCounter;
  postActivity(room, team, 'lock', `locked in — $${team.price} × ${team.quantity} units`);
  broadcastState(room);
  maybeEarlyResolve(room);
}

function maybeEarlyResolve(room) {
  const teams = Object.values(room.teams);
  if (room.phase === 'round_active' && teams.length > 0 && teams.every((t) => t.locked)) {
    if (room.timerHandle) clearInterval(room.timerHandle);
    resolveRound(room);
  }
}

// Phase 5/6/7: Lock In (timeout auto-submit) -> Apple Purchase -> Results
function resolveRound(room) {
  if (room.phase !== 'round_active') return;
  if (room.timerHandle) clearInterval(room.timerHandle);

  // Timeout Auto-Submit Rule: anyone who never locked gets a safe default -
  // last round's price (else current MP, else $50) and quantity 0, so a
  // silent/disconnected team can never crash the round or dump inventory
  // at a stale price by accident.
  Object.values(room.teams).forEach((team) => {
    if (!team.locked) {
      if (!team.price || team.price <= 0) {
        team.price = team.lastRoundPrice || (room.marketPrice > 0 ? room.marketPrice : 50);
      }
      if (team.quantity == null) team.quantity = 0;
      team.locked = true;
      team.lockOrder = ++room.lockCounter;
    }
    // Defensive re-clamp: UPDATE_INPUT already enforces this, but a value
    // carried over from team.lastRoundPrice above could in principle be
    // stale if the ceiling moved since - never let a locked price through
    // above the cap.
    team.price = Math.min(team.price, engine.calcMaxPrice(room.marketPrice));
  });

  const entries = Object.values(room.teams).map((t) => ({
    teamId: t.teamId,
    price: t.price,
    quantity: Math.max(0, Math.min(t.quantity, t.inventory)), // Offer Validation
    techLevel: t.techLevel,
    capacityLevel: t.capacityLevel,
    lockOrder: t.lockOrder
  }));

  const results = engine.resolveApplePurchase({
    teams: entries,
    weights: roomWeights(room),
    demandPerTeam: roomDemandPerTeam(room)
  });
  const newMP = engine.calcMarketPrice(results, room.marketPrice);

  const resultRows = results
    .map((r) => {
      const team = room.teams[r.teamId];
      team.inventory -= r.purchased;
      team.capital += r.revenue;
      team.lastRoundPrice = r.price;
      return {
        teamId: team.teamId,
        teamName: team.teamName,
        price: r.price,
        quantityOffered: entries.find((e) => e.teamId === team.teamId).quantity,
        quantitySold: r.purchased,
        revenue: Math.round(r.revenue),
        unsoldInventory: team.inventory,
        capital: Math.round(team.capital),
        techLevel: team.techLevel,
        capacityLevel: team.capacityLevel,
        competitiveScore: Math.round(r.CS * 10) / 10
      };
    })
    .sort((a, b) => b.revenue - a.revenue);

  room.marketPrice = newMP;
  room.phase = 'round_results';

  const payload = {
    round: room.round,
    totalRounds: engine.CONFIG.ROUNDS,
    marketPrice: newMP,
    results: resultRows,
    isFinalRound: room.round >= engine.CONFIG.ROUNDS,
    shock: publicShock(room.activeShock, false)
  };
  room.history.push(payload);
  room.lastResultsPayload = payload; // so a reconnecting client can be caught up
  io.to(room.code).emit('ROUND_RESULT', payload);
  broadcastState(room);

  if (room.round >= engine.CONFIG.ROUNDS) {
    endGame(room);
  } else {
    room.nextRoundHandle = setTimeout(() => {
      if (room.phase === 'round_results') startRound(room);
    }, NEXT_ROUND_DELAY_MS);
  }
}

function endGame(room) {
  room.phase = 'game_over';
  const teams = Object.values(room.teams)
    .map((t) => ({
      teamId: t.teamId,
      teamName: t.teamName,
      capital: Math.round(t.capital),
      inventory: t.inventory,
      techLevel: t.techLevel,
      capacityLevel: t.capacityLevel,
      companyValue: Math.round(engine.calcCompanyValue(t))
    }))
    .sort((a, b) => b.companyValue - a.companyValue);
  const payload = { leaderboard: teams, winner: teams[0] || null, history: room.history };
  room.finalPayload = payload;
  io.to(room.code).emit('GAME_OVER', payload);
}

function resetRoom(room) {
  if (room.timerHandle) clearInterval(room.timerHandle);
  if (room.nextRoundHandle) clearTimeout(room.nextRoundHandle);
  room.round = 0;
  room.phase = 'lobby';
  room.timeLeft = 0;
  room.paused = false;
  room.marketPrice = 0;
  room.history = [];
  room.lockCounter = 0;
  room.activeShock = null;
  room.shockHistory = [];
  room.lastResultsPayload = null;
  room.finalPayload = null;
  room.globalChatLog = [];
  Object.values(room.teams).forEach((t) => {
    t.capital = room.config.startingCapital;
    t.inventory = engine.CONFIG.INITIAL_INVENTORY;
    t.techLevel = engine.CONFIG.INITIAL_TECH;
    t.capacityLevel = engine.CONFIG.INITIAL_CAPACITY;
    t.price = 50;
    t.quantity = 0;
    t.locked = false;
    t.lastRoundPrice = 50;
    t.chatLog = [];
  });
  broadcastLobby(room);
  broadcastState(room);
}

// ---- Socket.io event wiring (event names match GDD section "5. Host
// Dashboard Specifications" table, plus the extra HOST_*/TEAM_INVEST/
// CHAT_MESSAGE events needed to make the loop actually playable) ----------

// ---- Negotiation channels ---------------------------------------------
// Two independent channels per room:
//  - team.chatLog:        private to one team, any of its members can post
//  - room.globalChatLog:  visible to every team + host; only each team's
//                          current leader (see getTeamLeader) can post as
//                          that team - so "who's actually negotiating
//                          across companies" stays a deliberate, visible
//                          choice instead of a free-for-all.
// Activity/"kill feed" entries (kind: 'system') are auto-posted into the
// SAME global channel by postActivity() below, so every team can see what
// every other team just did without anyone having to type it out.
function postGlobalMessage(room, { name, text, kind, actionType, teamId }) {
  const msg = { id: genId('msg'), channel: 'global', kind: kind || 'chat', name, text, actionType: actionType || null, teamId: teamId || null, at: Date.now() };
  room.globalChatLog.push(msg);
  if (room.globalChatLog.length > 200) room.globalChatLog.shift();
  io.to(room.code).emit('CHAT_MESSAGE', msg);
  return msg;
}
function postActivity(room, team, actionType, text) {
  postGlobalMessage(room, { name: team.teamName, text, kind: 'system', actionType, teamId: team.teamId });
}
function sendChatSync(socketId, room, team) {
  io.to(socketId).emit('CHAT_SYNC', { team: team ? team.chatLog || [] : [], global: room.globalChatLog || [] });
}

io.on('connection', (socket) => {
  socket.on('HOST_CREATE_ROOM', (_payload, cb) => {
    const room = createRoom(socket.id);
    socket.join(room.code);
    socketMeta[socket.id] = { roomCode: room.code, role: 'host' };
    if (typeof cb === 'function') cb({ ok: true, roomCode: room.code, config: room.config, aiEnabled: !!process.env.ANTHROPIC_API_KEY });
  });

  // Lets a host reconnect (e.g. page refresh) without losing the room.
  socket.on('HOST_REJOIN', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });
    room.hostSocketId = socket.id;
    socket.join(room.code);
    socketMeta[socket.id] = { roomCode, role: 'host' };
    cb && cb({ ok: true, roomCode: room.code, config: room.config, aiEnabled: !!process.env.ANTHROPIC_API_KEY });
    broadcastLobby(room);
    broadcastState(room);
    sendChatSync(socket.id, room, null);
    if (room.phase === 'round_results' && room.lastResultsPayload) {
      io.to(socket.id).emit('ROUND_RESULT', room.lastResultsPayload);
    } else if (room.phase === 'game_over' && room.finalPayload) {
      io.to(socket.id).emit('GAME_OVER', room.finalPayload);
    }
  });

  // Read-only: lets the join screen show "who's already in this room" (and
  // how full each team is) BEFORE actually joining anything. Works at any
  // phase - browsing doesn't commit to anything, so it's harmless mid-match.
  socket.on('LOOKUP_ROOM', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });
    cb &&
      cb({
        ok: true,
        phase: room.phase,
        teams: Object.values(room.teams)
          .filter((t) => !t.isBot)
          .map((t) => ({ teamId: t.teamId, teamName: t.teamName, memberCount: t.members.length, maxMembers: engine.CONFIG.MAX_MEMBERS_PER_TEAM }))
      });
  });

  // Read-only "broadcast" join - the classroom-projector screen. No teamId,
  // no host privileges: just a socket that watches the same public state
  // everyone already sees on the live ticker.
  socket.on('SPECTATE_ROOM', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });
    socket.join(room.code);
    socketMeta[socket.id] = { roomCode, role: 'spectator' };
    room.spectatorSocketIds = room.spectatorSocketIds || new Set();
    room.spectatorSocketIds.add(socket.id);
    cb && cb({ ok: true, roomCode: room.code });
    broadcastState(room);
    if (room.phase === 'round_results' && room.lastResultsPayload) {
      io.to(socket.id).emit('ROUND_RESULT', room.lastResultsPayload);
    } else if (room.phase === 'game_over' && room.finalPayload) {
      io.to(socket.id).emit('GAME_OVER', room.finalPayload);
    }
  });

  socket.on('JOIN_ROOM', ({ roomCode, teamName, teamId, memberId, memberName }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });

    function finishJoin(team, mId) {
      socket.join(roomCode);
      socketMeta[socket.id] = { roomCode, teamId: team.teamId, memberId: mId, role: 'player' };
      cb && cb({ ok: true, teamId: team.teamId, memberId: mId, roomCode });
      broadcastLobby(room);
      broadcastState(room);
      sendChatSync(socket.id, room, team);
      // Catch up a (re)joining client on whatever already happened - without
      // this, reconnecting mid/after a round showed an empty results/game-
      // over screen, since those only ever populate from their one-shot
      // events, which a fresh STATE_SYNC doesn't resend.
      if (room.phase === 'round_results' && room.lastResultsPayload) {
        io.to(socket.id).emit('ROUND_RESULT', room.lastResultsPayload);
      } else if (room.phase === 'game_over' && room.finalPayload) {
        io.to(socket.id).emit('GAME_OVER', room.finalPayload);
      }
    }

    if (teamId) {
      const team = room.teams[teamId];
      if (!team) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });

      if (memberId) {
        // Reconnection Session Recovery: same memberId found, restore the socket.
        const member = findMember(team, memberId);
        if (!member) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });
        member.socketId = socket.id;
        member.connected = true;
        return finishJoin(team, member.memberId);
      }

      // Joining an EXISTING team as a brand-new teammate. Allowed at any
      // phase, including mid-match - unlike spawning a whole new team,
      // adding a hand to a company that's already playing doesn't touch
      // production/investment history or game balance.
      if (team.members.length >= engine.CONFIG.MAX_MEMBERS_PER_TEAM) {
        return cb && cb({ ok: false, error: 'TEAM_FULL' });
      }
      const newMemberId = addMember(team, socket.id, memberName);
      return finishJoin(team, newMemberId);
    }

    // Creating a brand-new team - lobby only, same reasoning as above but
    // in reverse: a fresh team has no inventory/investment yet, so it can
    // only start fair at the top of a match.
    if (room.phase !== 'lobby') {
      return cb && cb({ ok: false, error: 'GAME_IN_PROGRESS' });
    }
    if (Object.keys(room.teams).length >= room.config.maxTeams) {
      return cb && cb({ ok: false, error: 'ROOM_FULL' });
    }
    const id = genId('team');
    const base = (teamName || `Team ${Object.keys(room.teams).length + 1}`).trim() || `Team ${Object.keys(room.teams).length + 1}`;
    const taken = new Set(Object.values(room.teams).map((t) => t.teamName));
    let candidate = base;
    let suffix = 1;
    while (taken.has(candidate)) {
      suffix += 1;
      candidate = `${base} ${suffix}`;
    }
    const team = createTeamState(id, candidate, room.config.startingCapital);
    room.teams[id] = team;
    // The join screen only asks the creator for ONE name (the team's), so
    // default their own roster entry to match it unless they separately
    // gave a personal name.
    const newMemberId = addMember(team, socket.id, memberName || candidate);
    finishJoin(team, newMemberId);
  });

  // A player leaving mid-member (this specific person exits their seat -
  // if teammates remain, the company keeps going exactly as before). Now
  // allowed at ANY phase, including mid-round: leaving doesn't touch the
  // team's game state (capital/inventory/price), it just removes one
  // person's seat, so it's no more disruptive than that person simply
  // disconnecting - which was already always allowed.
  socket.on('LEAVE_ROOM', ({ roomCode, teamId, memberId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const team = room.teams[teamId];
    if (!team) return;
    team.members = team.members.filter((m) => m.memberId !== memberId);
    delete socketMeta[socket.id];
    // Only delete the team object itself pre-match, when an empty team has
    // no history/results tied to it yet. Once a match is running, a team
    // that loses its last member just keeps existing in an unmanned state
    // (identical to a fully-disconnected team), so round history, the CSV
    // export, and the leaderboard all stay consistent.
    if (team.members.length === 0 && room.phase === 'lobby') delete room.teams[teamId];
    broadcastLobby(room);
    broadcastState(room);
  });

  // Live typed price/quantity - broadcast immediately so opponents can see
  // (and be bluffed by) it, per the "Real-time visible bluffing" pillar.
  socket.on('UPDATE_INPUT', ({ roomCode, teamId, price, quantity }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const team = room.teams[teamId];
    if (!team || team.locked || room.phase !== 'round_active') return;
    if (price != null) {
      const p = Number(price);
      // Anti-exploit price ceiling: see engine.calcMaxPrice. Clamped here
      // (not just validated) so a submitted value can never exceed it,
      // even from a modified client.
      if (!Number.isNaN(p)) team.price = Math.max(0, Math.min(p, engine.calcMaxPrice(room.marketPrice)));
    }
    if (quantity != null) {
      const q = Number(quantity);
      if (!Number.isNaN(q)) team.quantity = Math.max(0, Math.min(Math.round(q), team.inventory));
    }
    broadcastState(room);
  });

  socket.on('TEAM_INVEST', ({ roomCode, teamId, kind }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const team = room.teams[teamId];
    if (!team || team.locked || room.phase !== 'round_active') return;
    // Debt & Comeback Handling: negative capital from aggressive investment
    // is explicitly allowed, so the only gate here is the level cap.
    if (kind === 'tech' && team.techLevel < engine.CONFIG.TECH_MAX) {
      const cost = roomUpgradeCost(room, 'tech', team.techLevel);
      team.techLevel += 1;
      team.capital -= cost;
      team.techPurchasesThisRound = team.techPurchasesThisRound || [];
      team.techPurchasesThisRound.push(cost);
      postActivity(room, team, 'tech_up', `upgraded Tech to Lv${team.techLevel}`);
    } else if (kind === 'capacity' && team.capacityLevel < engine.CONFIG.CAPACITY_MAX) {
      const cost = roomUpgradeCost(room, 'capacity', team.capacityLevel);
      team.capacityLevel += 1;
      team.capital -= cost;
      team.capacityPurchasesThisRound = team.capacityPurchasesThisRound || [];
      team.capacityPurchasesThisRound.push(cost);
      postActivity(room, team, 'capacity_up', `upgraded Capacity to Lv${team.capacityLevel}`);
    }
    broadcastState(room);
  });

  // Undo one Tech/Capacity purchase made THIS round only - a convenience,
  // not a strategy tool. Once LOCK_IN happens, purchases become permanent
  // (the purchases-this-round ledger gets wiped at the next round start
  // regardless), so there is no way to undo anything from a past round.
  socket.on('TEAM_UNDO_INVEST', ({ roomCode, teamId, kind }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const team = room.teams[teamId];
    if (!team || team.locked || room.phase !== 'round_active') return;
    const ledger = kind === 'tech' ? team.techPurchasesThisRound : team.capacityPurchasesThisRound;
    const roundStartLevel = kind === 'tech' ? team.roundStartTechLevel : team.roundStartCapacityLevel;
    const currentLevel = kind === 'tech' ? team.techLevel : team.capacityLevel;
    if (!ledger || ledger.length === 0 || currentLevel <= roundStartLevel) return;
    const refund = ledger.pop();
    team.capital += refund;
    if (kind === 'tech') team.techLevel -= 1;
    else team.capacityLevel -= 1;
    postActivity(room, team, kind === 'tech' ? 'tech_down' : 'capacity_down', `undid a ${kind === 'tech' ? 'Tech' : 'Capacity'} upgrade (back to Lv${kind === 'tech' ? team.techLevel : team.capacityLevel})`);
    broadcastState(room);
  });

  socket.on('LOCK_IN', ({ roomCode, teamId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const team = room.teams[teamId];
    if (!team || team.locked || room.phase !== 'round_active') return;
    team.locked = true;
    team.lockOrder = ++room.lockCounter;
    postActivity(room, team, 'lock', `locked in — $${team.price} × ${team.quantity} units`);
    broadcastState(room);
    maybeEarlyResolve(room);
  });

  socket.on('CHAT_MESSAGE', ({ roomCode, teamId, channel, text }) => {
    const room = rooms[roomCode];
    if (!room || !text || !String(text).trim()) return;
    const trimmed = String(text).slice(0, 240);
    if (engine.containsProfanity(trimmed)) {
      io.to(socket.id).emit('CHAT_BLOCKED', { reason: 'Message blocked - please keep the chat appropriate.' });
      return;
    }
    const sender = teamId ? room.teams[teamId] : null;

    // ---- Team channel: private to this team, any connected member can post ----
    if (channel === 'team') {
      if (!sender) return; // only real teams have a private channel (not HOST)
      const member = findMemberBySocket(sender, socket.id);
      if (!member) return; // must actually be on this team to post here
      const name = sender.teamName + (sender.members.length > 1 ? ` (${member.memberName})` : '');
      const msg = { id: genId('msg'), channel: 'team', kind: 'chat', name, text: trimmed, at: Date.now() };
      sender.chatLog = sender.chatLog || [];
      sender.chatLog.push(msg);
      if (sender.chatLog.length > 150) sender.chatLog.shift();
      sender.members.forEach((m) => {
        if (m.socketId && m.connected) io.to(m.socketId).emit('CHAT_MESSAGE', msg);
      });
      return;
    }

    // ---- All-Teams (global) channel: HOST always allowed; a player must
    // be their team's CURRENT leader to post - everyone on every team can
    // still read it, per the "leader negotiates, team watches" design. ----
    let name = 'HOST';
    if (sender) {
      const member = findMemberBySocket(sender, socket.id);
      if (!member || !isTeamLeader(sender, member.memberId)) {
        io.to(socket.id).emit('CHAT_BLOCKED', { reason: 'Only your team leader can post in the All Teams channel.' });
        return;
      }
      name = sender.teamName + (sender.members.length > 1 ? ` (${member.memberName})` : '');
    }
    postGlobalMessage(room, { name, text: trimmed, kind: 'chat' });
  });

  socket.on('HOST_UPDATE_CONFIG', ({ roomCode, config }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || !config) return;
    // These two are safe to change mid-match: they're only ever read fresh
    // at the moment they matter (round start / round resolution), so a
    // change here takes effect on the very next thing that reads it - no
    // more "the number changes in the box but never actually applies".
    if (config.demandPerTeam != null) {
      room.config.demandPerTeam = Math.max(1, Number(config.demandPerTeam) || engine.CONFIG.DEMAND_PER_TEAM);
    }
    if (config.roundTimerSeconds != null) {
      room.config.roundTimerSeconds = Math.max(30, Number(config.roundTimerSeconds) || engine.CONFIG.ROUND_TIMER_SECONDS);
    }
    if (config.marketVolatility != null) {
      room.config.marketVolatility = Math.min(2, Math.max(0.5, Number(config.marketVolatility) || 1));
    }
    // Everything else only makes sense before teams start playing with it.
    if (room.phase === 'lobby') {
      if (config.weights) room.config.weights = engine.normalizeWeights(config.weights);
      if (config.maxTeams != null) {
        room.config.maxTeams = Math.min(8, Math.max(3, Number(config.maxTeams) || 8));
      }
      if (config.startingCapital != null) {
        room.config.startingCapital = Math.max(500, Number(config.startingCapital) || engine.CONFIG.INITIAL_CAPITAL);
      }
      if (config.inflationRatePerRound != null) {
        room.config.inflationRatePerRound = Math.min(0.5, Math.max(0, Number(config.inflationRatePerRound) || 0));
      }
    }
    broadcastLobby(room);
    broadcastState(room);
  });

  socket.on('HOST_ADD_BOT', ({ roomCode, strategy }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.phase !== 'lobby') return;
    if (Object.keys(room.teams).length >= room.config.maxTeams) return;
    // Bots keep the chip-company-flavored names on purpose - it's the one
    // place those identities still make sense, now that human teams pick
    // their own plain team name instead of a cosmetic company skin.
    const label = strategy === 'tech' ? 'NVIDIA-Bot' : strategy === 'capacity' ? 'TSMC-Bot' : 'Samsung-Bot';
    const taken = new Set(Object.values(room.teams).map((t) => t.teamName));
    let name = label;
    let n = 1;
    while (taken.has(name)) {
      n += 1;
      name = `${label} ${n}`;
    }
    const id = genId('bot');
    room.teams[id] = createTeamState(id, name, room.config.startingCapital, true, strategy || 'balanced');
    broadcastLobby(room);
    broadcastState(room);
  });

  socket.on('HOST_KICK_TEAM', ({ roomCode, teamId }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    const team = room.teams[teamId];
    if (team) {
      team.members.forEach((m) => {
        if (m.socketId) {
          io.to(m.socketId).emit('KICKED', { reason: 'The host removed you from this room.' });
          delete socketMeta[m.socketId];
        }
      });
    }
    delete room.teams[teamId];
    broadcastLobby(room);
    broadcastState(room);
  });

  // Closes the room outright: every connected player/host gets a heads-up,
  // then the room is wiped from memory. This is the fix for "host removes
  // the room but the player is still stuck in it" - previously there was no
  // explicit close, so a connected client just never heard about it.
  socket.on('HOST_DESTROY_ROOM', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    if (room.timerHandle) clearInterval(room.timerHandle);
    if (room.nextRoundHandle) clearTimeout(room.nextRoundHandle);
    io.to(room.code).emit('ROOM_CLOSED', { reason: 'The host has closed this room.' });
    Object.values(room.teams).forEach((t) => {
      t.members.forEach((m) => {
        if (m.socketId) delete socketMeta[m.socketId];
      });
    });
    if (room.spectatorSocketIds) room.spectatorSocketIds.forEach((sid) => delete socketMeta[sid]);
    delete socketMeta[socket.id];
    delete rooms[roomCode];
  });

  socket.on('HOST_START_GAME', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.phase !== 'lobby') return;
    if (Object.keys(room.teams).length < 3) return; // GDD 2.2: minimum 3 teams
    startRound(room);
  });

  socket.on('HOST_NEXT_ROUND', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.phase !== 'round_results') return;
    startRound(room);
  });

  socket.on('HOST_PAUSE_TIMER', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    room.paused = true;
    broadcastState(room);
  });

  socket.on('HOST_RESUME_TIMER', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    room.paused = false;
    broadcastState(room);
  });

  socket.on('HOST_FORCE_SKIP', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.phase !== 'round_active') return;
    resolveRound(room);
  });

  socket.on('HOST_RESET_GAME', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    resetRoom(room);
  });

  socket.on('disconnect', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;
    const room = rooms[meta.roomCode];
    if (room) {
      if (meta.role === 'player' && meta.teamId && room.teams[meta.teamId]) {
        const team = room.teams[meta.teamId];
        const member = meta.memberId ? findMember(team, meta.memberId) : findMemberBySocket(team, socket.id);
        if (member) {
          member.connected = false;
          member.socketId = null;
        }
        broadcastLobby(room);
        broadcastState(room);
      } else if (meta.role === 'host' && room.hostSocketId === socket.id) {
        room.hostSocketId = null;
      } else if (meta.role === 'spectator' && room.spectatorSocketIds) {
        room.spectatorSocketIds.delete(socket.id);
      }
    }
    delete socketMeta[socket.id];
  });
});

// ---- Many independent hosts, many independent rooms ----------------------
// Nothing extra is needed to support this: every HOST_CREATE_ROOM call runs
// genRoomCode() fresh and adds a brand new entry to `rooms`, keyed by that
// random code. Two hosts on opposite sides of the world calling it at the
// same moment get two different codes and two completely separate game
// states (own teams, own timer, own history) - there is no shared/global
// game anywhere in this file. The only shared thing is server memory, which
// is why the cleanup sweep below matters once this runs 24/7 for strangers.

const STALE_ROOM_MS = 30 * 60 * 1000; // 30 minutes with nobody connected
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach((code) => {
    const room = rooms[code];
    const hostConnected = !!room.hostSocketId;
    const anyPlayerConnected = Object.values(room.teams).some((t) => teamIsConnected(t));
    const idleTooLong = now - room.lastActivityAt > STALE_ROOM_MS;
    if (!hostConnected && !anyPlayerConnected && idleTooLong) {
      if (room.timerHandle) clearInterval(room.timerHandle);
      if (room.nextRoundHandle) clearTimeout(room.nextRoundHandle);
      delete rooms[code];
    }
  });
}, 5 * 60 * 1000); // sweep every 5 minutes

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Chip War (MSG) server running at http://localhost:${PORT}`);
  console.log(`Host dashboard:                 http://localhost:${PORT}/host`);
});
