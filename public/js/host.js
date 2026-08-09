(function () {
  const TEAM_COLORS = ['#f0b429', '#5b8def', '#ff5c5c', '#35d488', '#c77edb', '#4fd1c5', '#f2d152', '#f28fb2'];
  const HOST_SESSION_KEY = 'chipwar_host_room';

  const socket = io();
  let myRoomCode = null;
  let lastPhase = 'lobby';
  let lastHistory = [];
  let charts = {};

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
    $('shock-effects').textContent = (shock.impact || '') + '  |  raw: ' + summarizeEffects(shock.effects);
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
    $('cfg-capital').value = config.startingCapital;
    $('cfg-inflation').value = config.inflationRatePerRound;
    $('cfg-volatility').value = config.marketVolatility;
    $('team-max').textContent = config.maxTeams;
    // Keep the live-monitor mini panel in sync too, so it always shows
    // what's actually active, not just what was last typed there.
    if (document.activeElement !== $('live-cfg-demand')) $('live-cfg-demand').value = config.demandPerTeam;
    if (document.activeElement !== $('live-cfg-timer')) $('live-cfg-timer').value = config.roundTimerSeconds;
    if (document.activeElement !== $('live-cfg-volatility')) $('live-cfg-volatility').value = config.marketVolatility;
    updateWeightHint();
  }

  function updateWeightHint() {
    const sum = (Number($('cfg-wp').value) || 0) + (Number($('cfg-wt').value) || 0) + (Number($('cfg-wc').value) || 0);
    $('weight-sum-hint').textContent = 'Sum: ' + sum.toFixed(2) + ' (auto-normalized on save either way)';
  }
  ['cfg-wp', 'cfg-wt', 'cfg-wc'].forEach((id) => $(id).addEventListener('input', updateWeightHint));

  $('btn-toggle-advanced').addEventListener('click', () => {
    const panel = $('advanced-settings');
    const showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : 'block';
    $('btn-toggle-advanced').textContent = showing ? 'Advanced Settings ▾' : 'Advanced Settings ▴';
  });

  $('btn-save-config').addEventListener('click', () => {
    socket.emit('HOST_UPDATE_CONFIG', {
      roomCode: myRoomCode,
      config: {
        weights: { price: Number($('cfg-wp').value) || 0, tech: Number($('cfg-wt').value) || 0, capacity: Number($('cfg-wc').value) || 0 },
        demandPerTeam: Number($('cfg-demand').value) || 200,
        roundTimerSeconds: Number($('cfg-timer').value) || 180,
        maxTeams: Number($('cfg-maxteams').value) || 8,
        startingCapital: Number($('cfg-capital').value) || 5000,
        inflationRatePerRound: Number($('cfg-inflation').value) || 0,
        marketVolatility: Number($('cfg-volatility').value) || 1
      }
    });
    $('config-saved-hint').textContent = 'Saved ✓';
    setTimeout(() => ($('config-saved-hint').textContent = ''), 1500);
  });

  $('btn-live-apply').addEventListener('click', () => {
    socket.emit('HOST_UPDATE_CONFIG', {
      roomCode: myRoomCode,
      config: {
        demandPerTeam: Number($('live-cfg-demand').value) || 200,
        roundTimerSeconds: Number($('live-cfg-timer').value) || 180,
        marketVolatility: Number($('live-cfg-volatility').value) || 1
      }
    });
    $('live-config-saved-hint').textContent = 'Applied ✓ — demand/volatility affect this round, timer affects the next one';
    setTimeout(() => ($('live-config-saved-hint').textContent = ''), 2500);
  });

  function confirmDestroyRoom() {
    if (!confirm('Destroy this room? Every connected player will be disconnected and this cannot be undone.')) return;
    socket.emit('HOST_DESTROY_ROOM', { roomCode: myRoomCode });
    localStorage.removeItem(HOST_SESSION_KEY);
    myRoomCode = null;
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $('screen-setup').classList.add('active');
  }
  $('btn-destroy-room-lobby').addEventListener('click', confirmDestroyRoom);
  $('btn-destroy-room-live').addEventListener('click', confirmDestroyRoom);

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
      const label = '<b style="font-family:var(--display);">' + escapeHtml(t.teamName || t.companyName) + '</b> <span class="hint-text">(' + escapeHtml(t.companyName) + ')</span>';
      row.innerHTML =
        '<span class="dot" style="background:' + colorFor(t.teamId) + '"></span>' +
        '<span style="flex:1">' + label + '</span>' +
        (t.isBot ? '<span class="badge badge-bot">BOT</span>' : '') +
        (!t.connected && !t.isBot ? '<span class="badge badge-offline">OFFLINE</span>' : '') +
        '<button class="btn btn-sm btn-red" data-kick="' + t.teamId + '" style="margin-left:8px;">Kick</button>';
      list.appendChild(row);
    });
    list.querySelectorAll('[data-kick]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!confirm('Remove this team from the room?')) return;
        socket.emit('HOST_KICK_TEAM', { roomCode: myRoomCode, teamId: b.dataset.kick });
      });
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
      const label = '<b style="font-family:var(--display);">' + escapeHtml(t.teamName || t.companyName) + '</b> <span class="hint-text">(' + escapeHtml(t.companyName) + ')</span>';
      tr.innerHTML =
        '<td style="color:' + colorFor(t.teamId) + '">' + label + (t.isBot ? ' 🤖' : '') + '</td>' +
        '<td>' + (t.locked ? '🔒' : '⏳') + '</td>' +
        '<td>$' + t.price + '</td>' +
        '<td>' + t.quantity + '</td>' +
        '<td>Lv' + t.techLevel + '</td>' +
        '<td>Lv' + t.capacityLevel + '</td>' +
        '<td>' + (t.capital != null ? money(t.capital) : '—') + '</td>' +
        '<td><button class="btn btn-sm btn-red" data-kick-live="' + t.teamId + '">Kick</button></td>';
      body.appendChild(tr);
    });
    body.querySelectorAll('[data-kick-live]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!confirm('Remove this team from the room? Their in-progress round will just be dropped.')) return;
        socket.emit('HOST_KICK_TEAM', { roomCode: myRoomCode, teamId: b.dataset.kickLive });
      });
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
      const label = '<b style="font-family:var(--display);">' + escapeHtml(r.teamName || r.companyName) + '</b> <span class="hint-text">(' + escapeHtml(r.companyName) + ')</span>';
      tr.innerHTML =
        '<td style="color:' + colorFor(r.teamId) + '">' + label + '</td>' +
        '<td>$' + r.price + '</td>' +
        '<td>' + r.quantitySold + '</td>' +
        '<td>' + money(r.revenue) + '</td>' +
        '<td>' + r.unsoldInventory + '</td>';
      body.appendChild(tr);
    });
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
        '<div class="hint-text">capital ' + money(t.capital) + ' · inventory ' + t.inventory + ' · tech Lv' + t.techLevel + ' · capacity Lv' + t.capacityLevel + '</div></div>' +
        '<div class="value">' + money(t.companyValue) + '</div>';
      el.appendChild(row);
    });
    lastHistory = payload.history || [];
    renderCharts(lastHistory);
  }

  // ---------- post-match charts + CSV export (same shape as the player view) ----------
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
    const csv = rows.map((row) => row.map((cell) => { const s = String(cell == null ? '' : cell); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
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
  $('btn-download-csv').addEventListener('click', downloadMatchCSV);

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
    applyConfigToInputs(payload.config);
    if (payload.phase === 'lobby') routeScreen('lobby');
  });
  socket.on('ROOM_CLOSED', () => {
    localStorage.removeItem(HOST_SESSION_KEY);
    myRoomCode = null;
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $('screen-setup').classList.add('active');
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
