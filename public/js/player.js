(function () {
  const COMPANIES = ['Samsung', 'Intel', 'NVIDIA', 'TSMC', 'AMD', 'Qualcomm'];
  const TEAM_COLORS = ['#f0b429', '#5b8def', '#ff5c5c', '#35d488', '#c77edb', '#4fd1c5', '#f2d152', '#f28fb2'];
  const SESSION_KEY = 'chipwar_session';

  const socket = io();

  let myRoomCode = null;
  let myTeamId = null;
  let selectedCompany = null;
  let lastTicker = {}; // teamId -> "price:quantity" for flash-on-change
  let priceTimer = null;

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  function money(n) {
    n = Math.round(n || 0);
    return n < 0 ? '-$' + Math.abs(n).toLocaleString() : '$' + n.toLocaleString();
  }
  function colorFor(teamId) {
    let h = 0;
    for (let i = 0; i < teamId.length; i++) h = (h * 31 + teamId.charCodeAt(i)) | 0;
    return TEAM_COLORS[Math.abs(h) % TEAM_COLORS.length];
  }
  function routeScreen(phase) {
    if (!myTeamId) return;
    const map = { lobby: 'screen-lobby', round_active: 'screen-game', round_results: 'screen-results', game_over: 'screen-gameover' };
    const target = map[phase];
    if (!target) return;
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(target).classList.add('active');
  }

  // ---------- join screen ----------
  function renderCompanyOptions() {
    const el = $('company-select');
    el.innerHTML = '';
    COMPANIES.forEach((name) => {
      const div = document.createElement('div');
      div.className = 'company-opt';
      div.textContent = name;
      div.addEventListener('click', () => {
        selectedCompany = name;
        document.querySelectorAll('.company-opt').forEach((o) => o.classList.remove('selected'));
        div.classList.add('selected');
      });
      el.appendChild(div);
    });
  }

  function doJoin() {
    const roomCode = $('in-roomcode').value.trim().toUpperCase();
    const teamName = $('in-teamname').value.trim();
    const err = $('join-error');
    err.textContent = '';
    if (!roomCode) return (err.textContent = 'Enter a room code.');
    if (!selectedCompany) return (err.textContent = 'Pick a company identity.');

    const btn = $('btn-join');
    btn.disabled = true;
    btn.textContent = 'Joining…';
    socket.emit('JOIN_ROOM', { roomCode, teamName, companyName: selectedCompany }, (res) => {
      btn.disabled = false;
      btn.textContent = 'Join room';
      if (!res || !res.ok) {
        err.textContent = res && res.error === 'ROOM_FULL' ? 'That room is full.' : 'Room not found — check the code.';
        return;
      }
      myRoomCode = res.roomCode;
      myTeamId = res.teamId;
      localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: myRoomCode, teamId: myTeamId }));
    });
  }

  function tryAutoRejoin() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
      saved = null;
    }
    if (!saved || !saved.roomCode || !saved.teamId) return;
    socket.emit('JOIN_ROOM', { roomCode: saved.roomCode, teamId: saved.teamId }, (res) => {
      if (res && res.ok) {
        myRoomCode = res.roomCode;
        myTeamId = res.teamId;
      } else {
        localStorage.removeItem(SESSION_KEY);
      }
    });
  }

  // ---------- lobby screen ----------
  function renderLobby(payload) {
    $('lobby-roomcode').textContent = payload.roomCode;
    $('lobby-count').textContent = payload.teams.length;
    const me = payload.teams.find((t) => t.teamId === myTeamId);
    $('lobby-company').textContent = me ? me.companyName : '—';
    const list = $('lobby-team-list');
    list.innerHTML = '';
    payload.teams.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'pill';
      row.style.justifyContent = 'flex-start';
      row.innerHTML =
        '<span class="dot" style="background:' + colorFor(t.teamId) + '"></span>' +
        '<span>' + t.companyName + (t.teamId === myTeamId ? ' (me)' : '') + '</span>' +
        (t.isBot ? '<span class="badge badge-bot">BOT</span>' : '') +
        (!t.connected && !t.isBot ? '<span class="badge badge-offline">OFFLINE</span>' : '');
      list.appendChild(row);
    });
  }

  // ---------- ticker ----------
  function renderTicker(teams) {
    const el = $('ticker');
    el.innerHTML = '';
    teams.forEach((t) => {
      const key = t.price + ':' + t.quantity;
      const changed = lastTicker[t.teamId] != null && lastTicker[t.teamId] !== key;
      lastTicker[t.teamId] = key;
      const card = document.createElement('div');
      card.className = 'ticker-card' + (changed ? ' flash' : '') + (!t.connected && !t.isBot ? ' offline' : '');
      card.style.setProperty('border-left', '3px solid ' + colorFor(t.teamId));
      card.innerHTML =
        '<div class="co">' + t.companyName + (t.teamId === myTeamId ? ' ★' : '') + '<span class="lock">' + (t.locked ? '🔒' : '⏳') + '</span></div>' +
        '<div class="row"><span>Price</span><b>$' + t.price + '</b></div>' +
        '<div class="row"><span>Qty</span><b>' + t.quantity + '</b></div>' +
        '<div class="row"><span>Tech / Cap</span><b>Lv' + t.techLevel + ' / Lv' + t.capacityLevel + '</b></div>';
      el.appendChild(card);
    });
  }

  // ---------- market shock + live rank preview ----------
  function showShockLoading() {
    $('shock-loading').style.display = 'flex';
    $('shock-banner').style.display = 'none';
  }
  function renderShock(shock) {
    $('shock-loading').style.display = 'none';
    const el = $('shock-banner');
    if (!shock) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    el.classList.toggle('ai', shock.source === 'ai');
    $('shock-icon').textContent = shock.icon || '⚡';
    $('shock-title').textContent = shock.title;
    $('shock-desc').textContent = shock.description;
  }
  function renderRankPreview(preview) {
    const el = $('rank-preview');
    if (!preview) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    el.classList.remove('safe', 'caution', 'risk');
    el.classList.add(preview.status);
    const label = preview.status === 'safe' ? 'On track to sell out' : preview.status === 'caution' ? `Only ${preview.predictedSold}/${preview.offered} would sell` : preview.offered === 0 ? 'Offering 0 units — nothing will sell' : 'Priced/scored too low — likely 0 sold';
    $('rank-preview-text').textContent = `Predicted rank: ${preview.rank}/${preview.totalTeams} — ${label}`;
  }

  // ---------- game screen ----------
  function renderDots(containerId, level) {
    const el = $(containerId);
    el.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const d = document.createElement('div');
      d.className = 'lvl-dot' + (i < level ? ' filled' : '');
      el.appendChild(d);
    }
  }

  function renderGameState(payload) {
    $('hdr-round').textContent = payload.round;
    $('hdr-total-rounds').textContent = payload.totalRounds;
    $('hdr-mp').textContent = payload.marketPrice ? payload.marketPrice.toFixed(0) : '—';
    renderShock(payload.shock);

    renderTicker(payload.teams);

    const me = payload.teams.find((t) => t.teamId === myTeamId);
    if (!me) return;

    $('hdr-me').textContent = me.companyName;
    $('my-capital').textContent = money(me.capital);
    $('my-capital').className = 'v' + (me.capital < 0 ? ' neg' : '');
    $('my-inventory').textContent = me.inventory;
    $('inventory-hint').textContent = 'Available inventory: ' + me.inventory + ' units';

    renderDots('tech-dots', me.techLevel);
    renderDots('cap-dots', me.capacityLevel);
    $('tech-level').textContent = me.techLevel;
    $('cap-level').textContent = me.capacityLevel;
    $('btn-buy-tech').disabled = me.locked || me.techLevel >= 5;
    $('btn-buy-cap').disabled = me.locked || me.capacityLevel >= 5;
    $('btn-buy-tech').textContent = me.techLevel >= 5 ? 'Maxed' : 'Buy ($2,000)';
    $('btn-buy-cap').textContent = me.capacityLevel >= 5 ? 'Maxed' : 'Buy ($1,500)';

    const priceInput = $('in-price');
    const qtyInput = $('in-qty');
    qtyInput.max = me.inventory;
    if (document.activeElement !== priceInput) priceInput.value = me.price;
    if (document.activeElement !== qtyInput) qtyInput.value = me.quantity;
    priceInput.disabled = me.locked;
    qtyInput.disabled = me.locked;

    $('btn-lockin').disabled = me.locked;
    $('btn-lockin').textContent = me.locked ? 'Locked in' : 'Lock In';
    $('lockin-status').textContent = me.locked
      ? '🔒 Locked in — waiting for other teams…'
      : "Locking in freezes your price and quantity for this round — you can't undo it.";
    renderRankPreview(payload.phase === 'round_active' ? payload.preview : null);
  }

  function sendInputUpdate() {
    clearTimeout(priceTimer);
    priceTimer = setTimeout(() => {
      socket.emit('UPDATE_INPUT', {
        roomCode: myRoomCode,
        teamId: myTeamId,
        price: Number($('in-price').value) || 0,
        quantity: Number($('in-qty').value) || 0
      });
    }, 120);
  }

  function updateTimer(timeLeft) {
    const m = Math.max(0, Math.floor(timeLeft / 60));
    const s = Math.max(0, timeLeft % 60);
    const el = $('hdr-timer');
    el.textContent = m + ':' + String(s).padStart(2, '0');
    el.classList.remove('warn', 'danger');
    if (timeLeft <= 20) el.classList.add('danger');
    else if (timeLeft <= 60) el.classList.add('warn');
  }

  // ---------- results / game over ----------
  function renderResults(payload) {
    $('res-round').textContent = payload.round;
    $('res-mp').textContent = payload.marketPrice.toFixed(0);
    const shockEl = $('res-shock-banner');
    if (payload.shock) {
      shockEl.style.display = 'flex';
      $('res-shock-icon').textContent = payload.shock.icon || '⚡';
      $('res-shock-title').textContent = payload.shock.title;
      $('res-shock-desc').textContent = payload.shock.description;
    } else {
      shockEl.style.display = 'none';
    }
    const body = $('res-table-body');
    body.innerHTML = '';
    payload.results.forEach((r, idx) => {
      const tr = document.createElement('tr');
      if (r.teamId === myTeamId) tr.classList.add('me');
      if (idx === 0) tr.classList.add('winner');
      tr.innerHTML =
        '<td>' + r.companyName + '</td>' +
        '<td>$' + r.price + '</td>' +
        '<td>' + r.quantitySold + '</td>' +
        '<td>' + money(r.revenue) + '</td>' +
        '<td>' + r.unsoldInventory + '</td>' +
        '<td>Lv' + r.techLevel + '</td>' +
        '<td>Lv' + r.capacityLevel + '</td>';
      body.appendChild(tr);
    });
    $('res-waiting-msg').textContent = payload.isFinalRound ? 'Calculating final results…' : 'Next round starts automatically — hang tight…';
  }

  function renderGameOver(payload) {
    $('final-winner-banner').textContent = payload.winner ? '🏆 ' + payload.winner.companyName + ' wins' : 'Game over';
    const el = $('final-leaderboard');
    el.innerHTML = '';
    payload.leaderboard.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row' + (idx === 0 ? ' first' : '');
      row.innerHTML =
        '<div class="rank">' + (idx + 1) + '</div>' +
        '<div class="name"><b>' + t.companyName + '</b>' +
        '<div class="hint-text">capital ' + money(t.capital) + ' · inventory ' + t.inventory + ' (+' + money(t.inventory * 10) + ') · tech Lv' + t.techLevel + ' (+' + money(t.techLevel * 500) + ') · capacity Lv' + t.capacityLevel + ' (+' + money(t.capacityLevel * 500) + ')</div></div>' +
        '<div class="value">' + money(t.companyValue) + '</div>';
      el.appendChild(row);
    });
  }

  // ---------- chat ----------
  function appendChat(msg) {
    const log = $('chat-log');
    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.innerHTML = '<span class="who" style="color:' + colorFor(msg.name) + '">' + msg.name + ':</span> ' + escapeHtml(msg.text);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sendChat() {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('CHAT_MESSAGE', { roomCode: myRoomCode, teamId: myTeamId, text });
    input.value = '';
  }

  // ---------- how-to-play modal ----------
  const HOWTO_SEEN_KEY = 'chipwar_seen_howto';
  function openHowTo() { $('howto-modal').classList.add('active'); }
  function closeHowTo() {
    $('howto-modal').classList.remove('active');
    localStorage.setItem(HOWTO_SEEN_KEY, '1');
  }
  $('btn-help-fab').addEventListener('click', openHowTo);
  $('btn-howto-close').addEventListener('click', closeHowTo);
  $('btn-howto-gotit').addEventListener('click', closeHowTo);
  $('link-howto-join').addEventListener('click', (e) => { e.preventDefault(); openHowTo(); });
  if (!localStorage.getItem(HOWTO_SEEN_KEY)) openHowTo();

  // ---------- wire up ----------
  $('btn-join').addEventListener('click', doJoin);
  ['in-roomcode', 'in-teamname'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); }));
  $('btn-buy-tech').addEventListener('click', () => socket.emit('TEAM_INVEST', { roomCode: myRoomCode, teamId: myTeamId, kind: 'tech' }));
  $('btn-buy-cap').addEventListener('click', () => socket.emit('TEAM_INVEST', { roomCode: myRoomCode, teamId: myTeamId, kind: 'capacity' }));
  $('in-price').addEventListener('input', sendInputUpdate);
  $('in-qty').addEventListener('input', sendInputUpdate);
  $('btn-lockin').addEventListener('click', () => {
    const qty = Number($('in-qty').value) || 0;
    if (qty === 0 && !confirm("You're about to lock in with 0 units offered — Apple can't buy anything from you this round. Continue anyway?")) return;
    socket.emit('LOCK_IN', { roomCode: myRoomCode, teamId: myTeamId });
  });
  $('btn-chat-send').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });

  socket.on('LOBBY_UPDATE', (payload) => {
    if (!myTeamId || !payload.teams.some((t) => t.teamId === myTeamId)) return;
    renderLobby(payload);
    routeScreen(payload.phase);
  });
  socket.on('STATE_SYNC', (payload) => {
    if (!myTeamId) return;
    renderGameState(payload);
    if (payload.phase === 'round_active') routeScreen('round_active');
  });
  socket.on('ROUND_STARTING', () => {
    routeScreen('round_active');
    showShockLoading();
  });
  socket.on('ROUND_START', (payload) => {
    lastTicker = {};
    routeScreen('round_active');
    if (payload && payload.shock) renderShock(payload.shock);
  });
  socket.on('TIMER_TICK', ({ timeLeft }) => updateTimer(timeLeft));
  socket.on('ROUND_RESULT', (payload) => {
    renderResults(payload);
    routeScreen('round_results');
  });
  socket.on('GAME_OVER', (payload) => {
    renderGameOver(payload);
    routeScreen('game_over');
  });
  socket.on('CHAT_MESSAGE', appendChat);

  renderCompanyOptions();
  tryAutoRejoin();
})();
