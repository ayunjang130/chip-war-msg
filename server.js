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
// Third-party assets are served from node_modules instead of a CDN, so a
// school network that blocks jsdelivr/Google Fonts still gets charts and type.
app.use('/vendor/chart', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist')));
app.use('/vendor/fonts/archivo', express.static(path.join(__dirname, 'node_modules', '@fontsource-variable', 'archivo', 'files')));
app.use('/vendor/fonts/plex', express.static(path.join(__dirname, 'node_modules', '@fontsource', 'ibm-plex-mono', 'files')));
// The official guide site lives in its own folder so it can be deployed on
// its own (Netlify, GitHub Pages, ...). It's also served here at /guide so
// the in-game "Game guide" link works out of the box.
app.use('/guide', express.static(path.join(__dirname, 'official-site')));
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
  let cleanName = (memberName || '').trim().slice(0, 24) || `Member ${team.members.length + 1}`;
  // Two teammates can't share a display name - contribution tracking is
  // shown by name, so "Alex" and "Alex" would be unreadable.
  const taken = new Set(team.members.map((m) => m.memberName.toLowerCase()));
  const base = cleanName;
  let n = 1;
  while (taken.has(cleanName.toLowerCase())) {
    n += 1;
    cleanName = `${base} ${n}`;
  }
  team.members.push({ memberId, socketId, memberName: cleanName, connected: true, joinedAt: Date.now(), stats: newContributionStats(), log: [], roundEditPts: 0, roundChatPts: 0 });
  return memberId;
}

// ---- Contribution tracking ------------------------------------------------
// Every game-affecting action is attributed to the specific person who did
// it, so a 4-person team can see (and a teacher can grade) who actually
// drove each decision. Points are only awarded for DISCRETE decisions
// (buying an upgrade, pressing Lock In, being the one whose price/quantity
// was final) plus small, per-round-capped credit for activity (editing,
// chatting) - so spamming the price box or the chat can't farm points.
const CONTRIB_POINTS = Object.freeze({
  finalPrice: 3, // your number was the one locked in
  finalQty: 2,
  upgrade: 4, // each Tech/Capacity purchase that wasn't undone
  lockIn: 3,
  editEach: 0.1, // per actual change to price/quantity...
  editCapPerRound: 2, // ...capped per round
  teamMsg: 0.5,
  globalMsg: 1,
  chatCapPerRound: 3
});
function newContributionStats() {
  return { priceEdits: 0, qtyEdits: 0, finalPrice: 0, finalQty: 0, techBuys: 0, capBuys: 0, investSpent: 0, undos: 0, lockIns: 0, teamMsgs: 0, globalMsgs: 0, editPoints: 0, chatPoints: 0 };
}
function contributionBreakdown(stats) {
  const s = stats || newContributionStats();
  const pricing = s.finalPrice * CONTRIB_POINTS.finalPrice + s.finalQty * CONTRIB_POINTS.finalQty + s.editPoints;
  const investment = (s.techBuys + s.capBuys) * CONTRIB_POINTS.upgrade;
  const execution = s.lockIns * CONTRIB_POINTS.lockIn;
  const communication = s.chatPoints;
  const r = (x) => Math.round(x * 10) / 10;
  return { total: r(pricing + investment + execution + communication), pricing: r(pricing), investment: r(investment), execution: r(execution), communication: r(communication) };
}
function logContribution(room, member, type, text) {
  if (!member) return;
  member.log = member.log || [];
  member.log.push({ round: room.round, type, text, at: Date.now() });
  if (member.log.length > 60) member.log.shift();
}
// Shape sent to clients: stats + breakdown + share-of-team percent. Only
// ever sent to the member's own team, the host, and (at game over) everyone.
function memberContribution(team, member) {
  const mine = contributionBreakdown(member.stats);
  const teamTotal = team.members.reduce((s, m) => s + contributionBreakdown(m.stats).total, 0);
  return {
    ...mine,
    share: teamTotal > 0 ? Math.round((mine.total / teamTotal) * 100) : 0,
    stats: { ...member.stats, investSpent: Math.round(member.stats.investSpent) },
    recent: (member.log || []).slice(-10)
  };
}
function contributionSnapshot(team) {
  return team.members.map((m) => ({ memberName: m.memberName, connected: m.connected, ...memberContribution(team, m) }));
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
    techPurchasesThisRound: [], // [{cost, memberId}] - memberId so an undo un-credits the right person
    capacityPurchasesThisRound: [],
    // Who last changed price / quantity THIS round - whoever it is when the
    // round resolves gets credit for "set the final number".
    lastPriceEditor: null,
    lastQtyEditor: null
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
    // Company-value candles for the broadcast screen: teamId -> [{round, o,
    // h, l, c, sold, revenue}]. round 0 is the "IPO" (starting budget).
    valueCandles: {},
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
function publicTeam(team, viewerTeamId, isPrivileged, room, opts) {
  opts = opts || {};
  const isOwn = team.teamId === viewerTeamId;
  const showCapital = isPrivileged || isOwn;
  // isLeader is a boolean, never the raw memberId - memberId doubles as the
  // reconnection secret (see JOIN_ROOM), so it must never leave the server
  // for anyone but its own owning socket.
  const leader = getTeamLeader(team);
  // Per-person contribution is team-internal: your own team and the host
  // see it, rival teams only see names.
  const showContribution = isPrivileged || isOwn;
  return {
    teamId: team.teamId,
    teamName: team.teamName,
    connected: teamIsConnected(team),
    isBot: team.isBot,
    memberCount: team.members.length,
    maxMembers: engine.CONFIG.MAX_MEMBERS_PER_TEAM,
    members: team.members.map((m) => {
      const base = { memberName: m.memberName, connected: m.connected, isLeader: !!leader && m === leader };
      return showContribution ? { ...base, contribution: memberContribution(team, m) } : base;
    }),
    companyValue: isPrivileged || opts.includeValue ? Math.round(engine.calcCompanyValue(team)) : null,
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
      roundTimerSeconds: room.config.roundTimerSeconds,
      // This round's real scoring weights (config x shock x volatility).
      // Not secret - it's what lets the in-browser analyst run the exact
      // same purchase simulation the server will run.
      weights: roomWeights(room),
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
      weights: roomWeights(room),
      shock: publicShock(room.activeShock, true),
      candles: room.valueCandles,
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
      roomCode: room.code,
      startingCapital: room.config.startingCapital,
      shock: publicShock(room.activeShock, false),
      // Company value is shown on the projector on purpose (it's the
      // headline number of the whole game). Capital itself is still never
      // sent here - and was already reconstructable from public info
      // (starting budget + public revenue - public upgrade costs).
      candles: room.valueCandles,
      teams: teamList.map((t) => publicTeam(t, null, false, room, { includeValue: true }))
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

// ---- Company-value candles (broadcast screen) ---------------------------
// One candle per team per round, like a daily candle on a stock chart:
// open = value when the round opened (= last round's close), then every
// value-changing event (production, upgrade, undo, Apple's purchase) moves
// close/high/low. Red body = closed higher than it opened, blue = lower.
function teamValue(team) {
  return Math.round(engine.calcCompanyValue(team));
}
function initIpoCandles(room) {
  room.valueCandles = {};
  Object.values(room.teams).forEach((t) => {
    const v = teamValue(t);
    room.valueCandles[t.teamId] = [{ round: 0, o: v, h: v, l: v, c: v, sold: 0, revenue: 0 }];
  });
}
function openCandle(room, team) {
  const list = (room.valueCandles[team.teamId] = room.valueCandles[team.teamId] || []);
  const prev = list[list.length - 1];
  const o = prev ? prev.c : teamValue(team);
  list.push({ round: room.round, o, h: o, l: o, c: o, sold: 0, revenue: 0 });
}
function touchCandle(room, team) {
  const list = room.valueCandles[team.teamId];
  if (!list || !list.length) return;
  const c = list[list.length - 1];
  if (c.round !== room.round) return;
  const v = teamValue(team);
  c.c = v;
  c.h = Math.max(c.h, v);
  c.l = Math.min(c.l, v);
}

// ---- Round lifecycle -------------------------------------------------------

async function startRound(room) {
  if (room.timerHandle) clearInterval(room.timerHandle);
  if (room.nextRoundHandle) clearTimeout(room.nextRoundHandle);

  if (room.round === 0) initIpoCandles(room);
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
    openCandle(room, team);
    const production = engine.calcProduction(team.capacityLevel, capMultiplier);
    team.inventory += production;
    team.lastPriceEditor = null;
    team.lastQtyEditor = null;
    team.members.forEach((m) => {
      m.roundEditPts = 0;
      m.roundChatPts = 0;
    });
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
    touchCandle(room, team); // production lands inside this round's candle
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
        touchCandle(room, team);
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

  // Contribution: whoever last touched price / quantity this round owns
  // the number that actually went to Apple.
  Object.values(room.teams).forEach((team) => {
    if (team.isBot) return;
    const pm = team.lastPriceEditor && findMember(team, team.lastPriceEditor);
    if (pm) {
      pm.stats.finalPrice += 1;
      logContribution(room, pm, 'final_price', `Set the final price ($${team.price})`);
    }
    const qm = team.lastQtyEditor && findMember(team, team.lastQtyEditor);
    if (qm) {
      qm.stats.finalQty += 1;
      logContribution(room, qm, 'final_qty', `Set the final quantity (${Math.max(0, Math.min(team.quantity, team.inventory))} units)`);
    }
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
      touchCandle(room, team);
      const candle = (room.valueCandles[team.teamId] || []).slice(-1)[0];
      if (candle && candle.round === room.round) {
        candle.sold = r.purchased;
        candle.revenue = Math.round(r.revenue);
      }
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
        companyValue: teamValue(team),
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
      companyValue: Math.round(engine.calcCompanyValue(t)),
      isBot: t.isBot,
      // Revealed to everyone once the match is over - the end-of-game
      // "who carried" moment. Never sent to rival teams mid-match.
      contributions: t.isBot ? [] : contributionSnapshot(t)
    }))
    .sort((a, b) => b.companyValue - a.companyValue);
  const payload = { leaderboard: teams, winner: teams[0] || null, history: room.history, candles: room.valueCandles };
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
  room.valueCandles = {};
  Object.values(room.teams).forEach((t) => {
    t.members.forEach((m) => {
      m.stats = newContributionStats();
      m.log = [];
    });
    t.lastPriceEditor = null;
    t.lastQtyEditor = null;
    t.techPurchasesThisRound = [];
    t.capacityPurchasesThisRound = [];
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
function postGlobalMessage(room, { name, text, kind, actionType, teamId, actor }) {
  const msg = { id: genId('msg'), channel: 'global', kind: kind || 'chat', name, text, actionType: actionType || null, teamId: teamId || null, actor: actor || null, round: room.round, at: Date.now() };
  room.globalChatLog.push(msg);
  if (room.globalChatLog.length > 200) room.globalChatLog.shift();
  io.to(room.code).emit('CHAT_MESSAGE', msg);
  return msg;
}
function postActivity(room, team, actionType, text, member) {
  const msg = postGlobalMessage(room, { name: team.teamName, text, kind: 'system', actionType, teamId: team.teamId, actor: member && team.members.length > 1 ? member.memberName : null });
  return msg;
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
          .map((t) => ({ teamId: t.teamId, teamName: t.teamName, memberCount: t.members.length, maxMembers: engine.CONFIG.MAX_MEMBERS_PER_TEAM, memberNames: t.members.map((m) => m.memberName) }))
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
    sendChatSync(socket.id, room, null); // activity feed backlog for a late-opened projector
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
      const seat = findMember(team, mId);
      cb && cb({ ok: true, teamId: team.teamId, memberId: mId, memberName: seat ? seat.memberName : null, roomCode });
      broadcastLobby(room);
      broadcastState(room);
      sendChatSync(socket.id, room, team);
      // Round-by-round history for the live price chart/watchlist sparklines
      // - without this, a reconnect mid-match would show a chart with a gap
      // for every round that happened before the reconnect.
      io.to(socket.id).emit('HISTORY_SYNC', { history: room.history });
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
    // Team name and the creator's own name are separate fields on the
    // create form. The team name is only a fallback for older clients that
    // don't send memberName.
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

  // Every team action is attributed to the person (socket) who sent it.
  // It also doubles as an auth check: a socket that isn't seated on this
  // team can no longer act for it just by knowing its teamId.
  function actingMember(team) {
    return findMemberBySocket(team, socket.id) || null;
  }

  // Live typed price/quantity - broadcast immediately so opponents can see
  // (and be bluffed by) it, per the "Real-time visible bluffing" pillar.
  socket.on('UPDATE_INPUT', ({ roomCode, teamId, price, quantity }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const team = room.teams[teamId];
    if (!team || team.locked || room.phase !== 'round_active') return;
    const member = actingMember(team);
    if (!member) return;
    let changed = false;
    if (price != null) {
      const p = Number(price);
      // Anti-exploit price ceiling: see engine.calcMaxPrice. Clamped here
      // (not just validated) so a submitted value can never exceed it,
      // even from a modified client.
      if (!Number.isNaN(p)) {
        const next = Math.max(0, Math.min(p, engine.calcMaxPrice(room.marketPrice)));
        if (next !== team.price) {
          team.price = next;
          team.lastPriceEditor = member.memberId;
          member.stats.priceEdits += 1;
          changed = true;
        }
      }
    }
    if (quantity != null) {
      const q = Number(quantity);
      if (!Number.isNaN(q)) {
        const next = Math.max(0, Math.min(Math.round(q), team.inventory));
        if (next !== team.quantity) {
          team.quantity = next;
          team.lastQtyEditor = member.memberId;
          member.stats.qtyEdits += 1;
          changed = true;
        }
      }
    }
    if (changed && member.roundEditPts < CONTRIB_POINTS.editCapPerRound) {
      const add = Math.min(CONTRIB_POINTS.editEach, CONTRIB_POINTS.editCapPerRound - member.roundEditPts);
      member.roundEditPts += add;
      member.stats.editPoints = Math.round((member.stats.editPoints + add) * 100) / 100;
    }
    broadcastState(room);
  });

  socket.on('TEAM_INVEST', ({ roomCode, teamId, kind }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const team = room.teams[teamId];
    if (!team || team.locked || room.phase !== 'round_active') return;
    const member = actingMember(team);
    if (!member) return;
    // Debt & Comeback Handling: negative capital from aggressive investment
    // is explicitly allowed, so the only gate here is the level cap.
    if (kind === 'tech' && team.techLevel < engine.CONFIG.TECH_MAX) {
      const cost = roomUpgradeCost(room, 'tech', team.techLevel);
      team.techLevel += 1;
      team.capital -= cost;
      team.techPurchasesThisRound = team.techPurchasesThisRound || [];
      team.techPurchasesThisRound.push({ cost, memberId: member.memberId });
      member.stats.techBuys += 1;
      member.stats.investSpent += cost;
      logContribution(room, member, 'tech_up', `Bought Tech Lv${team.techLevel} ($${cost.toLocaleString()})`);
      postActivity(room, team, 'tech_up', `upgraded Tech to Lv${team.techLevel}`, member);
    } else if (kind === 'capacity' && team.capacityLevel < engine.CONFIG.CAPACITY_MAX) {
      const cost = roomUpgradeCost(room, 'capacity', team.capacityLevel);
      team.capacityLevel += 1;
      team.capital -= cost;
      team.capacityPurchasesThisRound = team.capacityPurchasesThisRound || [];
      team.capacityPurchasesThisRound.push({ cost, memberId: member.memberId });
      member.stats.capBuys += 1;
      member.stats.investSpent += cost;
      logContribution(room, member, 'capacity_up', `Bought Capacity Lv${team.capacityLevel} ($${cost.toLocaleString()})`);
      postActivity(room, team, 'capacity_up', `upgraded Capacity to Lv${team.capacityLevel}`, member);
    } else {
      return;
    }
    touchCandle(room, team);
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
    const member = actingMember(team);
    if (!member) return;
    const ledger = kind === 'tech' ? team.techPurchasesThisRound : team.capacityPurchasesThisRound;
    const roundStartLevel = kind === 'tech' ? team.roundStartTechLevel : team.roundStartCapacityLevel;
    const currentLevel = kind === 'tech' ? team.techLevel : team.capacityLevel;
    if (!ledger || ledger.length === 0 || currentLevel <= roundStartLevel) return;
    const entry = ledger.pop();
    const refund = typeof entry === 'number' ? entry : entry.cost;
    team.capital += refund;
    if (kind === 'tech') team.techLevel -= 1;
    else team.capacityLevel -= 1;
    // The purchase no longer counts for whoever made it.
    const buyer = entry && entry.memberId ? findMember(team, entry.memberId) : null;
    if (buyer) {
      if (kind === 'tech') buyer.stats.techBuys = Math.max(0, buyer.stats.techBuys - 1);
      else buyer.stats.capBuys = Math.max(0, buyer.stats.capBuys - 1);
      buyer.stats.investSpent = Math.max(0, buyer.stats.investSpent - refund);
    }
    member.stats.undos += 1;
    logContribution(room, member, 'undo', `Undid a ${kind === 'tech' ? 'Tech' : 'Capacity'} upgrade`);
    touchCandle(room, team);
    postActivity(room, team, kind === 'tech' ? 'tech_down' : 'capacity_down', `undid a ${kind === 'tech' ? 'Tech' : 'Capacity'} upgrade (back to Lv${kind === 'tech' ? team.techLevel : team.capacityLevel})`, member);
    broadcastState(room);
  });

  socket.on('LOCK_IN', ({ roomCode, teamId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const team = room.teams[teamId];
    if (!team || team.locked || room.phase !== 'round_active') return;
    const member = actingMember(team);
    if (!member) return;
    team.locked = true;
    team.lockOrder = ++room.lockCounter;
    member.stats.lockIns += 1;
    logContribution(room, member, 'lock', `Locked in R${room.round}: $${team.price} × ${team.quantity}`);
    postActivity(room, team, 'lock', `locked in — $${team.price} × ${team.quantity} units`, member);
    broadcastState(room);
    maybeEarlyResolve(room);
  });

  function creditChat(room, member, channel) {
    if (channel === 'team') member.stats.teamMsgs += 1;
    else member.stats.globalMsgs += 1;
    if (room.phase !== 'round_active') return; // lobby small talk doesn't count
    const value = channel === 'team' ? CONTRIB_POINTS.teamMsg : CONTRIB_POINTS.globalMsg;
    const add = Math.min(value, Math.max(0, CONTRIB_POINTS.chatCapPerRound - member.roundChatPts));
    member.roundChatPts += add;
    member.stats.chatPoints = Math.round((member.stats.chatPoints + add) * 100) / 100;
  }

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
      const msg = { id: genId('msg'), channel: 'team', kind: 'chat', name: member.memberName, team: sender.teamName, text: trimmed, at: Date.now() };
      sender.chatLog = sender.chatLog || [];
      sender.chatLog.push(msg);
      if (sender.chatLog.length > 150) sender.chatLog.shift();
      creditChat(room, member, 'team');
      sender.members.forEach((m) => {
        if (m.socketId && m.connected) io.to(m.socketId).emit('CHAT_MESSAGE', msg);
      });
      return;
    }

    // ---- All-Teams (global) channel: HOST always allowed; a player must
    // be their team's CURRENT leader to post - everyone on every team can
    // still read it, per the "leader negotiates, team watches" design. ----
    let name = 'HOST';
    let actor = null;
    if (sender) {
      const member = findMemberBySocket(sender, socket.id);
      if (!member || !isTeamLeader(sender, member.memberId)) {
        io.to(socket.id).emit('CHAT_BLOCKED', { reason: 'Only your team leader can post in the All Teams channel.' });
        return;
      }
      name = sender.teamName;
      actor = sender.members.length > 1 ? member.memberName : null;
      creditChat(room, member, 'global');
    } else if (socket.id !== room.hostSocketId) {
      return; // only the host may post without a team
    }
    postGlobalMessage(room, { name, text: trimmed, kind: 'chat', teamId: sender ? sender.teamId : null, actor });
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
    if (room.valueCandles) delete room.valueCandles[teamId];
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
