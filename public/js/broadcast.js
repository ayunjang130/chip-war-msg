// broadcast.js
// The projector screen. Joins a room as a read-only spectator and shows
// every company's Company Value the way a stock app shows a share price:
// one candle per round, red when the company closed the round higher than
// it opened, blue when lower (Korean market convention), with units sold
// as the "volume" bars underneath.
//
// Three stages, so the screen is never empty:
//   lobby            -> "Pre-market": big join code + companies listing
//   round 1 (live)   -> "Opening session": live order cards per company
//   from round 1 close -> candlestick board
(function () {
  const $ = (id) => document.getElementById(id);
  const TEAM_COLORS = ['#e7ecf3', '#4fb5c2', '#e3b341', '#d58be0', '#9bd06b', '#b79cf5', '#f2a65a', '#8fa3bf'];
  const UP = '#f0464d', DOWN = '#3d8bfd', FLAT = '#7f8ba0';
  const CATEGORY_ICON = { CAPACITY: 'layers', COST: 'dollar', DEMAND: 'package', PRIORITY: 'target', MARKET: 'trending' };
  const CATEGORY_LABEL = { CAPACITY: 'Production', COST: 'Costs', DEMAND: 'Demand', PRIORITY: "Apple's priorities", MARKET: 'Market' };
  const ACTION_ICON = { lock: 'lock', tech_up: 'cpu', tech_down: 'cpu', capacity_up: 'layers', capacity_down: 'layers' };
  const TOTAL_ROUNDS = 6;

  function colorFor(key) {
    let h = 0;
    key = String(key || '');
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return TEAM_COLORS[Math.abs(h) % TEAM_COLORS.length];
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
    const v = Math.round(n || 0);
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString();
  }
  function compact(n) {
    const a = Math.abs(n);
    if (a >= 10000) return (n < 0 ? '-' : '') + '$' + (a / 1000).toFixed(a >= 100000 ? 0 : 1) + 'k';
    return money(n);
  }
  function symbolFor(name) {
    const clean = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (clean.slice(0, 4) || 'TEAM').padEnd(3, 'X');
  }
  function dirClass(d) {
    return d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  }
  function pctText(d, base) {
    if (!base) return '0.00%';
    const p = (d / Math.abs(base)) * 100;
    return (p > 0 ? '+' : p < 0 ? '' : '') + p.toFixed(2) + '%';
  }
  function arrow(d) {
    return d > 0 ? '▲' : d < 0 ? '▼' : '';
  }

  injectIcons();

  const params = new URLSearchParams(location.search);
  const socket = io();
  let connected = false;
  let state = null;
  let lobbyTeams = [];
  let phase = 'lobby';
  let roomCode = null;
  let resultsTimer = null;
  let intraday = {}; // teamId -> [price samples] for the opening session sparklines

  function connectTo(code) {
    socket.emit('SPECTATE_ROOM', { roomCode: code }, (res) => {
      if (!res || !res.ok) {
        $('bc-entry-error').textContent = 'No room with that code. Check it on the host screen.';
        return;
      }
      connected = true;
      roomCode = code;
      $('bc-room-code').textContent = code;
      $('pm-code').textContent = code;
      $('pm-url').textContent = location.host + '/';
      activateScreen('bc-main');
      setView('view-premarket');
    });
  }
  const urlRoom = (params.get('room') || '').toUpperCase().trim();
  if (urlRoom) connectTo(urlRoom);
  $('bc-connect-btn').addEventListener('click', () => {
    const v = $('bc-room-input').value.toUpperCase().trim();
    if (!v) return ($('bc-entry-error').textContent = 'Enter the room code.');
    connectTo(v);
  });
  $('bc-room-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('bc-connect-btn').click();
  });
  socket.on('ROOM_CLOSED', ({ reason }) => {
    $('bc-closed-reason').textContent = reason || 'The host has closed this room.';
    activateScreen('bc-closed');
  });

  function setView(id) {
    document.querySelectorAll('.bc-view').forEach((v) => v.classList.toggle('active', v.id === id));
  }
  function gridCols(n) {
    if (n <= 3) return Math.max(n, 1); // 3 teams -> one row of 3, no empty cell
    if (n === 4) return 2;
    if (n <= 6) return 3;
    return 4;
  }

  // ------------------------------------------------------------------
  // Candlestick renderer (plain canvas)
  // ------------------------------------------------------------------
  function sizeCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) ticks.push(v);
    return ticks;
  }

  // candles: [{round, o, h, l, c, sold}], range: {min, max, maxSold}, live: current round number or null
  function drawCandles(canvas, candles, range, live, teamColor) {
    const { ctx, w, h } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    const axisW = 62;
    const padTop = 8, volH = Math.max(26, h * 0.2), gap = 8, labelH = 16;
    const priceH = h - padTop - volH - gap - labelH;
    const plotW = w - axisW - 8;
    const slots = TOTAL_ROUNDS + 1; // IPO + 6 rounds
    const slotW = plotW / slots;
    const bodyW = Math.max(6, Math.min(34, slotW * 0.52));
    const y = (v) => padTop + (1 - (v - range.min) / (range.max - range.min || 1)) * priceH;
    const xc = (i) => 8 + slotW * (i + 0.5);

    // grid + axis
    ctx.font = '500 12px Archivo, sans-serif';
    ctx.textBaseline = 'middle';
    niceTicks(range.min, range.max, 3).forEach((v) => {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = '#1d2838';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(8, yy);
      ctx.lineTo(8 + plotW, yy);
      ctx.stroke();
      ctx.fillStyle = '#6f7b90';
      ctx.textAlign = 'left';
      ctx.fillText(compact(v), 8 + plotW + 8, yy);
    });

    // future-round placeholders + round labels
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < slots; i++) {
      const has = candles.some((c) => c.round === i);
      if (!has) {
        ctx.strokeStyle = '#1f2a3a';
        ctx.setLineDash([3, 4]);
        ctx.strokeRect(xc(i) - bodyW / 2 + 0.5, padTop + priceH * 0.3, bodyW - 1, priceH * 0.4);
        ctx.setLineDash([]);
      }
      ctx.fillStyle = live === i ? '#e3b341' : '#6f7b90';
      ctx.font = (live === i ? '700 ' : '500 ') + '11.5px Archivo, sans-serif';
      ctx.fillText(i === 0 ? 'IPO' : 'R' + i, xc(i), h - 3);
    }

    // volume bars (units sold)
    const volTop = padTop + priceH + gap;
    candles.forEach((c) => {
      if (!c.round || !c.sold) return;
      const d = c.c - c.o;
      const bh = (c.sold / (range.maxSold || 1)) * volH;
      ctx.fillStyle = d > 0 ? 'rgba(240,70,77,.55)' : d < 0 ? 'rgba(61,139,253,.55)' : 'rgba(127,139,160,.5)';
      ctx.fillRect(xc(c.round) - bodyW / 2, volTop + volH - bh, bodyW, bh);
    });
    ctx.strokeStyle = '#1d2838';
    ctx.beginPath();
    ctx.moveTo(8, volTop + volH + 0.5);
    ctx.lineTo(8 + plotW, volTop + volH + 0.5);
    ctx.stroke();

    // closing-value line in the team's colour (like a moving-average line)
    if (candles.length > 1) {
      ctx.strokeStyle = teamColor;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      candles.forEach((c, i) => {
        const px = xc(c.round), py = y(c.c);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // candles
    candles.forEach((c) => {
      const d = c.c - c.o;
      const col = c.round === 0 ? FLAT : d > 0 ? UP : d < 0 ? DOWN : FLAT;
      const x = xc(c.round);
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, y(c.h));
      ctx.lineTo(Math.round(x) + 0.5, y(c.l));
      ctx.stroke();
      const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
      const bh = Math.max(2, bot - top);
      ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
      if (live === c.round) {
        ctx.strokeStyle = '#e3b341';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(x - bodyW / 2 - 4, Math.min(y(c.h), top) - 4, bodyW + 8, Math.max(y(c.l), top + bh) - Math.min(y(c.h), top) + 8);
        ctx.setLineDash([]);
      }
    });

    // last-value tag on the axis, coloured by the current candle's direction
    const last = candles[candles.length - 1];
    if (last) {
      const d = last.c - last.o;
      const col = last.round === 0 ? '#3a4960' : d > 0 ? UP : d < 0 ? DOWN : '#3a4960';
      const ty = Math.max(padTop + 9, Math.min(padTop + priceH - 9, y(last.c)));
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xc(last.round) + bodyW / 2 + 2, Math.round(y(last.c)) + 0.5);
      ctx.lineTo(8 + plotW, Math.round(y(last.c)) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.fillRect(8 + plotW + 2, ty - 10, axisW - 2, 20);
      ctx.fillStyle = '#fff';
      ctx.font = '700 12px Archivo, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(compact(last.c), 8 + plotW + 7, ty);
    }
  }

  function drawSpark(canvas, pts, color) {
    const { ctx, w, h } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!pts || pts.length < 2) return;
    // keep a minimum $20 window so a $5 nudge doesn't look like a crash
    let min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    if (max - min < 20) {
      const mid = (max + min) / 2;
      min = mid - 10;
      max = mid + 10;
    }
    const r = max - min;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((v, i) => {
      const x = (i / (pts.length - 1)) * (w - 4) + 2;
      const yy = h - 4 - ((v - min) / r) * (h - 8);
      i ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
    });
    ctx.stroke();
    const lastV = pts[pts.length - 1], prevV = pts[pts.length - 2];
    ctx.fillStyle = lastV > prevV ? UP : lastV < prevV ? DOWN : color;
    ctx.beginPath();
    ctx.arc(w - 2, h - 4 - ((lastV - min) / r) * (h - 8), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------
  function candlesFor(teamId) {
    return (state && state.candles && state.candles[teamId]) || [];
  }
  function currentValue(t) {
    const cs = candlesFor(t.teamId);
    if (cs.length) return cs[cs.length - 1].c;
    return t.companyValue != null ? t.companyValue : state && state.startingCapital;
  }
  function ipoValue(t) {
    const cs = candlesFor(t.teamId);
    return cs.length ? cs[0].o : state ? state.startingCapital : 0;
  }

  function sampleIntraday(teams) {
    teams.forEach((t) => {
      const arr = (intraday[t.teamId] = intraday[t.teamId] || []);
      if (!(t.price === 0 && !t.locked)) arr.push(t.price);
      else if (arr.length) arr.push(arr[arr.length - 1]);
      if (arr.length > 400) arr.shift();
    });
  }

  function renderPremarket() {
    const teams = lobbyTeams.length ? lobbyTeams : (state && state.teams) || [];
    $('pm-count').textContent = teams.length + (teams.length === 1 ? ' company' : ' companies');
    const ipo = state && state.startingCapital ? state.startingCapital : 5000;
    const list = $('pm-list');
    const prevIds = Array.from(list.querySelectorAll('.ipo-row')).map((r) => r.dataset.id).join(',');
    const ids = teams.map((t) => t.teamId).join(',');
    if (!teams.length) {
      list.innerHTML = '<div class="ipo-empty">No companies yet. Teams appear here the moment they\'re created.</div>';
      return;
    }
    if (prevIds === ids && list.querySelector('.ipo-row')) {
      // just refresh member counts without replaying the entrance animation
      teams.forEach((t) => {
        const row = list.querySelector('[data-id="' + t.teamId + '"] .members');
        if (row) row.textContent = memberLine(t);
      });
      return;
    }
    list.innerHTML = teams
      .map(
        (t) =>
          '<div class="ipo-row" data-id="' + t.teamId + '"><span class="sym">' + symbolFor(t.teamName) + '</span><span class="dot" style="background:' + colorFor(t.teamId) + '"></span>' +
          '<div><div class="nm">' + escapeHtml(t.teamName) + '</div><div class="members">' + escapeHtml(memberLine(t)) + '</div></div><span class="px">' + money(ipo) + '</span></div>'
      )
      .join('');
  }
  function memberLine(t) {
    if (t.isBot) return 'Computer player';
    const names = (t.members || []).map((m) => m.memberName);
    return names.length ? names.join(', ') : t.memberCount + ' member' + (t.memberCount === 1 ? '' : 's');
  }

  function renderOpening() {
    const teams = state.teams || [];
    const grid = $('op-grid');
    const cols = gridCols(teams.length);
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    grid.style.gridTemplateRows = 'repeat(' + Math.ceil(teams.length / cols) + ', minmax(0, 1fr))';
    const ids = teams.map((t) => t.teamId).join(',');
    if (grid.dataset.ids !== ids) {
      grid.dataset.ids = ids;
      grid.innerHTML = teams
        .map(
          (t) =>
            '<div class="open-card" data-id="' + t.teamId + '"><div class="top"><span class="dot" style="background:' + colorFor(t.teamId) + '"></span><span class="nm">' + escapeHtml(t.teamName) + '</span><span class="st"></span></div>' +
            '<div class="bid"><div><div class="k">Price</div><div class="v f-price">—</div></div><div><div class="k">Offering</div><div class="v f-qty">—</div></div><div><div class="k">Value</div><div class="v f-val">—</div></div></div>' +
            '<div class="pips"><span>Tech <span class="levels f-tech"></span></span><span>Capacity <span class="levels f-cap"></span></span></div><div class="spark-label">Price this session</div><canvas></canvas></div>'
        )
        .join('');
    }
    const ipo = state.startingCapital || 5000;
    $('op-sub').textContent = 'Every company listed at ' + money(ipo) + '. The first candles print when round 1 closes - watch who prices aggressively.';
    teams.forEach((t) => {
      const card = grid.querySelector('[data-id="' + t.teamId + '"]');
      if (!card) return;
      const st = card.querySelector('.st');
      st.className = 'st' + (t.locked ? ' locked' : '');
      st.innerHTML = (t.locked ? Icons.lock + 'Locked in' : Icons.unlock + 'Quoting');
      card.querySelector('.f-price').textContent = '$' + t.price;
      card.querySelector('.f-qty').textContent = t.quantity;
      const v = currentValue(t);
      const d = v - ipo;
      card.querySelector('.f-val').innerHTML = compact(v) + (d ? ' <span style="font-size:14px; color:' + (d > 0 ? UP : DOWN) + '">' + arrow(d) + '</span>' : '');
      const dots = (n) => [0, 1, 2, 3, 4].map((i) => '<span class="lvl-dot' + (i < n ? ' filled' : '') + '"></span>').join('');
      card.querySelector('.f-tech').innerHTML = dots(t.techLevel);
      card.querySelector('.f-cap').innerHTML = dots(t.capacityLevel);
      drawSpark(card.querySelector('canvas'), intraday[t.teamId], colorFor(t.teamId));
    });
  }

  function sharedRange(teams) {
    let min = Infinity, max = -Infinity, maxSold = 1;
    teams.forEach((t) =>
      candlesFor(t.teamId).forEach((c) => {
        min = Math.min(min, c.l, c.o, c.c);
        max = Math.max(max, c.h, c.o, c.c);
        maxSold = Math.max(maxSold, c.sold || 0);
      })
    );
    if (!isFinite(min)) {
      min = 0;
      max = 10000;
    }
    const pad = Math.max(200, (max - min) * 0.12);
    return { min: min - pad, max: max + pad, maxSold };
  }

  function rankedTeams() {
    return (state.teams || []).slice().sort((a, b) => currentValue(b) - currentValue(a));
  }

  function renderCandles() {
    const teams = state.teams || [];
    const grid = $('quote-grid');
    const cols = gridCols(teams.length);
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    grid.style.gridTemplateRows = 'repeat(' + Math.max(1, Math.ceil(teams.length / cols)) + ', minmax(0, 1fr))';
    const ids = teams.map((t) => t.teamId).join(',');
    if (grid.dataset.ids !== ids) {
      grid.dataset.ids = ids;
      grid.innerHTML = teams
        .map(
          (t) =>
            '<div class="quote" data-id="' + t.teamId + '"><div class="quote-head"><span class="sym">' + symbolFor(t.teamName) + '</span><span class="nm">' + escapeHtml(t.teamName) + '</span><span class="rk"></span></div>' +
            '<div class="quote-px"><span class="px"></span><span class="ch"></span></div><canvas></canvas></div>'
        )
        .join('');
    }
    const range = sharedRange(teams);
    const ranks = rankedTeams().map((t) => t.teamId);
    const live = phase === 'round_active' ? state.round : null;
    teams.forEach((t) => {
      const card = grid.querySelector('[data-id="' + t.teamId + '"]');
      if (!card) return;
      const cs = candlesFor(t.teamId);
      const last = cs[cs.length - 1];
      const v = currentValue(t);
      // change vs the previous close (= this candle's open), like a daily % change
      const ref = last ? last.o : v;
      const d = v - ref;
      card.querySelector('.px').textContent = money(v);
      const ch = card.querySelector('.ch');
      ch.className = 'ch ' + dirClass(d);
      ch.textContent = (d ? arrow(d) + ' ' + money(Math.abs(d)).replace('-', '') + '  ' : '') + pctText(d, ref);
      card.querySelector('.rk').textContent = '#' + (ranks.indexOf(t.teamId) + 1) + (t.locked && phase === 'round_active' ? ' · locked' : '');
      drawCandles(card.querySelector('canvas'), cs, range, live, colorFor(t.teamId));
    });
  }

  function renderIndex() {
    if (!state || !state.teams) return;
    const el = $('bc-index');
    el.innerHTML = rankedTeams()
      .map((t, i) => {
        const v = currentValue(t);
        const base = ipoValue(t);
        const d = v - base;
        return (
          '<div class="index-row' + (i === 0 && phase !== 'lobby' ? ' first' : '') + '"><span class="rk">' + (i + 1) + '</span>' +
          '<div style="min-width:0;"><div class="nm"><span class="dot" style="background:' + colorFor(t.teamId) + '; margin-right:6px;"></span>' + escapeHtml(t.teamName) + '</div>' +
          '<div class="sub">Tech ' + t.techLevel + ' · Capacity ' + t.capacityLevel + (t.isBot ? ' · bot' : '') + '</div></div>' +
          '<div class="val">' + money(v) + '<small class="' + dirClass(d) + '">' + (phase === 'lobby' ? 'Listing' : arrow(d) + ' ' + pctText(d, base)) + '</small></div></div>'
        );
      })
      .join('');
  }

  function renderBar() {
    $('bc-round').textContent = state.round || '—';
    $('bc-mp').textContent = state.marketPrice ? '$' + Math.round(state.marketPrice) : '—';
    $('bc-demand').textContent = state.totalDemand != null && phase !== 'lobby' ? state.totalDemand.toLocaleString() + ' chips' : '—';
    const pill = $('bc-phase');
    const text = $('bc-phase-text');
    pill.className = 'bc-phase';
    if (phase === 'lobby') {
      pill.classList.add('pre');
      text.textContent = 'Pre-market';
    } else if (phase === 'round_active') {
      pill.classList.add('live');
      text.textContent = state.paused ? 'Paused' : 'Market open';
    } else if (phase === 'round_results') {
      pill.classList.add('closed');
      text.textContent = 'Round closed';
    } else {
      pill.classList.add('closed');
      text.textContent = 'Final';
    }
    $('bc-timer-cell').style.display = phase === 'round_active' ? '' : 'none';
    if (phase === 'round_active' && state.timeLeft != null) setTimer(state.timeLeft);

    const tape = $('bc-tape');
    if (state.shock && phase !== 'lobby') {
      tape.classList.add('active');
      const tag = state.shock.categoryTag || 'MARKET';
      $('bc-shock-tag').innerHTML = Icons[CATEGORY_ICON[tag] || 'trending'] + (CATEGORY_LABEL[tag] || tag);
      $('bc-shock-title').textContent = state.shock.title;
      $('bc-shock-desc').textContent = state.shock.description;
      $('bc-shock-impact').textContent = state.shock.impact || '';
    } else tape.classList.remove('active');
  }

  function render() {
    if (!state) return;
    renderBar();
    renderIndex();
    const hasClosedCandle = (state.teams || []).some((t) => candlesFor(t.teamId).some((c) => c.round >= 1 && (c.round < state.round || phase !== 'round_active')));
    if (phase === 'lobby') {
      setView('view-premarket');
      renderPremarket();
    } else if (phase === 'round_active' && !hasClosedCandle) {
      setView('view-opening');
      renderOpening();
    } else {
      setView('view-candles');
      renderCandles();
    }
  }

  function setTimer(timeLeft) {
    const m = Math.max(0, Math.floor(timeLeft / 60)), s = Math.max(0, timeLeft % 60);
    $('bc-timer').textContent = m + ':' + String(s).padStart(2, '0');
    $('bc-timer').classList.toggle('low', timeLeft <= 20);
  }

  // ------------------------------------------------------------------
  // Socket wiring
  // ------------------------------------------------------------------
  socket.on('LOBBY_UPDATE', (payload) => {
    if (!connected) return;
    lobbyTeams = payload.teams || [];
    if (payload.phase === 'lobby') {
      phase = 'lobby';
      intraday = {};
      $('bc-results-overlay').classList.remove('active');
      render();
    }
  });
  socket.on('STATE_SYNC', (payload) => {
    if (!connected) return;
    state = payload;
    phase = payload.phase;
    if (phase === 'round_active') sampleIntraday(payload.teams || []);
    if (phase === 'round_active' || phase === 'lobby') $('bc-results-overlay').classList.remove('active');
    render();
  });
  socket.on('TIMER_TICK', ({ timeLeft }) => {
    if (!state) return;
    state.timeLeft = timeLeft;
    setTimer(timeLeft);
    if (phase === 'round_active') {
      sampleIntraday(state.teams || []);
      if ($('view-opening').classList.contains('active')) renderOpening();
    }
  });
  socket.on('ROUND_STARTING', ({ round }) => {
    $('bc-round').textContent = round;
    $('bc-shock-title').textContent = 'Reading the news…';
  });

  function showOverlay(kicker, title, headCells, rows, hint, autoHideMs) {
    $('bc-results-eyebrow').textContent = kicker;
    $('bc-results-title').textContent = title;
    $('bc-results-table').innerHTML = '<div class="bc-results-row head">' + headCells.map((h) => '<div>' + h + '</div>').join('') + '</div>' + rows.join('');
    $('bc-results-hint').textContent = hint;
    $('bc-results-overlay').classList.add('active');
    clearTimeout(resultsTimer);
    if (autoHideMs) resultsTimer = setTimeout(() => $('bc-results-overlay').classList.remove('active'), autoHideMs);
  }

  socket.on('ROUND_RESULT', (payload) => {
    if (!connected) return;
    const rows = (payload.results || []).map((r, idx) => {
      const c = candlesFor(r.teamId).find((x) => x.round === payload.round);
      const d = c ? c.c - c.o : 0;
      return (
        '<div class="bc-results-row' + (idx === 0 ? ' first' : '') + '"><div class="rank">' + (idx + 1) + '</div><div class="name">' + escapeHtml(r.teamName) + '</div>' +
        '<div>$' + r.price + '</div><div>' + r.quantitySold + '</div><div>' + money(r.revenue) + '</div>' +
        '<div class="' + dirClass(d) + '">' + (r.companyValue != null ? money(r.companyValue) : '—') + ' ' + arrow(d) + '</div></div>'
      );
    });
    showOverlay(
      'Market closed',
      'Round ' + payload.round + ' results',
      ['', 'Company', 'Price', 'Sold', 'Revenue', 'Value'],
      rows,
      payload.isFinalRound ? 'Final standings next.' : 'Candles update when this closes. Round ' + (payload.round + 1) + ' opens shortly.',
      payload.isFinalRound ? 0 : 11000
    );
  });
  socket.on('GAME_OVER', (payload) => {
    if (!connected) return;
    phase = 'game_over';
    if (payload.candles && state) state.candles = payload.candles;
    const rows = (payload.leaderboard || []).map((t, idx) => {
      const cs = (payload.candles && payload.candles[t.teamId]) || [];
      const base = cs.length ? cs[0].o : 0;
      const d = t.companyValue - base;
      const mvp = (t.contributions || []).slice().sort((a, b) => b.total - a.total)[0];
      return (
        '<div class="bc-results-row' + (idx === 0 ? ' first' : '') + '"><div class="rank">' + (idx + 1) + '</div><div class="name">' + escapeHtml(t.teamName) + '</div>' +
        '<div>T' + t.techLevel + ' C' + t.capacityLevel + '</div><div>' + t.inventory + '</div><div style="font-size:16px; color:var(--ink-2)">' + (mvp && mvp.total > 0 ? escapeHtml(mvp.memberName) : '—') + '</div>' +
        '<div class="' + dirClass(d) + '">' + money(t.companyValue) + ' <small>' + pctText(d, base) + '</small></div></div>'
      );
    });
    showOverlay(payload.winner ? 'Winner' : 'Final', payload.winner ? payload.winner.teamName + ' wins' : 'Game over', ['', 'Company', 'Levels', 'Chips left', 'MVP', 'Company value'], rows, 'Final candles stay on screen after this.', 20000);
    render();
  });

  socket.on('CHAT_MESSAGE', (msg) => {
    if (!connected || msg.kind !== 'system') return;
    addFeedRow(msg);
  });
  function addFeedRow(msg) {
    const feed = $('bc-feed');
    const row = document.createElement('div');
    row.className = 'row act-' + (msg.actionType || '');
    row.innerHTML = (Icons[ACTION_ICON[msg.actionType]] || Icons.trending) + '<span><b>' + escapeHtml(msg.name) + '</b>' + (msg.actor ? ' (' + escapeHtml(msg.actor) + ')' : '') + ' ' + escapeHtml(msg.text) + '</span>';
    feed.appendChild(row);
    while (feed.children.length > 14) feed.removeChild(feed.firstChild);
  }

  socket.on('CHAT_SYNC', (payload) => {
    const feed = $('bc-feed');
    feed.innerHTML = '';
    (payload.global || []).filter((m) => m.kind === 'system').slice(-14).forEach((m) => addFeedRow(m));
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());

  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(render, 120);
  });
})();
