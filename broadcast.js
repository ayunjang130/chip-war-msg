// broadcast.js
// The read-only "share screen" - joins a room as a spectator (SPECTATE_ROOM,
// see server.js) and renders the same public data every player already sees
// on their own ticker, as a living PixiJS scene instead of a card grid.
// No controls live here on purpose - this is meant to be projected for a
// whole classroom to watch, not operated.
(function () {
  const $ = (id) => document.getElementById(id);
  const TEAM_COLORS = ['#f0b429', '#5b8def', '#ff5c5c', '#35d488', '#c77edb', '#4fd1c5', '#f2d152', '#f28fb2'];
  const CATEGORY_ICON = { CAPACITY: 'layers', COST: 'dollar', DEMAND: 'package', PRIORITY: 'target', MARKET: 'trending' };

  // Same hash as player.js/host.js's colorFor() - team colors must match
  // across every screen, or "the gold team" means something different on
  // the projector than on a student's own device.
  function colorFor(teamId) {
    let h = 0;
    for (let i = 0; i < teamId.length; i++) h = (h * 31 + teamId.charCodeAt(i)) | 0;
    return TEAM_COLORS[Math.abs(h) % TEAM_COLORS.length];
  }
  function hexToInt(hex) {
    return parseInt(hex.replace('#', ''), 16);
  }
  function injectIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (window.Icons && Icons[el.dataset.icon] != null) el.innerHTML = Icons[el.dataset.icon];
    });
  }
  function activateScreen(id) {
    document.querySelectorAll('.bc-screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function money(n) {
    const v = Math.round(n);
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString();
  }

  injectIcons();

  // ---------- connect: room code from URL (?room=CODE), or the entry form ----------
  const params = new URLSearchParams(location.search);
  const socket = io();
  let connected = false;

  function connectTo(code) {
    socket.emit('SPECTATE_ROOM', { roomCode: code }, (res) => {
      if (!res || !res.ok) {
        $('bc-entry-error').textContent = 'Room not found — check the code and try again.';
        return;
      }
      connected = true;
      $('bc-room-code').textContent = code;
      activateScreen('bc-main'); // must run BEFORE ensureStage(), so #bc-stage has real layout size
      ensureStage();
    });
  }

  const urlRoom = (params.get('room') || '').toUpperCase().trim();
  if (urlRoom) connectTo(urlRoom);
  else activateScreen('bc-entry');

  $('bc-connect-btn').addEventListener('click', () => {
    const v = $('bc-room-input').value.toUpperCase().trim();
    if (!v) {
      $('bc-entry-error').textContent = 'Enter a room code.';
      return;
    }
    connectTo(v);
  });
  $('bc-room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('bc-connect-btn').click();
  });

  socket.on('ROOM_CLOSED', ({ reason }) => {
    $('bc-closed-reason').textContent = reason || 'The host has closed this room.';
    activateScreen('bc-closed');
  });

  // ---------- Pixi stage ----------
  let app = null;
  let gridGraphics = null;
  let hub, hubCore, hubGlow, hubSub;
  let beamsLayer, particlesLayer, nodesLayer;
  const teamNodes = {}; // teamId -> node bundle
  let currentTeamOrder = [];
  const particles = [];
  let elapsed = 0;

  function stageSize() {
    const el = $('bc-stage');
    return { w: Math.max(320, el.clientWidth), h: Math.max(240, el.clientHeight) };
  }
  function sceneRadius() {
    const size = stageSize();
    return Math.max(140, Math.min(size.w, size.h) * 0.36);
  }
  function drawGrid(g, w, h) {
    g.clear();
    g.lineStyle(1, 0x131a26, 0.6);
    for (let x = 0; x <= w; x += 40) {
      g.moveTo(x, 0);
      g.lineTo(x, h);
    }
    for (let y = 0; y <= h; y += 40) {
      g.moveTo(0, y);
      g.lineTo(w, y);
    }
  }
  function positionHub() {
    const size = stageSize();
    hub.x = size.w / 2;
    hub.y = size.h / 2;
  }
  function layoutTeamNodes() {
    const size = stageSize();
    const cx = size.w / 2,
      cy = size.h / 2;
    const r = sceneRadius();
    const n = currentTeamOrder.length || 1;
    currentTeamOrder.forEach((teamId, i) => {
      const tn = teamNodes[teamId];
      if (!tn) return;
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      tn.angle = angle;
      tn.nx = cx + Math.cos(angle) * r;
      tn.ny = cy + Math.sin(angle) * r;
    });
  }

  function ensureStage() {
    if (app) return;
    const size = stageSize();
    app = new PIXI.Application({
      width: size.w,
      height: size.h,
      backgroundColor: 0x070a10,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true
    });
    $('bc-stage').appendChild(app.view);

    gridGraphics = new PIXI.Graphics();
    app.stage.addChild(gridGraphics);
    drawGrid(gridGraphics, size.w, size.h);

    beamsLayer = new PIXI.Container();
    particlesLayer = new PIXI.Container();
    nodesLayer = new PIXI.Container();
    app.stage.addChild(beamsLayer, particlesLayer, nodesLayer);

    hub = new PIXI.Container();
    hubGlow = new PIXI.Graphics();
    hubCore = new PIXI.Graphics();
    hub.addChild(hubGlow, hubCore);
    const hubLabel = new PIXI.Text('APPLE', { fontFamily: 'monospace', fontSize: 14, fill: 0xf0b429, letterSpacing: 2, fontWeight: 'bold' });
    hubLabel.anchor.set(0.5);
    hub.addChild(hubLabel);
    hubSub = new PIXI.Text('', { fontFamily: 'monospace', fontSize: 11, fill: 0x7d8798 });
    hubSub.anchor.set(0.5);
    hubSub.y = 20;
    hub.addChild(hubSub);
    nodesLayer.addChild(hub);

    positionHub();
    app.ticker.add(onTick);
    window.addEventListener('resize', onResize);
  }

  function onResize() {
    if (!app) return;
    const size = stageSize();
    app.renderer.resize(size.w, size.h);
    positionHub();
    layoutTeamNodes();
    drawGrid(gridGraphics, size.w, size.h);
  }

  function ensureTeamNode(teamId, color) {
    if (teamNodes[teamId]) return teamNodes[teamId];
    const beam = new PIXI.Graphics();
    beamsLayer.addChild(beam);
    const node = new PIXI.Container();
    const ring = new PIXI.Graphics();
    node.addChild(ring);
    const panel = new PIXI.Graphics();
    node.addChild(panel);
    const name = new PIXI.Text('', { fontFamily: 'sans-serif', fontSize: 12, fill: hexToInt(color), fontWeight: 'bold' });
    name.anchor.set(0.5, 0);
    node.addChild(name);
    const stat = new PIXI.Text('', { fontFamily: 'monospace', fontSize: 13, fill: 0xe7edf5 });
    stat.anchor.set(0.5, 0);
    node.addChild(stat);
    const stat2 = new PIXI.Text('', { fontFamily: 'monospace', fontSize: 10.5, fill: 0x7d8798 });
    stat2.anchor.set(0.5, 0);
    node.addChild(stat2);
    const lockDot = new PIXI.Graphics();
    node.addChild(lockDot);
    nodesLayer.addChild(node);
    const bundle = { node, beam, ring, panel, name, stat, stat2, lockDot, color, angle: 0, nx: 0, ny: 0, locked: false, wasLocked: false };
    teamNodes[teamId] = bundle;
    return bundle;
  }

  function drawPanel(tn, panelW, panelH) {
    tn.panel.clear();
    tn.panel
      .beginFill(0x0d1119, 0.92)
      .lineStyle(1.4, hexToInt(tn.color), 0.9)
      .drawRoundedRect(-panelW / 2, -panelH / 2, panelW, panelH, 10)
      .endFill();
    tn.name.y = -panelH / 2 + 8;
    tn.stat.y = -4;
    tn.stat2.y = panelH / 2 - 20;
  }

  function spawnBurst(tn) {
    for (let i = 0; i < 10; i++) {
      const g = new PIXI.Graphics();
      g.beginFill(hexToInt(tn.color)).drawCircle(0, 0, 3).endFill();
      g.x = tn.nx;
      g.y = tn.ny;
      particlesLayer.addChild(g);
      const angle = Math.random() * Math.PI * 2;
      const dist = 30 + Math.random() * 26;
      particles.push({ g, t: 0, speed: 0.03 + Math.random() * 0.02, dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist, ox: tn.nx, oy: tn.ny });
    }
  }

  // ---------- live data -> scene ----------
  function updateScene(payload) {
    ensureStage();
    const teams = payload.teams || [];
    const teamIds = teams.map((t) => t.teamId);

    const rosterChanged = teamIds.length !== currentTeamOrder.length || teamIds.some((id, i) => id !== currentTeamOrder[i]);
    if (rosterChanged) {
      Object.keys(teamNodes).forEach((id) => {
        if (!teamIds.includes(id)) {
          const tn = teamNodes[id];
          nodesLayer.removeChild(tn.node);
          beamsLayer.removeChild(tn.beam);
          delete teamNodes[id];
        }
      });
      currentTeamOrder = teamIds;
      teams.forEach((t) => ensureTeamNode(t.teamId, colorFor(t.teamId)));
      layoutTeamNodes();
    }

    hubSub.text = 'demand: ' + (payload.totalDemand != null ? payload.totalDemand.toLocaleString() : '—');

    const panelW = 150,
      panelH = 74;
    teams.forEach((t) => {
      const tn = teamNodes[t.teamId];
      if (!tn) return;
      drawPanel(tn, panelW, panelH);
      tn.name.text = t.teamName.toUpperCase();
      tn.stat.text = '$' + t.price + '   x' + t.quantity;
      tn.stat2.text = 'T' + t.techLevel + ' · C' + t.capacityLevel;
      tn.wasLocked = tn.locked;
      tn.locked = !!t.locked;
      tn.lockDot.clear();
      tn.lockDot
        .beginFill(tn.locked ? hexToInt(tn.color) : 0x2a3346)
        .drawCircle(panelW / 2 - 10, -panelH / 2 + 10, 4)
        .endFill();
      if (tn.locked && !tn.wasLocked) spawnBurst(tn);
    });

    $('bc-round').textContent = payload.round + ' / ' + payload.totalRounds;
    $('bc-mp').textContent = payload.marketPrice ? '$' + payload.marketPrice.toFixed(0) : '—';
    $('bc-demand').textContent = payload.totalDemand != null ? payload.totalDemand.toLocaleString() : '—';

    if (payload.shock) {
      $('bc-shock-banner').classList.add('active');
      const tag = payload.shock.categoryTag || 'MARKET';
      $('bc-shock-tag').innerHTML = Icons[CATEGORY_ICON[tag] || 'trending'] + tag;
      $('bc-shock-title').textContent = payload.shock.title;
      $('bc-shock-desc').textContent = payload.shock.description;
    } else {
      $('bc-shock-banner').classList.remove('active');
    }

    if (payload.phase === 'round_active' || payload.phase === 'lobby') {
      $('bc-results-overlay').classList.remove('active');
    }
  }

  function onTick(delta) {
    elapsed += delta / 60;
    const pulse = 1 + Math.sin(elapsed * 1.6) * 0.05;
    hubCore.clear();
    hubCore.beginFill(0x0d1119).lineStyle(2, 0xf0b429, 1).drawCircle(0, 0, 54 * pulse).endFill();
    hubGlow.clear();
    hubGlow.beginFill(0xf0b429, 0.06 + Math.sin(elapsed * 1.6) * 0.02).drawCircle(0, 0, 82).endFill();

    Object.keys(teamNodes).forEach((id) => {
      const tn = teamNodes[id];
      tn.node.x = tn.nx;
      tn.node.y = tn.ny + Math.sin(elapsed * 1.1 + tn.angle) * 3;

      tn.beam.clear();
      tn.beam.lineStyle(tn.locked ? 2.4 : 1.2, hexToInt(tn.color), tn.locked ? 0.55 : 0.2);
      tn.beam.moveTo(hub.x, hub.y);
      tn.beam.lineTo(tn.nx, tn.ny);

      tn.ring.clear();
      if (tn.locked) {
        tn.ring.lineStyle(2, hexToInt(tn.color), 0.5 - Math.sin(elapsed * 3) * 0.15);
        tn.ring.drawRoundedRect(-79, -41, 158, 82, 14);
      }
    });

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += p.speed * delta;
      if (p.t >= 1) {
        particlesLayer.removeChild(p.g);
        particles.splice(i, 1);
        continue;
      }
      p.g.x = p.ox + p.dx * p.t;
      p.g.y = p.oy + p.dy * p.t;
      p.g.alpha = 1 - p.t;
    }
  }

  // ---------- socket wiring ----------
  socket.on('STATE_SYNC', (payload) => {
    if (connected) updateScene(payload);
  });
  socket.on('TIMER_TICK', ({ timeLeft }) => {
    const m = Math.floor(timeLeft / 60),
      s = timeLeft % 60;
    $('bc-timer').textContent = m + ':' + String(s).padStart(2, '0');
    $('bc-timer').classList.toggle('low', timeLeft <= 20);
  });
  socket.on('ROUND_RESULT', (payload) => {
    $('bc-results-eyebrow').textContent = 'round results';
    $('bc-results-title').textContent = 'Round ' + payload.round + ' results';
    const body = $('bc-results-table');
    body.innerHTML = '';
    (payload.results || []).forEach((r, idx) => {
      const row = document.createElement('div');
      row.className = 'bc-results-row' + (idx === 0 ? ' first' : '');
      row.innerHTML =
        '<div class="rank">' +
        (idx === 0 ? Icons.star : idx + 1) +
        '</div><div class="name">' +
        escapeHtml(r.teamName) +
        '</div><div>$' +
        r.price +
        '</div><div>x' +
        r.quantitySold +
        '</div><div>' +
        money(r.revenue) +
        '</div>';
      body.appendChild(row);
    });
    $('bc-results-hint').textContent = payload.isFinalRound ? 'Calculating final results…' : 'Next round starting automatically…';
    $('bc-results-overlay').classList.add('active');
  });
  socket.on('GAME_OVER', (payload) => {
    $('bc-results-eyebrow').textContent = 'final results';
    $('bc-results-title').textContent = payload.winner ? payload.winner.teamName + ' wins' : 'Game over';
    const body = $('bc-results-table');
    body.innerHTML = '';
    (payload.leaderboard || []).forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'bc-results-row' + (idx === 0 ? ' first' : '');
      row.innerHTML = '<div class="rank">' + (idx === 0 ? Icons.star : idx + 1) + '</div><div class="name">' + escapeHtml(t.teamName) + '</div><div>' + money(t.companyValue) + '</div>';
      body.appendChild(row);
    });
    $('bc-results-hint').textContent = 'Match complete.';
    $('bc-results-overlay').classList.add('active');
  });
})();
