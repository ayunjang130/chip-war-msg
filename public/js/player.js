(function () {
  const COMPANIES = ['Samsung', 'Intel', 'NVIDIA', 'TSMC', 'AMD', 'Qualcomm'];
  const TEAM_COLORS = ['#f0b429', '#5b8def', '#ff5c5c', '#35d488', '#c77edb', '#4fd1c5', '#f2d152', '#f28fb2'];
  const SESSION_KEY = 'chipwar_session';

  const socket = io();

  let myRoomCode = null;
  let myTeamId = null;
  let selectedCompany = null;
  let lastTicker = {}; // teamId -> "price:quantity" for whole-card flash-on-change
  let lastPriceByTeam = {}; // teamId -> last seen price, for per-value pop + direction arrow
  let lastQtyByTeam = {}; // teamId -> last seen quantity, same idea
  let priceTimer = null;
  let lastHistory = []; // full round-by-round data from the last completed match, for charts + CSV
  let charts = {};

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
  function activateScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }
  function routeScreen(phase) {
    if (!myTeamId) return;
    const map = { lobby: 'screen-lobby', round_active: 'screen-game', round_results: 'screen-results', game_over: 'screen-gameover' };
    const target = map[phase];
    if (!target) return;
    activateScreen(target);
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

  function forgetSession() {
    localStorage.removeItem(SESSION_KEY);
    myRoomCode = null;
    myTeamId = null;
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
        if (res && res.error === 'GAME_IN_PROGRESS') {
          activateScreen('screen-blocked');
          return;
        }
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
        forgetSession();
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
      row.style.alignItems = 'center';
      const label = '<b style="font-family:var(--display);">' + escapeHtml(t.teamName || t.companyName) + '</b> <span class="hint-text">(' + escapeHtml(t.companyName) + ')</span>';
      row.innerHTML =
        '<span class="dot" style="background:' + colorFor(t.teamId) + '"></span>' +
        '<span>' + label + (t.teamId === myTeamId ? ' (me)' : '') + '</span>' +
        (t.isBot ? '<span class="badge badge-bot">BOT</span>' : '') +
        (!t.connected && !t.isBot ? '<span class="badge badge-offline">OFFLINE</span>' : '');
      list.appendChild(row);
    });
  }

  // ---------- ticker ----------
  function valueHtml(id, value, lastMap) {
    const prev = lastMap[id];
    let cls = '';
    let arrow = '';
    if (prev != null && prev !== value) {
      const up = value > prev;
      cls = ' pop ' + (up ? 'up' : 'down');
      arrow = '<span class="value-arrow ' + (up ? 'up">▲' : 'down">▼') + '</span>';
    }
    lastMap[id] = value;
    return '<span class="flash-value' + cls + '">' + value + '</span>' + arrow;
  }
  function renderTicker(teams) {
    const el = $('ticker');
    el.innerHTML = '';
    teams.forEach((t) => {
      const key = t.price + ':' + t.quantity;
      const changed = lastTicker[t.teamId] != null && lastTicker[t.teamId] !== key;
      lastTicker[t.teamId] = key;
      const priceHtml = valueHtml(t.teamId, t.price, lastPriceByTeam);
      const qtyHtml = valueHtml(t.teamId, t.quantity, lastQtyByTeam);
      const card = document.createElement('div');
      card.className = 'ticker-card' + (changed ? ' flash' : '') + (!t.connected && !t.isBot ? ' offline' : '');
      card.style.setProperty('border-left', '3px solid ' + colorFor(t.teamId));
      card.innerHTML =
        '<div class="co">' + escapeHtml(t.teamName || t.companyName) + (t.teamId === myTeamId ? ' ★' : '') + '<span class="lock">' + (t.locked ? '🔒' : '⏳') + '</span></div>' +
        '<div class="sub">' + escapeHtml(t.companyName) + '</div>' +
        '<div class="row"><span>Price</span><b>$' + priceHtml + '</b></div>' +
        '<div class="row"><span>Qty</span><b>' + qtyHtml + '</b></div>' +
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
    $('shock-impact').textContent = shock.impact || 'No numeric change this round.';
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
    $('tech-cost').textContent = me.nextTechCost != null ? me.nextTechCost.toLocaleString() : '—';
    $('cap-cost').textContent = me.nextCapacityCost != null ? me.nextCapacityCost.toLocaleString() : '—';
    $('btn-buy-tech').disabled = me.locked || me.techLevel >= 5;
    $('btn-buy-cap').disabled = me.locked || me.capacityLevel >= 5;
    $('btn-buy-tech').textContent = me.techLevel >= 5 ? 'Maxed' : 'Buy ($' + (me.nextTechCost || 0).toLocaleString() + ')';
    $('btn-buy-cap').textContent = me.capacityLevel >= 5 ? 'Maxed' : 'Buy ($' + (me.nextCapacityCost || 0).toLocaleString() + ')';
    $('btn-undo-tech').disabled = me.locked || !me.canUndoTech;
    $('btn-undo-cap').disabled = me.locked || !me.canUndoCapacity;

    const priceInput = $('in-price');
    const qtyInput = $('in-qty');
    qtyInput.max = me.inventory;
    if (payload.maxPrice) {
      priceInput.max = payload.maxPrice;
      $('price-cap-hint').textContent = '(cap: $' + payload.maxPrice.toLocaleString() + ')';
    }
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
      $('res-shock-impact').textContent = payload.shock.impact || 'No numeric change this round.';
    } else {
      shockEl.style.display = 'none';
    }
    const body = $('res-table-body');
    body.innerHTML = '';
    payload.results.forEach((r, idx) => {
      const tr = document.createElement('tr');
      if (r.teamId === myTeamId) tr.classList.add('me');
      if (idx === 0) tr.classList.add('winner');
      const nameCell = '<b style="font-family:var(--display);">' + escapeHtml(r.teamName || r.companyName) + '</b> <span class="hint-text">(' + escapeHtml(r.companyName) + ')</span>';
      tr.innerHTML =
        '<td>' + nameCell + '</td>' +
        '<td>$' + r.price + '</td>' +
        '<td>' + r.quantitySold + '</td>' +
        '<td>' + money(r.revenue) + '</td>' +
        '<td>' + r.unsoldInventory + '</td>' +
        '<td>Lv' + r.techLevel + '</td>' +
        '<td>Lv' + r.capacityLevel + '</td>';
      body.appendChild(tr);
    });
    $('res-waiting-msg').textContent = payload.isFinalRound ? 'Calculating final results…' : 'Next round starts automatically — hang tight…';

    if (payload.results.length && payload.results[0].teamId === myTeamId && payload.results[0].revenue > 0) {
      triggerCelebration(payload.results[0].revenue);
    }
  }

  // ---------- round-winner celebration ----------
  function triggerCelebration(revenue) {
    const overlay = $('celebration-overlay');
    const rain = $('money-rain');
    rain.innerHTML = '';
    const emojis = ['💵', '💰', '🤑'];
    for (let i = 0; i < 26; i++) {
      const span = document.createElement('span');
      span.className = 'money-emoji';
      span.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      span.style.left = Math.random() * 100 + '%';
      span.style.animationDuration = 1.6 + Math.random() * 1.4 + 's';
      span.style.animationDelay = Math.random() * 0.6 + 's';
      rain.appendChild(span);
    }
    $('celebration-sub').textContent = money(revenue) + ' revenue — best in the round!';
    overlay.classList.add('active');
    setTimeout(() => {
      overlay.classList.remove('active');
      rain.innerHTML = '';
    }, 3200);
  }

  function renderGameOver(payload) {
    $('final-winner-banner').textContent = payload.winner ? '🏆 ' + (payload.winner.teamName || payload.winner.companyName) + ' wins' : 'Game over';
    const el = $('final-leaderboard');
    el.innerHTML = '';
    payload.leaderboard.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row' + (idx === 0 ? ' first' : '');
      const nameLine = '<b style="font-family:var(--display);">' + escapeHtml(t.teamName || t.companyName) + '</b> <span class="hint-text" style="font-weight:400;">(' + escapeHtml(t.companyName) + ')</span>';
      row.innerHTML =
        '<div class="rank">' + (idx + 1) + '</div>' +
        '<div class="name">' + nameLine +
        '<div class="hint-text">capital ' + money(t.capital) + ' · inventory ' + t.inventory + ' (+' + money(t.inventory * 10) + ') · tech Lv' + t.techLevel + ' (+' + money(t.techLevel * 500) + ') · capacity Lv' + t.capacityLevel + ' (+' + money(t.capacityLevel * 500) + ')</div></div>' +
        '<div class="value">' + money(t.companyValue) + '</div>';
      el.appendChild(row);
    });
    lastHistory = payload.history || [];
    renderCharts(lastHistory);
  }

  // ---------- post-match charts + CSV export ----------
  function destroyCharts() {
    Object.values(charts).forEach((c) => c && c.destroy());
    charts = {};
  }
  function chartOptions() {
    return {
      responsive: true,
      plugins: { legend: { labels: { color: '#e7edf5', font: { family: 'Inter' } } } },
      scales: {
        x: { ticks: { color: '#7d8798' }, grid: { color: '#212a3a' } },
        y: { ticks: { color: '#7d8798' }, grid: { color: '#212a3a' } }
      }
    };
  }
  function renderCharts(history) {
    destroyCharts();
    if (!history || !history.length || typeof Chart === 'undefined') return;
    const labels = history.map((h) => 'R' + h.round);
    const teamIds = [];
    const teamMeta = {};
    history.forEach((h) =>
      h.results.forEach((r) => {
        if (!(r.teamId in teamMeta)) teamIds.push(r.teamId);
        teamMeta[r.teamId] = r.companyName;
      })
    );
    const seriesFor = (pick) =>
      teamIds.map((id) => ({
        label: teamMeta[id],
        data: history.map((h) => {
          const r = h.results.find((x) => x.teamId === id);
          return r ? pick(r) : null;
        }),
        borderColor: colorFor(id),
        backgroundColor: colorFor(id),
        tension: 0.25,
        spanGaps: true
      }));

    const valueData = seriesFor((r) => r.capital + r.unsoldInventory * 10 + r.techLevel * 500 + r.capacityLevel * 500);
    const priceData = seriesFor((r) => r.price);
    const mpData = [{ label: 'Market Price', data: history.map((h) => h.marketPrice), borderColor: '#f0b429', backgroundColor: '#f0b429', tension: 0.25 }];

    if ($('chart-value')) charts.value = new Chart($('chart-value').getContext('2d'), { type: 'line', data: { labels, datasets: valueData }, options: chartOptions() });
    if ($('chart-price')) charts.price = new Chart($('chart-price').getContext('2d'), { type: 'line', data: { labels, datasets: priceData }, options: chartOptions() });
    if ($('chart-mp')) charts.mp = new Chart($('chart-mp').getContext('2d'), { type: 'line', data: { labels, datasets: mpData }, options: chartOptions() });
  }

  function downloadMatchCSV() {
    if (!lastHistory || !lastHistory.length) return;
    const rows = [['round', 'marketPrice', 'shockTitle', 'teamName', 'companyName', 'price', 'quantityOffered', 'quantitySold', 'revenue', 'unsoldInventory', 'capital', 'techLevel', 'capacityLevel', 'competitiveScore']];
    lastHistory.forEach((h) => {
      h.results.forEach((r) => {
        rows.push([h.round, h.marketPrice, h.shock ? h.shock.title : '', r.teamName || '', r.companyName, r.price, r.quantityOffered, r.quantitySold, r.revenue, r.unsoldInventory, r.capital, r.techLevel, r.capacityLevel, r.competitiveScore]);
      });
    });
    const csv = rows
      .map((row) =>
        row
          .map((cell) => {
            const s = String(cell == null ? '' : cell);
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
          })
          .join(',')
      )
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'chip-war-match-' + (myRoomCode || 'data') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
  function appendSystemChat(text) {
    const log = $('chat-log');
    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.style.color = 'var(--red)';
    row.textContent = '⚠️ ' + text;
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
  $('btn-undo-tech').addEventListener('click', () => socket.emit('TEAM_UNDO_INVEST', { roomCode: myRoomCode, teamId: myTeamId, kind: 'tech' }));
  $('btn-undo-cap').addEventListener('click', () => socket.emit('TEAM_UNDO_INVEST', { roomCode: myRoomCode, teamId: myTeamId, kind: 'capacity' }));
  $('in-price').addEventListener('input', sendInputUpdate);
  $('in-qty').addEventListener('input', sendInputUpdate);
  $('btn-lockin').addEventListener('click', () => {
    const price = Number($('in-price').value) || 0;
    const qty = Number($('in-qty').value) || 0;
    let warning = null;
    if (qty === 0 && price === 0) warning = "You're about to lock in with $0 price AND 0 units offered — Apple can't buy anything from you this round. Continue anyway?";
    else if (qty === 0) warning = "You're about to lock in with 0 units offered — Apple can't buy anything from you this round. Continue anyway?";
    else if (price === 0) warning = "You're about to lock in with a $0 price — Apple would get your chips for free. Continue anyway?";
    if (warning && !confirm(warning)) return;
    socket.emit('LOCK_IN', { roomCode: myRoomCode, teamId: myTeamId });
  });
  $('btn-chat-send').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  function leaveRoom() {
    if (!confirm('Leave this room?')) return;
    socket.emit('LEAVE_ROOM', { roomCode: myRoomCode, teamId: myTeamId });
    forgetSession();
    $('in-roomcode').value = '';
    $('in-teamname').value = '';
    activateScreen('screen-join');
  }
  $('btn-leave-room').addEventListener('click', leaveRoom);
  $('btn-leave-room-final').addEventListener('click', leaveRoom);
  $('btn-exit-blocked').addEventListener('click', () => {
    $('in-roomcode').value = '';
    activateScreen('screen-join');
  });
  $('btn-download-csv').addEventListener('click', downloadMatchCSV);

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
  socket.on('CHAT_BLOCKED', ({ reason }) => appendSystemChat(reason || 'Message blocked.'));
  socket.on('ROOM_CLOSED', ({ reason }) => {
    alert(reason || 'The host has closed this room.');
    forgetSession();
    activateScreen('screen-join');
  });
  socket.on('KICKED', ({ reason }) => {
    alert(reason || 'You were removed from this room.');
    forgetSession();
    activateScreen('screen-join');
  });

  renderCompanyOptions();
  tryAutoRejoin();
})();
