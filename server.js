// server.js
// Chip War (MSG v2.0) - real-time multiplayer prototype server.
// Stack: Node.js + Express (static hosting) + Socket.io (real-time sync).
// State is in-memory only, per GDD section 1 ("No external database
// required for live gameplay matches").

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
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;

// roomCode -> room state object
const rooms = {};
// socket.id -> { roomCode, teamId?, role: 'player' | 'host' }
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

function createTeamState(teamId, teamName, companyName, socketId, isBot = false, botStrategy = null) {
  return {
    teamId,
    teamName,
    companyName,
    socketId,
    connected: !isBot,
    isBot,
    botStrategy,
    capital: engine.CONFIG.INITIAL_CAPITAL,
    inventory: engine.CONFIG.INITIAL_INVENTORY,
    techLevel: engine.CONFIG.INITIAL_TECH,
    capacityLevel: engine.CONFIG.INITIAL_CAPACITY,
    price: 50,
    quantity: 0,
    locked: false,
    lockOrder: 0,
    lastRoundPrice: 50
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
    chatLog: [],
    history: [],
    lockCounter: 0,
    lastActivityAt: Date.now(),
    config: {
      weights: { ...engine.CONFIG.WEIGHTS_DEFAULT },
      demandPerTeam: engine.CONFIG.DEMAND_PER_TEAM,
      roundTimerSeconds: engine.CONFIG.ROUND_TIMER_SECONDS,
      maxTeams: 8
    }
  };
  return rooms[code];
}

// ---- Hidden-information rules (GDD 2.10 / 2.11) --------------------------
// Price, quantity, tech level and capacity level are always public.
// Capital ("cash reserves") is only shown to the owning team and to the host.
function publicTeam(team, viewerTeamId, isPrivileged) {
  const showCapital = isPrivileged || team.teamId === viewerTeamId;
  return {
    teamId: team.teamId,
    teamName: team.teamName,
    companyName: team.companyName,
    connected: team.connected,
    isBot: team.isBot,
    price: team.price,
    quantity: team.quantity,
    techLevel: team.techLevel,
    capacityLevel: team.capacityLevel,
    inventory: team.inventory,
    locked: team.locked,
    capital: showCapital ? Math.round(team.capital) : null
  };
}

function broadcastState(room) {
  room.lastActivityAt = Date.now();
  const teamList = Object.values(room.teams);
  teamList.forEach((viewer) => {
    if (!viewer.socketId || !viewer.connected) return;
    io.to(viewer.socketId).emit('STATE_SYNC', {
      round: room.round,
      totalRounds: engine.CONFIG.ROUNDS,
      phase: room.phase,
      timeLeft: room.timeLeft,
      paused: room.paused,
      marketPrice: room.marketPrice,
      teams: teamList.map((t) => publicTeam(t, viewer.teamId, false))
    });
  });
  if (room.hostSocketId) {
    io.to(room.hostSocketId).emit('STATE_SYNC', {
      round: room.round,
      totalRounds: engine.CONFIG.ROUNDS,
      phase: room.phase,
      timeLeft: room.timeLeft,
      paused: room.paused,
      marketPrice: room.marketPrice,
      teams: teamList.map((t) => publicTeam(t, null, true))
    });
  }
}

function broadcastLobby(room) {
  room.lastActivityAt = Date.now();
  const payload = {
    roomCode: room.code,
    config: room.config,
    phase: room.phase,
    teams: Object.values(room.teams).map((t) => ({
      teamId: t.teamId,
      teamName: t.teamName,
      companyName: t.companyName,
      connected: t.connected,
      isBot: t.isBot
    }))
  };
  io.to(room.code).emit('LOBBY_UPDATE', payload);
}

// ---- Round lifecycle -------------------------------------------------------

function startRound(room) {
  if (room.timerHandle) clearInterval(room.timerHandle);
  if (room.nextRoundHandle) clearTimeout(room.nextRoundHandle);

  room.round += 1;
  room.phase = 'round_active';
  room.lockCounter = 0;
  room.paused = false;

  // Phase 1: Revenue Collection & Production (uses capacity level as it
  // stood at the END of the previous round - this round's investments only
  // pay off in production from next round onward).
  Object.values(room.teams).forEach((team) => {
    const production = engine.calcProduction(team.capacityLevel);
    team.inventory += production;
    team.locked = false;
    team.quantity = 0; // force an explicit decision every round
    if (!team.price) team.price = room.marketPrice > 0 ? room.marketPrice : 50;
  });

  room.timeLeft = room.config.roundTimerSeconds;
  io.to(room.code).emit('ROUND_START', {
    round: room.round,
    totalRounds: engine.CONFIG.ROUNDS,
    timeLeft: room.timeLeft
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
      const cost = kind === 'tech' ? engine.CONFIG.TECH_UPGRADE_COST : engine.CONFIG.CAPACITY_UPGRADE_COST;
      const level = kind === 'tech' ? team.techLevel : team.capacityLevel;
      const max = kind === 'tech' ? engine.CONFIG.TECH_MAX : engine.CONFIG.CAPACITY_MAX;
      if (budget >= cost && level < max && Math.random() < 0.7) {
        if (kind === 'tech') team.techLevel += 1;
        else team.capacityLevel += 1;
        team.capital -= cost;
        budget -= cost;
        bought = true;
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
    weights: room.config.weights,
    demandPerTeam: room.config.demandPerTeam
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
        companyName: team.companyName,
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
    isFinalRound: room.round >= engine.CONFIG.ROUNDS
  };
  room.history.push(payload);
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
      companyName: t.companyName,
      capital: Math.round(t.capital),
      inventory: t.inventory,
      techLevel: t.techLevel,
      capacityLevel: t.capacityLevel,
      companyValue: Math.round(engine.calcCompanyValue(t))
    }))
    .sort((a, b) => b.companyValue - a.companyValue);
  io.to(room.code).emit('GAME_OVER', { leaderboard: teams, winner: teams[0] || null });
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
  Object.values(room.teams).forEach((t) => {
    t.capital = engine.CONFIG.INITIAL_CAPITAL;
    t.inventory = engine.CONFIG.INITIAL_INVENTORY;
    t.techLevel = engine.CONFIG.INITIAL_TECH;
    t.capacityLevel = engine.CONFIG.INITIAL_CAPACITY;
    t.price = 50;
    t.quantity = 0;
    t.locked = false;
    t.lastRoundPrice = 50;
  });
  broadcastLobby(room);
  broadcastState(room);
}

// ---- Socket.io event wiring (event names match GDD section "5. Host
// Dashboard Specifications" table, plus the extra HOST_*/TEAM_INVEST/
// CHAT_MESSAGE events needed to make the loop actually playable) ----------

io.on('connection', (socket) => {
  socket.on('HOST_CREATE_ROOM', (_payload, cb) => {
    const room = createRoom(socket.id);
    socket.join(room.code);
    socketMeta[socket.id] = { roomCode: room.code, role: 'host' };
    if (typeof cb === 'function') cb({ ok: true, roomCode: room.code, config: room.config });
  });

  // Lets a host reconnect (e.g. page refresh) without losing the room.
  socket.on('HOST_REJOIN', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });
    room.hostSocketId = socket.id;
    socket.join(room.code);
    socketMeta[socket.id] = { roomCode, role: 'host' };
    cb && cb({ ok: true, roomCode: room.code, config: room.config });
    broadcastLobby(room);
    broadcastState(room);
  });

  socket.on('JOIN_ROOM', ({ roomCode, teamName, companyName, teamId }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb && cb({ ok: false, error: 'ROOM_NOT_FOUND' });

    let team = teamId ? room.teams[teamId] : null;
    if (team) {
      // Reconnection Session Recovery: same teamId found, restore the socket.
      team.socketId = socket.id;
      team.connected = true;
    } else {
      if (Object.keys(room.teams).length >= room.config.maxTeams) {
        return cb && cb({ ok: false, error: 'ROOM_FULL' });
      }
      const id = genId('team');
      const base = (companyName || 'Company').trim() || 'Company';
      const taken = new Set(Object.values(room.teams).map((t) => t.companyName));
      let candidate = base;
      let suffix = 1;
      while (taken.has(candidate)) {
        suffix += 1;
        candidate = `${base} ${suffix}`;
      }
      team = createTeamState(id, (teamName || `Team ${Object.keys(room.teams).length + 1}`).trim(), candidate, socket.id);
      room.teams[id] = team;
    }

    socket.join(roomCode);
    socketMeta[socket.id] = { roomCode, teamId: team.teamId, role: 'player' };
    cb && cb({ ok: true, teamId: team.teamId, roomCode });
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
      if (!Number.isNaN(p)) team.price = Math.max(0, p);
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
      team.techLevel += 1;
      team.capital -= engine.CONFIG.TECH_UPGRADE_COST;
    } else if (kind === 'capacity' && team.capacityLevel < engine.CONFIG.CAPACITY_MAX) {
      team.capacityLevel += 1;
      team.capital -= engine.CONFIG.CAPACITY_UPGRADE_COST;
    }
    broadcastState(room);
  });

  socket.on('LOCK_IN', ({ roomCode, teamId }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const team = room.teams[teamId];
    if (!team || team.locked || room.phase !== 'round_active') return;
    team.locked = true;
    team.lockOrder = ++room.lockCounter;
    broadcastState(room);
    maybeEarlyResolve(room);
  });

  socket.on('CHAT_MESSAGE', ({ roomCode, teamId, text }) => {
    const room = rooms[roomCode];
    if (!room || !text || !String(text).trim()) return;
    const sender = teamId ? room.teams[teamId] : null;
    const name = sender ? sender.companyName : 'HOST';
    const msg = { id: genId('msg'), name, text: String(text).slice(0, 240), at: Date.now() };
    room.chatLog.push(msg);
    if (room.chatLog.length > 200) room.chatLog.shift();
    io.to(roomCode).emit('CHAT_MESSAGE', msg);
  });

  socket.on('HOST_UPDATE_CONFIG', ({ roomCode, config }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.phase !== 'lobby') return;
    if (config.weights) room.config.weights = engine.normalizeWeights(config.weights);
    if (config.demandPerTeam != null) {
      room.config.demandPerTeam = Math.max(1, Number(config.demandPerTeam) || engine.CONFIG.DEMAND_PER_TEAM);
    }
    if (config.roundTimerSeconds != null) {
      room.config.roundTimerSeconds = Math.max(30, Number(config.roundTimerSeconds) || engine.CONFIG.ROUND_TIMER_SECONDS);
    }
    if (config.maxTeams != null) {
      room.config.maxTeams = Math.min(8, Math.max(3, Number(config.maxTeams) || 8));
    }
    broadcastLobby(room);
  });

  socket.on('HOST_ADD_BOT', ({ roomCode, strategy }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.phase !== 'lobby') return;
    if (Object.keys(room.teams).length >= room.config.maxTeams) return;
    const label = strategy === 'tech' ? 'NVIDIA-Bot' : strategy === 'capacity' ? 'TSMC-Bot' : 'Samsung-Bot';
    const taken = new Set(Object.values(room.teams).map((t) => t.companyName));
    let name = label;
    let n = 1;
    while (taken.has(name)) {
      n += 1;
      name = `${label} ${n}`;
    }
    const id = genId('bot');
    room.teams[id] = createTeamState(id, name, name, null, true, strategy || 'balanced');
    broadcastLobby(room);
    broadcastState(room);
  });

  socket.on('HOST_KICK_TEAM', ({ roomCode, teamId }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) return;
    delete room.teams[teamId];
    broadcastLobby(room);
    broadcastState(room);
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
        room.teams[meta.teamId].connected = false;
        room.teams[meta.teamId].socketId = null;
        broadcastLobby(room);
        broadcastState(room);
      } else if (meta.role === 'host' && room.hostSocketId === socket.id) {
        room.hostSocketId = null;
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
    const anyPlayerConnected = Object.values(room.teams).some((t) => t.connected);
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
