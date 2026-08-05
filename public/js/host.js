(function () {
  const TEAM_COLORS = ['#f0b429', '#5b8def', '#ff5c5c', '#35d488', '#c77edb', '#4fd1c5', '#f2d152', '#f28fb2'];
  const HOST_SESSION_KEY = 'chipwar_host_room';

  const socket = io();
  let myRoomCode = null;
  let lastPhase = 'lobby';

  const $ = (id) => document.getElementById(id);
  function money(n) {
    n = Math.round(n || 0);
    return n < 0 ? '-$' + Math.abs(n).toLocaleString() : '$' + n.toLocaleString();
  }
  function colorFor(key) {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return TEAM_COLORS[Math.abs(h) % TEAM_COLORS.length];
  }
  function routeScreen(phase) {
    const map = { lobby: 'screen-lobby', round_active: 'screen-live', round_results: 'screen-live', game_over: 'screen-gameover' };
    const target = map[phase];
    if (!target) return;
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(target).classList.add('active');
    $('live-results-card').style.display = phase === 'round_results' ? 'block' : 'none';
    lastPhase = phase;
  }

  // ---------- rules summary modal ----------
  function openHowTo() { $('howto-modal').classList.add('active'); }
  function closeHowTo() { $('howto-modal').classList.remove('active'); }
  $('btn-help-fab').addEventListener('click', openHowTo);
  $('btn-howto-close').addEventListener('click', closeHowTo);
  $('btn-howto-gotit').addEventListener('click', closeHowTo);

  // ---------- AI shock status ----------
  function renderAiStatus(aiEnabled) {
    const el = $('ai-shock-status');
    el.textContent = aiEnabled ? '✨ AI-generated market shocks: ON' : '🔧 Using built-in shock templates (no ANTHROPIC_API_KEY set)';
    el.style.borderColor = aiEnabled ? 'rgba(139,124,246,0.5)' : 'var(--line)';
    el.style.color = aiEnabled ? '#c4b5fd' : 'var(--ink-dim)';
  }

  // ---------- market shock (host sees numeric effects too) ----------
  function showShockLoading() {
    $('shock-loading').style.display = 'flex';
    $('shock-banner').style.display = 'none';
  }
  function summarizeEffects(effects) {
    if (!effects) return '';
    const parts = [];
    if (effects.capacityProductionMultiplier !== 1) parts.push(`Capacity production ×${effects.capacityProductionMultiplier}`);
    if (effects.techUpgradeCostMultiplier !== 1) parts.push(`Tech cost ×${effects.techUpgradeCostMultiplier}`);
    if (effects.capacityUpgradeCostMultiplier !== 1) parts.push(`Capacity cost ×${effects.capacityUpgradeCostMultiplier}`);
    if (effects.demandMultiplier !== 1) parts.push(`Demand ×${effects.demandMultiplier}`);
    const b = effects.weightBias || {};
    if (b.price !== 1) parts.push(`Price weight ×${b.price}`);
    if (b.tech !== 1) parts.push(`Tech weight ×${b.tech}`);
    if (b.capacity !== 1) parts.push(`Capacity weight ×${b.capacity}`);
    return parts.length ? parts.join(' · ') : 'No numeric changes this round.';
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
    $('shock-effects').textContent = summarizeEffects(shock.effects);
  }

  // ---------- setup screen ----------
  $('btn-create-room').addEventListener('click', () => {
    socket.emit('HOST_CREATE_ROOM', {}, (res) => {
      if (!res || !res.ok) return ($('setup-error').textContent = 'Could not create a room. Try refreshing.');
      myRoomCode = res.roomCode;
      localStorage.setItem(HOST_SESSION_KEY, myRoomCode);
      $('lobby-roomcode').textContent = myRoomCode;
      renderAiStatus(res.aiEnabled);
      routeScreen('lobby');
    });
  });

  function tryAutoRejoin() {
    const saved = localStorage.getItem(HOST_SESSION_KEY);
    if (!saved) return;
    socket.emit('HOST_REJOIN', { roomCode: saved }, (res) => {
      if (res && res.ok) {
        myRoomCode = res.roomCode;
        $('lobby-roomcode').textContent = myRoomCode;
        renderAiStatus(res.aiEnabled);
        applyConfigToInputs(res.config);
        routeScreen(lastPhase); // will be corrected by the LOBBY_UPDATE/STATE_SYNC that follows
      } else {
        localStorage.removeItem(HOST_SESSION_KEY);
      }
    });
  }

  function applyConfigToInputs(config) {
    if (!config) return;
    $('cfg-wp').value = config.weights.price;
    $('cfg-wt').value = config.weights.tech;
    $('cfg-wc').value = config.weights.capacity;
    $('cfg-demand').value = config.demandPerTeam;
    $('cfg-timer').value = config.roundTimerSeconds;
    $('cfg-maxteams').value = config.maxTeams;
    $('team-max').textContent = config.maxTeams;
    updateWeightHint();
  }

  function updateWeightHint() {
    const sum = (Number($('cfg-wp').value) || 0) + (Number($('cfg-wt').value) || 0) + (Number($('cfg-wc').value) || 0);
    $('weight-sum-hint').textContent = 'Sum: ' + sum.toFixed(2) + ' (auto-normalized on save either way)';
  }
  ['cfg-wp', 'cfg-wt', 'cfg-wc'].forEach((id) => $(id).addEventListener('input', updateWeightHint));

  $('btn-save-config').addEventListener('click', () => {
    socket.emit('HOST_UPDATE_CONFIG', {
      roomCode: myRoomCode,
      config: {
        weights: { price: Number($('cfg-wp').value) || 0, tech: Number($('cfg-wt').value) || 0, capacity: Number($('cfg-wc').value) || 0 },
        demandPerTeam: Number($('cfg-demand').value) || 200,
        roundTimerSeconds: Number($('cfg-timer').value) || 180,
        maxTeams: Number($('cfg-maxteams').value) || 8
      }
    });
    $('config-saved-hint').textContent = 'Saved ✓';
    setTimeout(() => ($('config-saved-hint').textContent = ''), 1500);
  });

  document.querySelectorAll('[data-bot]').forEach((btn) => {
    btn.addEventListener('click', () => socket.emit('HOST_ADD_BOT', { roomCode: myRoomCode, strategy: btn.dataset.bot }));
  });

  $('btn-start-game').addEventListener('click', () => {
    $('start-error').textContent = '';
    socket.emit('HOST_START_GAME', { roomCode: myRoomCode });
  });

  // ---------- live monitor ----------
  function renderTeamList(payload) {
    $('team-count').textContent = payload.teams.length;
    $('team-max').textContent = payload.config.maxTeams;
    const list = $('team-list');
    list.innerHTML = '';
    payload.teams.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'pill';
      row.style.justifyContent = 'flex-start';
      row.innerHTML =
        '<span class="dot" style="background:' + colorFor(t.teamId) + '"></span>' +
        '<span style="flex:1">' + t.companyName + '</span>' +
        (t.isBot ? '<span class="badge badge-bot">BOT</span>' : '') +
        (!t.connected && !t.isBot ? '<span class="badge badge-offline">OFFLINE</span>' : '') +
        '<button class="btn btn-sm btn-red" data-kick="' + t.teamId + '" style="margin-left:8px;">Kick</button>';
      list.appendChild(row);
    });
    list.querySelectorAll('[data-kick]').forEach((b) => {
      b.addEventListener('click', () => socket.emit('HOST_KICK_TEAM', { roomCode: myRoomCode, teamId: b.dataset.kick }));
    });
    $('btn-start-game').disabled = payload.teams.length < 3;
    if (payload.teams.length < 3) $('start-error').textContent = 'Need at least 3 teams to start.';
  }

  function renderLiveTable(payload) {
    $('live-round').textContent = payload.round;
    $('live-mp').textContent = payload.marketPrice ? payload.marketPrice.toFixed(0) : '—';
    renderShock(payload.shock);
    const body = $('live-table-body');
    body.innerHTML = '';
    payload.teams.forEach((t) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="color:' + colorFor(t.teamId) + '">' + t.companyName + (t.isBot ? ' 🤖' : '') + '</td>' +
        '<td>' + (t.locked ? '🔒' : '⏳') + '</td>' +
        '<td>$' + t.price + '</td>' +
        '<td>' + t.quantity + '</td>' +
        '<td>Lv' + t.techLevel + '</td>' +
        '<td>Lv' + t.capacityLevel + '</td>' +
        '<td>' + (t.capital != null ? money(t.capital) : '—') + '</td>';
      body.appendChild(tr);
    });
  }

  function updateTimer(timeLeft) {
    const m = Math.max(0, Math.floor(timeLeft / 60));
    const s = Math.max(0, timeLeft % 60);
    const el = $('live-timer');
    el.textContent = m + ':' + String(s).padStart(2, '0');
    el.classList.remove('warn', 'danger');
    if (timeLeft <= 20) el.classList.add('danger');
    else if (timeLeft <= 60) el.classList.add('warn');
  }

  function renderRoundResults(payload) {
    const body = $('live-results-body');
    body.innerHTML = '';
    payload.results.forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="color:' + colorFor(r.teamId) + '">' + r.companyName + '</td>' +
        '<td>$' + r.price + '</td>' +
        '<td>' + r.quantitySold + '</td>' +
        '<td>' + money(r.revenue) + '</td>' +
        '<td>' + r.unsoldInventory + '</td>';
      body.appendChild(tr);
    });
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
        '<div class="hint-text">capital ' + money(t.capital) + ' · inventory ' + t.inventory + ' · tech Lv' + t.techLevel + ' · capacity Lv' + t.capacityLevel + '</div></div>' +
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
  $('btn-chat-send').addEventListener('click', () => {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('CHAT_MESSAGE', { roomCode: myRoomCode, text });
    input.value = '';
  });
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-chat-send').click(); });

  // ---------- controls ----------
  $('btn-pause').addEventListener('click', () => socket.emit('HOST_PAUSE_TIMER', { roomCode: myRoomCode }));
  $('btn-resume').addEventListener('click', () => socket.emit('HOST_RESUME_TIMER', { roomCode: myRoomCode }));
  $('btn-skip').addEventListener('click', () => socket.emit('HOST_FORCE_SKIP', { roomCode: myRoomCode }));
  $('btn-next-round').addEventListener('click', () => socket.emit('HOST_NEXT_ROUND', { roomCode: myRoomCode }));
  $('btn-reset').addEventListener('click', () => socket.emit('HOST_RESET_GAME', { roomCode: myRoomCode }));

  // ---------- socket events ----------
  socket.on('LOBBY_UPDATE', (payload) => {
    if (payload.roomCode !== myRoomCode) return;
    renderTeamList(payload);
    if (payload.phase === 'lobby') routeScreen('lobby');
  });
  socket.on('STATE_SYNC', (payload) => {
    if (!myRoomCode) return;
    renderLiveTable(payload);
    routeScreen(payload.phase);
  });
  socket.on('ROUND_STARTING', () => {
    routeScreen('round_active');
    showShockLoading();
  });
  socket.on('ROUND_START', () => routeScreen('round_active'));
  socket.on('TIMER_TICK', ({ timeLeft }) => updateTimer(timeLeft));
  socket.on('ROUND_RESULT', (payload) => {
    renderRoundResults(payload);
    routeScreen('round_results');
  });
  socket.on('GAME_OVER', (payload) => {
    renderGameOver(payload);
    routeScreen('game_over');
  });
  socket.on('CHAT_MESSAGE', appendChat);

  tryAutoRejoin();
})();
