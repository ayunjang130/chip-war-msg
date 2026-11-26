(function () {
  const TEAM_COLORS = ['#e7ecf3', '#4fb5c2', '#e3b341', '#d58be0', '#9bd06b', '#b79cf5', '#f2a65a', '#8fa3bf'];
  const CONTRIB_COLORS = { pricing: '#e3b341', investment: '#a78bfa', execution: '#3fb68b', communication: '#4fb5c2' };
  const HOST_SESSION_KEY = 'chipwar_host_room';

  const socket = io();
  let myRoomCode = null;
  let lastPhase = 'lobby';
  let lastHistory = [];
  let lastState = null;
  let lastTimeLeft = null;
  let lastFinal = null;
  let charts = {};
  let currentTeamCount = 0;
  let confirmCallback = null;
  let lastLockByTeam = {};
  let openTeamRows = new Set();

  const $ = (id) => document.getElementById(id);
  function injectIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (window.Icons && Icons[el.dataset.icon] != null) el.innerHTML = Icons[el.dataset.icon];
    });
  }
  const CATEGORY_ICON = { CAPACITY: 'layers', COST: 'dollar', DEMAND: 'package', PRIORITY: 'target', MARKET: 'trending' };
  const CATEGORY_LABEL = { CAPACITY: 'Production', COST: 'Costs', DEMAND: 'Demand', PRIORITY: "Apple's priorities", MARKET: 'Market' };
  const ACTION_ICON = { lock: 'lock', tech_up: 'cpu', tech_down: 'cpu', capacity_up: 'layers', capacity_down: 'layers' };
  function money(n) {
    n = Math.round(n || 0);
    return n < 0 ? '-$' + Math.abs(n).toLocaleString() : '$' + n.toLocaleString();
  }
  function colorFor(key) {
    let h = 0;
    key = String(key || '');
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return TEAM_COLORS[Math.abs(h) % TEAM_COLORS.length];
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function joinUrl() {
    return location.origin + '/';
  }

  const wafer = window.WaferMap ? WaferMap($('wafer')) : null;
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
    $('session-bar').style.display = id === 'screen-setup' ? 'none' : '';
    if (wafer) (id === 'screen-setup' ? wafer.start() : wafer.stop());
  }
  function routeScreen(phase) {
    const map = { lobby: 'screen-lobby', round_active: 'screen-live', round_results: 'screen-live', game_over: 'screen-gameover' };
    const target = map[phase];
    if (!target) return;
    document.body.classList.toggle('in-round', phase !== 'lobby');
    document.body.classList.toggle('is-live', phase === 'round_active');
    if (!$(target).classList.contains('active')) showScreen(target);
    $('live-results-card').style.display = phase === 'round_results' ? '' : 'none';
    lastPhase = phase;
  }

  // ---------- confirm modal ----------
  function showConfirm(title, message, confirmLabel, onConfirm, opts) {
    opts = opts || {};
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-ok-btn').textContent = confirmLabel || 'Confirm';
    $('confirm-ok-btn').className = 'btn ' + (opts.neutral ? 'btn-primary' : 'btn-danger');
    $('confirm-cancel-btn').style.display = opts.noCancel ? 'none' : '';
    $('confirm-box').classList.toggle('neutral', !!opts.neutral);
    confirmCallback = onConfirm || null;
    $('confirm-modal').classList.add('active');
  }
  function closeConfirm() {
    $('confirm-modal').classList.remove('active');
    confirmCallback = null;
  }
  $('confirm-cancel-btn').addEventListener('click', closeConfirm);
  $('confirm-ok-btn').addEventListener('click', () => {
    const cb = confirmCallback;
    closeConfirm();
    if (cb) cb();
  });

  function renderAiStatus(aiEnabled) {
    $('ai-shock-status').textContent = aiEnabled
      ? 'Market shocks are written live by an AI model each round.'
      : 'Market shocks come from the built-in library of 14 events (no ANTHROPIC_API_KEY on the server).';
  }

  // ---------- shock ----------
  function showShockLoading() {
    $('shock-loading').style.display = 'flex';
    $('shock-banner').classList.remove('active');
  }
  function summarizeEffects(effects) {
    if (!effects) return '';
    const parts = [];
    if (effects.capacityProductionMultiplier !== 1) parts.push('Capacity output ×' + effects.capacityProductionMultiplier);
    if (effects.techUpgradeCostMultiplier !== 1) parts.push('Tech cost ×' + effects.techUpgradeCostMultiplier);
    if (effects.capacityUpgradeCostMultiplier !== 1) parts.push('Capacity cost ×' + effects.capacityUpgradeCostMultiplier);
    if (effects.demandMultiplier !== 1) parts.push('Demand ×' + effects.demandMultiplier);
    const b = effects.weightBias || {};
    if (b.price !== 1) parts.push('Price weight ×' + b.price);
    if (b.tech !== 1) parts.push('Tech weight ×' + b.tech);
    if (b.capacity !== 1) parts.push('Capacity weight ×' + b.capacity);
    return parts.length ? parts.join(', ') : 'No change';
  }
  function renderShock(shock) {
    $('shock-loading').style.display = 'none';
    const el = $('shock-banner');
    if (!shock) return el.classList.remove('active');
    el.classList.add('active');
    const tag = shock.categoryTag || 'MARKET';
    $('shock-tag').innerHTML = Icons[CATEGORY_ICON[tag] || 'trending'] + (CATEGORY_LABEL[tag] || tag);
    $('shock-title').textContent = shock.title;
    $('shock-desc').textContent = shock.description;
    $('shock-effects').textContent = summarizeEffects(shock.effects);
  }

  // ---------- setup ----------
  function adoptRoom(res) {
    myRoomCode = res.roomCode;
    localStorage.setItem(HOST_SESSION_KEY, myRoomCode);
    $('lobby-roomcode').textContent = myRoomCode;
    $('bar-room').textContent = myRoomCode;
    $('join-url').textContent = joinUrl().replace(/^https?:\/\//, '');
    renderAiStatus(res.aiEnabled);
    if (res.config) applyConfigToInputs(res.config);
  }
  $('btn-create-room').addEventListener('click', () => {
    socket.emit('HOST_CREATE_ROOM', {}, (res) => {
      if (!res || !res.ok) return ($('setup-error').textContent = "Couldn't open a room. Refresh the page and try again.");
      adoptRoom(res);
      routeScreen('lobby');
    });
  });
  function tryAutoRejoin() {
    const saved = localStorage.getItem(HOST_SESSION_KEY);
    if (!saved) return;
    socket.emit('HOST_REJOIN', { roomCode: saved }, (res) => {
      if (res && res.ok) {
        adoptRoom(res);
        routeScreen(lastPhase);
      } else localStorage.removeItem(HOST_SESSION_KEY);
    });
  }

  function applyConfigToInputs(config) {
    if (!config) return;
    const set = (id, v) => {
      if (document.activeElement !== $(id)) $(id).value = v;
    };
    set('cfg-wp', +config.weights.price.toFixed(2));
    set('cfg-wt', +config.weights.tech.toFixed(2));
    set('cfg-wc', +config.weights.capacity.toFixed(2));
    set('cfg-demand', config.demandPerTeam);
    set('cfg-timer', config.roundTimerSeconds);
    set('cfg-maxteams', config.maxTeams);
    set('cfg-capital', config.startingCapital);
    set('cfg-inflation', config.inflationRatePerRound);
    set('cfg-volatility', config.marketVolatility);
    $('team-max').textContent = config.maxTeams;
    set('live-cfg-demand', config.demandPerTeam);
    set('live-cfg-timer', config.roundTimerSeconds);
    set('live-cfg-volatility', config.marketVolatility);
    updateWeightHint();
    updateTotalDemandHints();
  }
  function updateTotalDemandHints() {
    const perTeam = Number($('cfg-demand').value) || 0;
    $('total-demand-hint').textContent = 'Total demand: ' + (perTeam * currentTeamCount).toLocaleString() + ' chips (' + perTeam + ' × ' + currentTeamCount + ' team' + (currentTeamCount === 1 ? '' : 's') + ')';
    const live = Number($('live-cfg-demand').value) || perTeam;
    $('live-total-demand-hint').textContent = 'Total demand: ' + (live * currentTeamCount).toLocaleString() + ' chips';
  }
  $('cfg-demand').addEventListener('input', updateTotalDemandHints);
  $('live-cfg-demand').addEventListener('input', updateTotalDemandHints);
  function updateWeightHint() {
    const p = Number($('cfg-wp').value) || 0, t = Number($('cfg-wt').value) || 0, c = Number($('cfg-wc').value) || 0;
    const sum = p + t + c || 1;
    const pct = (x) => Math.round((x / sum) * 100);
    $('weight-bar').innerHTML = '<span style="width:' + pct(p) + '%; background:var(--gold)"></span><span style="width:' + pct(t) + '%; background:var(--violet)"></span><span style="width:' + pct(c) + '%; background:var(--teal)"></span>';
    $('weight-sum-hint').textContent = 'Price ' + pct(p) + '%, Tech ' + pct(t) + '%, Capacity ' + pct(c) + '%';
  }
  ['cfg-wp', 'cfg-wt', 'cfg-wc'].forEach((id) => $(id).addEventListener('input', updateWeightHint));
  $('btn-toggle-advanced').addEventListener('click', () => {
    const panel = $('advanced-settings');
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    $('btn-toggle-advanced').classList.toggle('open', open);
  });
  function flash(id, text) {
    $(id).textContent = text;
    setTimeout(() => ($(id).textContent = ''), 2200);
  }
  $('btn-save-config').addEventListener('click', () => {
    socket.emit('HOST_UPDATE_CONFIG', {
      roomCode: myRoomCode,
      config: {
        weights: { price: Number($('cfg-wp').value) || 0, tech: Number($('cfg-wt').value) || 0, capacity: Number($('cfg-wc').value) || 0 },
        demandPerTeam: Number($('cfg-demand').value) || 70,
        roundTimerSeconds: Number($('cfg-timer').value) || 180,
        maxTeams: Number($('cfg-maxteams').value) || 8,
        startingCapital: Number($('cfg-capital').value) || 5000,
        inflationRatePerRound: Number($('cfg-inflation').value) || 0,
        marketVolatility: Number($('cfg-volatility').value) || 1
      }
    });
    flash('config-saved-hint', 'Saved');
  });
  $('btn-live-apply').addEventListener('click', () => {
    socket.emit('HOST_UPDATE_CONFIG', {
      roomCode: myRoomCode,
      config: {
        demandPerTeam: Number($('live-cfg-demand').value) || 70,
        roundTimerSeconds: Number($('live-cfg-timer').value) || 180,
        marketVolatility: Number($('live-cfg-volatility').value) || 1
      }
    });
    flash('live-config-saved-hint', 'Applied. Timer changes start next round.');
  });

  function confirmDestroyRoom() {
    showConfirm('Close this room?', 'Every player is disconnected and the match is deleted. This can\'t be undone.', 'Close room', () => {
      socket.emit('HOST_DESTROY_ROOM', { roomCode: myRoomCode });
      localStorage.removeItem(HOST_SESSION_KEY);
      myRoomCode = null;
      showScreen('screen-setup');
    });
  }
  $('btn-destroy-room-lobby').addEventListener('click', confirmDestroyRoom);
  $('btn-destroy-room-live').addEventListener('click', confirmDestroyRoom);
  document.querySelectorAll('[data-bot]').forEach((btn) => btn.addEventListener('click', () => socket.emit('HOST_ADD_BOT', { roomCode: myRoomCode, strategy: btn.dataset.bot })));
  $('btn-start-game').addEventListener('click', () => {
    $('start-error').textContent = '';
    socket.emit('HOST_START_GAME', { roomCode: myRoomCode });
  });
  $('btn-copy-link').addEventListener('click', () => {
    const text = joinUrl();
    const done = () => {
      $('btn-copy-label').textContent = 'Copied';
      setTimeout(() => ($('btn-copy-label').textContent = 'Copy join link'), 1600);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
    else done();
  });
  function openBroadcast() {
    if (myRoomCode) window.open('/broadcast?room=' + encodeURIComponent(myRoomCode), '_blank');
  }
  $('btn-open-broadcast').addEventListener('click', openBroadcast);
  $('btn-open-broadcast-bar').addEventListener('click', openBroadcast);

  // ---------- lobby ----------
  function kickHandler(teamId, name) {
    showConfirm('Remove ' + name + '?', 'Everyone on this team is disconnected from the room.', 'Remove team', () => socket.emit('HOST_KICK_TEAM', { roomCode: myRoomCode, teamId }));
  }
  function renderTeamList(payload) {
    $('team-count').textContent = payload.teams.length;
    $('team-max').textContent = payload.config.maxTeams;
    currentTeamCount = payload.teams.length;
    updateTotalDemandHints();
    const list = $('team-list');
    if (!payload.teams.length) {
      list.innerHTML = '<div class="empty-state">No teams yet. Put the room code on screen and players will appear here as they join.</div>';
    } else {
      list.innerHTML = payload.teams
        .map(
          (t) =>
            '<div class="host-team-row"><span class="dot" style="background:' + colorFor(t.teamId) + '"></span><div style="min-width:0;"><div class="nm">' + escapeHtml(t.teamName) + '</div>' +
            '<div class="who">' + (t.isBot ? 'Computer player' : t.members.map((m) => escapeHtml(m.memberName) + (m.connected ? '' : ' (offline)')).join(', ') || 'No one connected') + '</div></div>' +
            '<div class="right">' + (t.isBot ? '<span class="badge badge-bot">' + Icons.bot + 'Bot</span>' : '<span class="pill">' + t.memberCount + '/' + t.maxMembers + '</span>') +
            '<button class="btn btn-ghost btn-sm" data-kick="' + t.teamId + '" data-name="' + escapeHtml(t.teamName) + '" type="button">Remove</button></div></div>'
        )
        .join('');
      list.querySelectorAll('[data-kick]').forEach((b) => b.addEventListener('click', () => kickHandler(b.dataset.kick, b.dataset.name)));
    }
    const enough = payload.teams.length >= 3;
    $('btn-start-game').disabled = !enough;
    $('start-error').textContent = enough ? '' : 'A match needs at least 3 teams. ' + (3 - payload.teams.length) + ' more to go - add a bot if you\'re short.';
  }

  // ---------- live ----------
  function renderRoundTrack(round, phase) {
    let html = '';
    for (let i = 1; i <= 6; i++) html += '<span class="' + (i < round || (i === round && phase !== 'round_active') ? 'done' : i === round ? 'now' : '') + '"></span>';
    $('round-track').innerHTML = html;
  }
  function teamValue(t) {
    return t.companyValue != null ? t.companyValue : t.capital + t.inventory * 10 + t.techLevel * 500 + t.capacityLevel * 500;
  }
  function renderLiveTable(payload) {
    $('live-round').textContent = payload.round;
    renderRoundTrack(payload.round, payload.phase);
    $('live-mp').textContent = payload.marketPrice ? payload.marketPrice.toFixed(0) : '—';
    if (payload.totalDemand != null) $('live-demand').textContent = payload.totalDemand.toLocaleString();
    currentTeamCount = payload.teams.length;
    if (payload.phase === 'round_active') renderShock(payload.shock);
    const body = $('live-table-body');
    body.innerHTML = '';
    payload.teams.forEach((t) => {
      const tr = document.createElement('tr');
      const justLocked = lastLockByTeam[t.teamId] === false && t.locked === true;
      lastLockByTeam[t.teamId] = t.locked;
      if (justLocked) tr.classList.add('lock-flash');
      tr.innerHTML =
        '<td><span class="dot" style="background:' + colorFor(t.teamId) + '; margin-right:7px;"></span><b>' + escapeHtml(t.teamName) + '</b>' +
        (t.isBot ? ' <span class="badge badge-bot">Bot</span>' : ' <span class="muted" style="font-size:12px;">' + t.members.filter((m) => m.connected).length + '/' + t.memberCount + ' online</span>') + '</td>' +
        '<td><span class="lock-indicator ' + (t.locked ? 'locked' : 'open') + '">' + (t.locked ? Icons.lock : Icons.unlock) + '</span></td>' +
        '<td>$' + t.price + '</td><td>' + t.quantity + '</td><td>' + t.techLevel + '</td><td>' + t.capacityLevel + '</td>' +
        '<td class="' + (t.capital < 0 ? 'chg-up' : '') + '">' + (t.capital != null ? money(t.capital) : '—') + '</td>' +
        '<td>' + money(teamValue(t)) + '</td>' +
        '<td><button class="btn btn-ghost btn-sm" data-kick-live="' + t.teamId + '" data-name="' + escapeHtml(t.teamName) + '" type="button">Remove</button></td>';
      body.appendChild(tr);
    });
    body.querySelectorAll('[data-kick-live]').forEach((b) => b.addEventListener('click', () => kickHandler(b.dataset.kickLive, b.dataset.name)));
    renderHostContrib(payload.teams, $('host-contrib'));
  }

  function contribCard(teamName, teamId, members) {
    const total = members.reduce((s, m) => s + (m.total || 0), 0);
    const sorted = members.slice().sort((a, b) => (b.total || 0) - (a.total || 0));
    return (
      '<div><div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;"><span class="dot" style="background:' + colorFor(teamId) + '"></span><b>' + escapeHtml(teamName) + '</b><span class="muted" style="margin-left:auto; font-size:12px;">' + total + ' pts</span></div>' +
      sorted
        .map((m, i) => {
          const pct = (x) => (total > 0 ? (x / total) * 100 : 0).toFixed(1) + '%';
          const s = m.stats || {};
          const ups = (s.techBuys || 0) + (s.capBuys || 0);
          const bits = [];
          if (s.finalPrice) bits.push('price ×' + s.finalPrice);
          if (ups) bits.push(ups + ' upgrade' + (ups > 1 ? 's' : ''));
          if (s.lockIns) bits.push('lock ×' + s.lockIns);
          const edits = (s.priceEdits || 0) + (s.qtyEdits || 0);
          if (edits) bits.push(edits + ' edit' + (edits > 1 ? 's' : ''));
          const msgs = (s.teamMsgs || 0) + (s.globalMsgs || 0);
          if (msgs) bits.push(msgs + ' msg');
          return (
            '<div class="contrib-row" style="padding:7px 0;"><div class="contrib-top"><span class="nm" style="font-size:13.5px;">' + escapeHtml(m.memberName) + '</span>' +
            (i === 0 && total > 0 && sorted.length > 1 ? '<span class="mvp-tag">' + Icons.award + 'MVP</span>' : '') +
            (m.connected === false ? '<span class="badge badge-offline">Offline</span>' : '') +
            '<span class="share" style="font-size:15px;">' + (m.share || 0) + '%</span></div>' +
            '<div class="contrib-bar">' + ['pricing', 'investment', 'execution', 'communication'].map((k) => '<span style="width:' + pct(m[k] || 0) + '; background:' + CONTRIB_COLORS[k] + '"></span>').join('') + '</div>' +
            '<div class="hint-text" style="margin-top:4px;">' + (bits.length ? bits.join(', ') : 'No decisions yet') + '</div></div>'
          );
        })
        .join('') +
      '</div>'
    );
  }
  function renderHostContrib(teams, el) {
    const humans = teams.filter((t) => !t.isBot);
    if (!humans.length) return (el.innerHTML = '<div class="empty-state">Bots only - nothing to attribute.</div>');
    el.innerHTML = humans.map((t) => contribCard(t.teamName, t.teamId, (t.members || []).map((m) => Object.assign({ memberName: m.memberName, connected: m.connected }, m.contribution || {})))).join('');
  }

  function updateTimer(timeLeft) {
    lastTimeLeft = timeLeft;
    const m = Math.max(0, Math.floor(timeLeft / 60)), s = Math.max(0, timeLeft % 60);
    const el = $('live-timer');
    el.textContent = m + ':' + String(s).padStart(2, '0');
    el.classList.remove('warn', 'danger');
    if (timeLeft <= 20) el.classList.add('danger');
    else if (timeLeft <= 60) el.classList.add('warn');
  }

  function renderRoundResults(payload) {
    Sound.results();
    $('res-round').textContent = payload.round;
    $('next-round-hint').textContent = payload.isFinalRound ? 'That was the last round. Final standings are coming up.' : 'Otherwise the next round starts by itself in about 20 seconds.';
    $('btn-next-round').style.display = payload.isFinalRound ? 'none' : '';
    const body = $('live-results-body');
    body.innerHTML = '';
    payload.results.forEach((r, i) => {
      const tr = document.createElement('tr');
      if (i === 0) tr.classList.add('winner');
      tr.innerHTML =
        '<td><span class="dot" style="background:' + colorFor(r.teamId) + '; margin-right:7px;"></span><b>' + escapeHtml(r.teamName) + '</b></td>' +
        '<td>$' + r.price + '</td><td>' + r.quantitySold + '<span class="muted">/' + r.quantityOffered + '</span></td><td>' + money(r.revenue) + '</td><td>' + r.unsoldInventory + '</td><td>' + (r.companyValue != null ? money(r.companyValue) : '—') + '</td>';
      body.appendChild(tr);
    });
  }

  function renderGameOver(payload) {
    lastFinal = payload;
    Sound.victory();
    $('final-winner-banner').textContent = payload.winner ? payload.winner.teamName + ' wins' : 'Game over';
    const el = $('final-leaderboard');
    el.innerHTML = '';
    payload.leaderboard.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row' + (idx === 0 ? ' first' : '');
      row.innerHTML =
        '<div class="rank">' + (idx === 0 ? Icons.star : '') + (idx + 1) + '</div>' +
        '<div class="name"><b>' + escapeHtml(t.teamName) + '</b>' + (t.isBot ? ' <span class="badge badge-bot">Bot</span>' : '') +
        '<div class="breakdown">Cash ' + money(t.capital) + ' + ' + t.inventory + ' chips + Tech ' + t.techLevel + ' + Capacity ' + t.capacityLevel + '</div></div>' +
        '<div class="value">' + money(t.companyValue) + '</div>';
      el.appendChild(row);
    });
    const humans = payload.leaderboard.filter((t) => !t.isBot && t.contributions && t.contributions.length);
    $('final-contrib').innerHTML = humans.length ? humans.map((t) => contribCard(t.teamName, t.teamId, t.contributions)).join('') : '<div class="empty-state">No human teams.</div>';
    lastHistory = payload.history || [];
    renderCharts(lastHistory);
  }

  // ---------- charts + CSV ----------
  function destroyCharts() {
    Object.values(charts).forEach((c) => c && c.destroy());
    charts = {};
  }
  function chartOptions() {
    return {
      responsive: true,
      plugins: { legend: { labels: { color: '#b7c1cf', font: { family: 'Archivo' }, boxWidth: 10 } } },
      scales: { x: { ticks: { color: '#7f8ba0' }, grid: { color: '#1d2838' } }, y: { ticks: { color: '#7f8ba0' }, grid: { color: '#1d2838' } } }
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
        teamMeta[r.teamId] = r.teamName;
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
        tension: 0.3,
        cubicInterpolationMode: 'monotone',
        spanGaps: true
      }));
    charts.value = new Chart($('chart-value').getContext('2d'), { type: 'line', data: { labels, datasets: seriesFor((r) => (r.companyValue != null ? r.companyValue : r.capital + r.unsoldInventory * 10 + r.techLevel * 500 + r.capacityLevel * 500)) }, options: chartOptions() });
    charts.price = new Chart($('chart-price').getContext('2d'), { type: 'line', data: { labels, datasets: seriesFor((r) => r.price) }, options: chartOptions() });
    charts.mp = new Chart($('chart-mp').getContext('2d'), { type: 'line', data: { labels, datasets: [{ label: 'Market price', data: history.map((h) => h.marketPrice), borderColor: '#e3b341', backgroundColor: '#e3b341', cubicInterpolationMode: 'monotone' }] }, options: chartOptions() });
  }
  function downloadCSV(rows, name) {
    const csv = rows.map((row) => row.map((cell) => { const s = String(cell == null ? '' : cell); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  $('btn-download-csv').addEventListener('click', () => {
    if (!lastHistory.length) return;
    const rows = [['round', 'marketPrice', 'shockTitle', 'teamName', 'price', 'quantityOffered', 'quantitySold', 'revenue', 'unsoldInventory', 'capital', 'techLevel', 'capacityLevel', 'companyValue', 'competitiveScore']];
    lastHistory.forEach((h) => h.results.forEach((r) => rows.push([h.round, h.marketPrice, h.shock ? h.shock.title : '', r.teamName, r.price, r.quantityOffered, r.quantitySold, r.revenue, r.unsoldInventory, r.capital, r.techLevel, r.capacityLevel, r.companyValue, r.competitiveScore])));
    downloadCSV(rows, 'chip-war-match-' + (myRoomCode || 'data') + '.csv');
  });
  // Contribution report - one row per person, ready for grading or the
  // club's point ledger.
  $('btn-download-contrib').addEventListener('click', () => {
    if (!lastFinal) return;
    const rows = [['team', 'finalRank', 'teamCompanyValue', 'member', 'sharePct', 'totalPts', 'pricingPts', 'investmentPts', 'lockInPts', 'talkPts', 'finalPriceSet', 'finalQtySet', 'techBought', 'capacityBought', 'investSpent', 'lockIns', 'priceEdits', 'qtyEdits', 'undos', 'teamMsgs', 'allTeamsMsgs']];
    lastFinal.leaderboard.forEach((t, idx) => {
      (t.contributions || []).forEach((m) => {
        const s = m.stats || {};
        rows.push([t.teamName, idx + 1, t.companyValue, m.memberName, m.share, m.total, m.pricing, m.investment, m.execution, m.communication, s.finalPrice, s.finalQty, s.techBuys, s.capBuys, s.investSpent, s.lockIns, s.priceEdits, s.qtyEdits, s.undos, s.teamMsgs, s.globalMsgs]);
      });
    });
    downloadCSV(rows, 'chip-war-contribution-' + (myRoomCode || 'data') + '.csv');
  });

  // ---------- chat ----------
  function appendRow(row) {
    const log = $('chat-log');
    const empty = log.querySelector('.chat-empty');
    if (empty) empty.remove();
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  function routeChatMessage(msg) {
    const row = document.createElement('div');
    if (msg.kind === 'system') {
      row.className = 'chat-msg system act-' + (msg.actionType || '');
      row.innerHTML = '<span class="act-icon">' + (Icons[ACTION_ICON[msg.actionType]] || Icons.trending) + '</span><span><b>' + escapeHtml(msg.name) + '</b>' + (msg.actor ? ' (' + escapeHtml(msg.actor) + ')' : '') + ' ' + escapeHtml(msg.text) + '</span>';
    } else {
      const isHost = msg.name === 'HOST' && !msg.teamId;
      row.className = 'chat-msg' + (isHost ? ' host' : '');
      row.innerHTML = '<span class="who" style="color:' + colorFor(msg.teamId || msg.name) + '">' + (isHost ? 'Host' : escapeHtml(msg.name) + (msg.actor ? ' <small>' + escapeHtml(msg.actor) + '</small>' : '')) + '</span>' + escapeHtml(msg.text);
    }
    appendRow(row);
  }
  $('btn-chat-send').addEventListener('click', () => {
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    socket.emit('CHAT_MESSAGE', { roomCode: myRoomCode, channel: 'global', text });
    input.value = '';
  });
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-chat-send').click();
  });

  // ---------- controls ----------
  $('btn-pause').addEventListener('click', () => socket.emit('HOST_PAUSE_TIMER', { roomCode: myRoomCode }));
  $('btn-resume').addEventListener('click', () => socket.emit('HOST_RESUME_TIMER', { roomCode: myRoomCode }));
  $('btn-skip').addEventListener('click', () =>
    showConfirm('End this round now?', 'Teams that haven\'t locked in are submitted with whatever is in their boxes.', 'End round', () => socket.emit('HOST_FORCE_SKIP', { roomCode: myRoomCode }))
  );
  $('btn-next-round').addEventListener('click', () => socket.emit('HOST_NEXT_ROUND', { roomCode: myRoomCode }));
  $('btn-reset').addEventListener('click', () =>
    showConfirm('Reset the room?', 'Teams stay in the room, but every company goes back to its starting budget and all contribution scores are cleared.', 'Reset room', () => socket.emit('HOST_RESET_GAME', { roomCode: myRoomCode }), { neutral: true })
  );

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
    showScreen('screen-setup');
  });
  socket.on('STATE_SYNC', (payload) => {
    if (!myRoomCode) return;
    lastState = payload;
    if (payload.timeLeft != null && payload.phase === 'round_active') updateTimer(payload.timeLeft);
    $('btn-pause').disabled = !!payload.paused;
    $('btn-resume').disabled = !payload.paused;
    if (payload.phase !== 'lobby') renderLiveTable(payload);
    routeScreen(payload.phase);
    analyst.update(analystState());
  });
  socket.on('ROUND_STARTING', () => {
    routeScreen('round_active');
    showShockLoading();
  });
  socket.on('ROUND_START', (payload) => {
    routeScreen('round_active');
    if (payload && payload.shock) {
      Sound.shock();
      Juice.shake($('shock-banner'));
    }
  });
  socket.on('TIMER_TICK', ({ timeLeft }) => {
    updateTimer(timeLeft);
    if (lastState) lastState.timeLeft = timeLeft;
  });
  socket.on('ROUND_RESULT', (payload) => {
    renderRoundResults(payload);
    routeScreen('round_results');
  });
  socket.on('GAME_OVER', (payload) => {
    renderGameOver(payload);
    routeScreen('game_over');
  });
  socket.on('CHAT_MESSAGE', routeChatMessage);
  socket.on('CHAT_SYNC', (payload) => {
    $('chat-log').innerHTML = '<div class="chat-empty">Lock-ins, upgrades and leader messages appear here.</div>';
    (payload.global || []).forEach(routeChatMessage);
  });

  document.addEventListener('click', (e) => {
    const tip = e.target.closest('.info-tip');
    if (tip) {
      e.stopPropagation();
      document.querySelectorAll('.info-tip.show').forEach((o) => o !== tip && o.classList.remove('show'));
      tip.classList.toggle('show');
    } else document.querySelectorAll('.info-tip.show').forEach((o) => o.classList.remove('show'));
  });

  function updateSoundToggleIcon() {
    const btn = $('btn-sound-toggle');
    const on = Sound.isEnabled();
    btn.classList.toggle('muted', !on);
    btn.querySelector('.icon-slot').innerHTML = on ? Icons.volume : Icons.volumeOff;
  }
  $('btn-sound-toggle').addEventListener('click', () => {
    Sound.setEnabled(!Sound.isEnabled());
    if (Sound.isEnabled()) Sound.click();
    updateSoundToggleIcon();
  });

  function analystState() {
    if (!lastState) return null;
    return Object.assign({}, lastState, { timeLeft: lastTimeLeft });
  }
  const analyst = Analyst.mount({ mode: 'host', getState: analystState });

  injectIcons();
  updateSoundToggleIcon();
  updateWeightHint();
  if (wafer) wafer.start();
  tryAutoRejoin();
})();
