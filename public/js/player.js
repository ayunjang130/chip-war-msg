(function () {
  // Team colors deliberately avoid red/blue (reserved for price direction).
  const TEAM_COLORS = ['#e7ecf3', '#4fb5c2', '#e3b341', '#d58be0', '#9bd06b', '#b79cf5', '#f2a65a', '#8fa3bf'];
  const COLOR_UP = '#f0464d';
  const COLOR_DOWN = '#3d8bfd';
  const SESSION_KEY = 'chipwar_session';
  const CONTRIB_COLORS = { pricing: '#e3b341', investment: '#a78bfa', execution: '#3fb68b', communication: '#4fb5c2' };

  const socket = io();

  let myRoomCode = null;
  let myTeamId = null;
  let myMemberId = null;
  let myMemberName = null;
  let selectedJoinTeamId = null;
  let lastState = null;
  let lastTimeLeft = null;
  let lastTicker = {};
  let lastPriceByTeam = {};
  let lastQtyByTeam = {};
  let lastTechByTeam = {};
  let lastCapByTeam = {};
  let lastLockByTeam = {};
  let priceTimer = null;
  let lastHistory = [];
  let charts = {};
  let liveChart = null;
  let chartSeries = {};
  let chartStartTime = null;
  let lastTeamsSnapshot = null;
  let lastValidPriceByTeam = {};
  let confirmCallback = null;
  let activeChannel = 'team';
  let amILeader = false;
  let myLeaderName = null;
  let openContribRows = new Set();

  // ---------- helpers ----------
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
  function symbolFor(name) {
    const clean = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (clean.slice(0, 4) || 'TEAM').padEnd(3, 'X');
  }
  function companyValue(t) {
    if (t.capital == null) return null;
    return t.capital + t.inventory * 10 + t.techLevel * 500 + t.capacityLevel * 500;
  }

  const wafer = window.WaferMap ? WaferMap($('wafer')) : null;
  function activateScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
    const inSession = id !== 'screen-join' && id !== 'screen-blocked';
    $('session-bar').style.display = inSession && myTeamId ? '' : 'none';
    if (wafer) (id === 'screen-join' ? wafer.start() : wafer.stop());
    window.scrollTo(0, 0);
  }
  function setPhaseClasses(phase) {
    document.body.classList.toggle('in-round', phase === 'round_active' || phase === 'round_results' || phase === 'game_over');
    document.body.classList.toggle('is-live', phase === 'round_active');
  }
  function routeScreen(phase) {
    if (!myTeamId) return;
    const map = { lobby: 'screen-lobby', round_active: 'screen-game', round_results: 'screen-results', game_over: 'screen-gameover' };
    const target = map[phase];
    if (!target) return;
    setPhaseClasses(phase);
    if (!$(target).classList.contains('active')) activateScreen(target);
  }
  function forgetSession() {
    localStorage.removeItem(SESSION_KEY);
    myRoomCode = null;
    myTeamId = null;
    myMemberId = null;
    myMemberName = null;
    lastState = null;
  }
  function saveSession() {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: myRoomCode, teamId: myTeamId, memberId: myMemberId, memberName: myMemberName }));
  }
  function adoptJoin(res) {
    myRoomCode = res.roomCode;
    myTeamId = res.teamId;
    myMemberId = res.memberId;
    myMemberName = res.memberName || myMemberName;
    $('bar-room').textContent = myRoomCode;
    saveSession();
  }

  // ---------- confirm/notice modal ----------
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
    setTimeout(() => $('confirm-ok-btn').focus(), 30);
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('confirm-modal').classList.contains('active') && $('confirm-cancel-btn').style.display !== 'none') closeConfirm();
  });

  // ---------- join flow ----------
  const STEP_OF = { roomcode: 1, choice: 2, create: 3, join: 3 };
  function showStep(name) {
    ['roomcode', 'choice', 'create', 'join'].forEach((s) => $('step-' + s).classList.toggle('active', s === name));
    const n = STEP_OF[name];
    document.querySelectorAll('#join-steps li').forEach((li) => {
      const k = Number(li.dataset.step);
      li.classList.toggle('done', k < n);
      li.classList.toggle('now', k === n);
    });
    const focusId = { roomcode: 'in-roomcode', create: 'in-teamname', join: 'in-membername' }[name];
    if (focusId) setTimeout(() => $(focusId).focus(), 40);
  }
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => showStep(b.dataset.back)));

  $('btn-find-room').addEventListener('click', () => doLookup());
  $('in-roomcode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLookup();
  });
  $('in-roomcode').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  let lastLookupTeams = [];
  function doLookup() {
    const code = $('in-roomcode').value.trim().toUpperCase();
    const err = $('lookup-error');
    err.textContent = '';
    if (code.length !== 5) return (err.textContent = 'Room codes are 5 characters.');
    socket.emit('LOOKUP_ROOM', { roomCode: code }, (res) => {
      if (!res || !res.ok) return (err.textContent = 'No room with that code. Check it with your host.');
      renderChoiceStep(res.teams, res.phase);
    });
  }

  function renderChoiceStep(teams, phase) {
    lastLookupTeams = teams;
    $('choice-roomcode').textContent = $('in-roomcode').value.trim().toUpperCase();
    const openTeams = teams.filter((t) => t.memberCount < t.maxMembers);
    const blocked = phase !== 'lobby';
    $('choice-create').disabled = blocked;
    $('choice-create-note').textContent = blocked ? 'The match has started, so no new teams' : 'You name the company and take the first seat';
    $('choice-join').disabled = openTeams.length === 0;
    $('choice-join-note').textContent =
      openTeams.length === 0 ? (teams.length ? 'Every team is full' : 'No teams yet') : openTeams.length + ' team' + (openTeams.length === 1 ? ' has' : 's have') + ' an open seat';
    showStep('choice');
  }

  $('choice-create').addEventListener('click', () => {
    if ($('choice-create').disabled) return;
    $('join-error').textContent = '';
    showStep('create');
  });
  $('choice-join').addEventListener('click', () => {
    if ($('choice-join').disabled) return;
    renderTeamSelectList(lastLookupTeams);
    showStep('join');
  });

  function renderTeamSelectList(teams) {
    selectedJoinTeamId = null;
    $('btn-join-existing').disabled = true;
    $('join-existing-error').textContent = '';
    const list = $('existing-teams-list');
    list.innerHTML = '';
    teams.forEach((t) => {
      const full = t.memberCount >= t.maxMembers;
      const card = document.createElement('div');
      card.className = 'team-select-card' + (full ? ' full' : '');
      card.tabIndex = full ? -1 : 0;
      card.setAttribute('role', 'button');
      let seats = '';
      for (let i = 0; i < t.maxMembers; i++) seats += '<i class="' + (i < t.memberCount ? 'on' : '') + '"></i>';
      card.innerHTML =
        '<span class="dot" style="background:' + colorFor(t.teamId) + '"></span>' +
        '<div style="min-width:0;"><div class="nm">' + escapeHtml(t.teamName) + '</div><div class="who">' + (t.memberNames && t.memberNames.length ? escapeHtml(t.memberNames.join(', ')) : 'No one yet') + (full ? ' · full' : '') + '</div></div>' +
        '<span class="seat-meter" title="' + t.memberCount + ' of ' + t.maxMembers + ' seats taken">' + seats + '</span>';
      if (!full) {
        const pick = () => {
          list.querySelectorAll('.team-select-card').forEach((c) => c.classList.remove('selected'));
          card.classList.add('selected');
          selectedJoinTeamId = t.teamId;
          $('btn-join-existing').disabled = false;
        };
        card.addEventListener('click', pick);
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            pick();
          }
        });
      }
      list.appendChild(card);
    });
  }

  function doCreate() {
    const roomCode = $('choice-roomcode').textContent.trim();
    const teamName = $('in-teamname').value.trim();
    const memberName = $('in-creatorname').value.trim();
    const err = $('join-error');
    err.textContent = '';
    if (!teamName) return (err.textContent = 'Give your team a name.'), $('in-teamname').focus();
    if (!memberName) return (err.textContent = 'Add your own name so teammates know who did what.'), $('in-creatorname').focus();
    const btn = $('btn-join');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    socket.emit('JOIN_ROOM', { roomCode, teamName, memberName }, (res) => {
      btn.disabled = false;
      btn.textContent = 'Create team';
      if (!res || !res.ok) {
        if (res && res.error === 'GAME_IN_PROGRESS') return activateScreen('screen-blocked');
        err.textContent = res && res.error === 'ROOM_FULL' ? 'This room already has the maximum number of teams.' : 'Room not found. Check the code.';
        return;
      }
      adoptJoin(res);
    });
  }
  $('btn-join').addEventListener('click', doCreate);
  ['in-teamname', 'in-creatorname'].forEach((id) =>
    $(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doCreate();
    })
  );

  function doJoinExisting() {
    if (!selectedJoinTeamId) return;
    const roomCode = $('choice-roomcode').textContent.trim();
    const memberName = $('in-membername').value.trim();
    const err = $('join-existing-error');
    err.textContent = '';
    if (!memberName) return (err.textContent = 'Add your name so teammates know who did what.'), $('in-membername').focus();
    const btn = $('btn-join-existing');
    btn.disabled = true;
    btn.textContent = 'Joining…';
    socket.emit('JOIN_ROOM', { roomCode, teamId: selectedJoinTeamId, memberName }, (res) => {
      btn.disabled = false;
      btn.textContent = 'Join team';
      if (!res || !res.ok) {
        err.textContent = res && res.error === 'TEAM_FULL' ? 'That team just filled up. Pick another.' : "Couldn't join. Try again.";
        return;
      }
      adoptJoin(res);
    });
  }
  $('btn-join-existing').addEventListener('click', doJoinExisting);
  $('in-membername').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoinExisting();
  });

  function tryAutoRejoin() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
      saved = null;
    }
    if (!saved || !saved.roomCode || !saved.teamId || !saved.memberId) return;
    myMemberName = saved.memberName || null;
    socket.emit('JOIN_ROOM', { roomCode: saved.roomCode, teamId: saved.teamId, memberId: saved.memberId }, (res) => {
      if (res && res.ok) adoptJoin(res);
      else forgetSession();
    });
  }

  $('btn-exit-blocked').addEventListener('click', () => {
    $('in-roomcode').value = '';
    showStep('roomcode');
    activateScreen('screen-join');
  });

  function backToJoin() {
    forgetSession();
    $('in-roomcode').value = '';
    $('in-teamname').value = '';
    $('in-creatorname').value = '';
    $('in-membername').value = '';
    setPhaseClasses('lobby');
    showStep('roomcode');
    activateScreen('screen-join');
  }
  function leaveRoom() {
    showConfirm('Leave this game?', "You'll give up your seat. Your team keeps playing, and you can rejoin with the room code if a seat is open.", 'Leave game', () => {
      socket.emit('LEAVE_ROOM', { roomCode: myRoomCode, teamId: myTeamId, memberId: myMemberId });
      backToJoin();
    });
  }
  ['btn-leave-room', 'btn-leave-room-bar', 'btn-leave-room-final'].forEach((id) => $(id).addEventListener('click', leaveRoom));

  // ---------- lobby ----------
  function renderLobby(payload) {
    $('lobby-roomcode').textContent = payload.roomCode;
    $('bar-room').textContent = payload.roomCode;
    $('lobby-count').textContent = payload.teams.length;
    const me = payload.teams.find((t) => t.teamId === myTeamId);
    $('lobby-company').textContent = me ? me.teamName : '—';
    $('lobby-you-are').textContent = myMemberName ? 'You are ' + myMemberName + '.' : '';
    $('hdr-me').textContent = me ? me.teamName : '—';
    $('bar-me-name').textContent = myMemberName || 'My team';
    const list = $('lobby-team-list');
    list.innerHTML = '';
    payload.teams.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'listing';
      row.innerHTML =
        '<span class="sym">' + symbolFor(t.teamName) + '</span>' +
        '<span class="dot" style="background:' + colorFor(t.teamId) + '"></span>' +
        '<span class="nm">' + escapeHtml(t.teamName) + '</span>' +
        (t.teamId === myTeamId ? '<span class="badge badge-you">You</span>' : '') +
        '<span class="right">' +
        (t.isBot ? '<span class="badge badge-bot">' + Icons.bot + 'Bot</span>' : '<span class="pill">' + t.memberCount + '/' + t.maxMembers + '</span>') +
        (!t.connected && !t.isBot ? '<span class="badge badge-offline">Offline</span>' : '') +
        '</span>';
      list.appendChild(row);
    });

    if (me) {
      const roster = $('lobby-roster-list');
      roster.innerHTML = '';
      me.members.forEach((m) => {
        const row = document.createElement('div');
        row.className = 'roster-row';
        row.innerHTML =
          '<span class="dot ' + (m.connected ? 'on' : 'off') + '"></span><span>' + escapeHtml(m.memberName) + '</span>' +
          (m.memberName === myMemberName ? '<span class="badge badge-you">You</span>' : '') +
          (m.isLeader ? '<span class="role">' + Icons.crown + 'Leader</span>' : !m.connected ? '<span class="role">Offline</span>' : '');
        roster.appendChild(row);
      });
      const open = me.maxMembers - me.memberCount;
      $('lobby-seats').textContent = open > 0 ? open + ' open seat' + (open === 1 ? '' : 's') : 'Full';
    }
  }

  // ---------- market shock + live rank preview ----------
  function showShockLoading() {
    $('shock-loading').style.display = 'flex';
    $('shock-banner').classList.remove('active');
  }
  function fillShock(prefix, shock) {
    const tag = shock.categoryTag || 'MARKET';
    $(prefix + 'shock-tag').innerHTML = Icons[CATEGORY_ICON[tag] || 'trending'] + (CATEGORY_LABEL[tag] || tag);
    $(prefix + 'shock-title').textContent = shock.title;
    $(prefix + 'shock-desc').textContent = shock.description;
    $(prefix + 'shock-impact').textContent = shock.impact || 'No change to the numbers';
  }
  function renderShock(shock) {
    $('shock-loading').style.display = 'none';
    const el = $('shock-banner');
    if (!shock) return el.classList.remove('active');
    el.classList.add('active');
    fillShock('', shock);
  }
  function renderRankPreview(preview) {
    const el = $('rank-preview');
    if (!preview) return (el.style.display = 'none');
    el.style.display = 'flex';
    el.classList.remove('safe', 'caution', 'risk');
    el.classList.add(preview.status);
    $('rank-preview-num').textContent = '#' + preview.rank;
    const label =
      preview.status === 'safe'
        ? 'On track to sell all ' + preview.offered
        : preview.status === 'caution'
        ? 'Only ' + preview.predictedSold + ' of ' + preview.offered + ' would sell'
        : preview.offered === 0
        ? "You're offering 0 chips"
        : 'Scored too low to sell anything';
    $('rank-preview-text').innerHTML = escapeHtml(label) + '<small>Predicted finish of ' + preview.totalTeams + ' teams</small>';
  }

  // ---------- live price chart ----------
  function renderChartLegend(teams) {
    $('chart-legend').innerHTML = teams
      .map((t) => '<span class="item"><span class="dot" style="background:' + colorFor(t.teamId) + '"></span>' + escapeHtml(t.teamName) + '</span>')
      .join('');
  }
  function ensureLiveChart() {
    const canvas = $('live-chart');
    if (!canvas || typeof Chart === 'undefined') return null;
    if (liveChart) return liveChart;
    liveChart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        plugins: { legend: { display: false } },
        scales: {
          x: { type: 'linear', ticks: { color: '#7f8ba0', precision: 0, maxTicksLimit: 8, font: { family: 'Archivo' }, callback: (v) => Math.floor(v / 60) + ':' + String(Math.floor(v % 60)).padStart(2, '0') }, grid: { color: '#1d2838' } },
          y: { position: 'right', ticks: { color: '#7f8ba0', font: { family: 'Archivo' }, callback: (v) => '$' + v }, grid: { color: '#1d2838' } }
        }
      }
    });
    return liveChart;
  }
  function chartPointRadius(ctx) {
    return ctx.dataIndex === ctx.dataset.data.length - 1 ? 4 : 0;
  }
  function chartPointColor(ctx) {
    const data = ctx.dataset.data;
    const i = ctx.dataIndex;
    const base = colorFor(ctx.dataset._teamId);
    if (i === 0 || i !== data.length - 1) return base;
    if (data[i].y > data[i - 1].y) return COLOR_UP;
    if (data[i].y < data[i - 1].y) return COLOR_DOWN;
    return base;
  }
  function drawLiveChart(teams) {
    const chart = ensureLiveChart();
    if (!chart) return;
    const teamIds = teams.map((t) => t.teamId);
    const existingIds = chart.data.datasets.map((d) => d._teamId);
    if (teamIds.length !== existingIds.length || teamIds.some((id, i) => id !== existingIds[i])) {
      chart.data.datasets = teams.map((t) => ({
        _teamId: t.teamId,
        label: t.teamName,
        data: [],
        borderColor: colorFor(t.teamId),
        backgroundColor: colorFor(t.teamId),
        tension: 0.2,
        borderWidth: t.teamId === myTeamId ? 2.6 : 1.6,
        pointRadius: chartPointRadius,
        pointBackgroundColor: chartPointColor,
        pointBorderColor: chartPointColor,
        spanGaps: true
      }));
      renderChartLegend(teams);
    }
    chart.data.datasets.forEach((ds) => {
      ds.data = (chartSeries[ds._teamId] || []).map((p) => ({ x: p.t, y: p.y }));
    });
    chart.update('none');
  }
  function sampleChartPoint(teams) {
    if (!teams || !teams.length) return;
    if (chartStartTime == null) chartStartTime = Date.now();
    const t = (Date.now() - chartStartTime) / 1000;
    teams.forEach((team) => {
      if (!chartSeries[team.teamId]) chartSeries[team.teamId] = [];
      const isTransientZero = team.price === 0 && !team.locked;
      const y = isTransientZero ? (lastValidPriceByTeam[team.teamId] != null ? lastValidPriceByTeam[team.teamId] : team.price) : team.price;
      if (!isTransientZero) lastValidPriceByTeam[team.teamId] = team.price;
      const series = chartSeries[team.teamId];
      series.push({ t, y });
      if (series.length > 600) series.shift();
    });
    lastTeamsSnapshot = teams;
    drawLiveChart(teams);
  }
  function resetLiveChart() {
    chartSeries = {};
    chartStartTime = null;
    lastTeamsSnapshot = null;
    lastValidPriceByTeam = {};
    if (liveChart) {
      liveChart.destroy();
      liveChart = null;
    }
  }

  // ---------- order board ----------
  function valueHtml(id, value, lastMap) {
    const prev = lastMap[id];
    let cls = '', arrow = '';
    if (prev != null && prev !== value) {
      const up = value > prev;
      cls = ' pop ' + (up ? 'up' : 'down');
      arrow = '<span class="value-arrow ' + (up ? 'up">▲' : 'down">▼') + '</span>';
    }
    lastMap[id] = value;
    return '<span class="flash-value' + cls + '">' + value + '</span>' + arrow;
  }
  function changePctFor(teamId, currentPrice) {
    if (!lastHistory.length) return null;
    const prev = lastHistory[lastHistory.length - 1].results.find((r) => r.teamId === teamId);
    if (!prev || !prev.price) return null;
    return ((currentPrice - prev.price) / prev.price) * 100;
  }
  function sparklineSvg(points, color) {
    if (!points || points.length < 2) return '<svg class="spark" viewBox="0 0 60 22" width="60" height="22"></svg>';
    const min = Math.min.apply(null, points), max = Math.max.apply(null, points);
    const range = max - min || 1;
    const step = 60 / (points.length - 1);
    const coords = points.map((v, i) => (i * step).toFixed(1) + ',' + (20 - ((v - min) / range) * 18).toFixed(1)).join(' ');
    return '<svg class="spark" viewBox="0 0 60 22" width="60" height="22"><polyline points="' + coords + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
      const techHtml = valueHtml(t.teamId, t.techLevel, lastTechByTeam);
      const capHtml = valueHtml(t.teamId, t.capacityLevel, lastCapByTeam);
      const justLocked = lastLockByTeam[t.teamId] === false && t.locked === true;
      lastLockByTeam[t.teamId] = t.locked;

      const chgPct = changePctFor(t.teamId, t.price);
      let chgCls = 'chg-flat', chgText = '—';
      if (chgPct != null) {
        if (chgPct > 0.05) (chgCls = 'chg-up'), (chgText = '▲ ' + chgPct.toFixed(1) + '%');
        else if (chgPct < -0.05) (chgCls = 'chg-down'), (chgText = '▼ ' + Math.abs(chgPct).toFixed(1) + '%');
        else chgText = '0.0%';
      }
      const pts = lastHistory.map((h) => h.results.find((r) => r.teamId === t.teamId)).filter(Boolean).map((r) => r.price);
      pts.push(t.price);

      const row = document.createElement('div');
      row.className = 'watchlist-row' + (t.teamId === myTeamId ? ' mine' : '') + (changed ? ' flash' : '') + (justLocked ? ' lock-flash' : '') + (!t.connected && !t.isBot ? ' offline' : '');
      row.innerHTML =
        '<div class="sym"><span class="sym-dot" style="background:' + colorFor(t.teamId) + '"></span><span class="nm">' + escapeHtml(t.teamName) + '</span>' +
        (t.teamId === myTeamId ? '<span class="badge badge-you">You</span>' : '') + (t.isBot ? '<span class="badge badge-bot">Bot</span>' : '') + '</div>' +
        '<div>$' + priceHtml + '</div>' +
        '<div><span class="chg ' + chgCls + '">' + chgText + '</span></div>' +
        '<div>' + qtyHtml + '</div>' +
        '<div>' + techHtml + ' · ' + capHtml + '</div>' +
        '<div>' + sparklineSvg(pts.slice(-8), colorFor(t.teamId)) + '</div>' +
        '<div class="lock-cell"><span class="lock-indicator ' + (t.locked ? 'locked' : 'open') + '" title="' + (t.locked ? 'Locked in' : 'Not locked yet') + '">' + (t.locked ? Icons.lock : Icons.unlock) + '</span></div>';
      el.appendChild(row);
    });
  }

  // ---------- contribution ----------
  function contribTags(c) {
    const s = c.stats || {};
    const tags = [];
    if (s.finalPrice) tags.push('Final price ×' + s.finalPrice);
    if (s.finalQty) tags.push('Final quantity ×' + s.finalQty);
    const ups = (s.techBuys || 0) + (s.capBuys || 0);
    if (ups) tags.push(ups + ' upgrade' + (ups > 1 ? 's' : '') + ' (' + money(s.investSpent) + ')');
    if (s.lockIns) tags.push('Locked in ×' + s.lockIns);
    const edits = (s.priceEdits || 0) + (s.qtyEdits || 0);
    if (edits) tags.push(edits + ' edit' + (edits > 1 ? 's' : ''));
    const msgs = (s.teamMsgs || 0) + (s.globalMsgs || 0);
    if (msgs) tags.push(msgs + ' message' + (msgs > 1 ? 's' : ''));
    return tags;
  }
  function contribRowHtml(m, teamTotal, opts) {
    opts = opts || {};
    const c = m.contribution || { total: 0, share: 0, pricing: 0, investment: 0, execution: 0, communication: 0, recent: [], stats: {} };
    const pct = (x) => (teamTotal > 0 ? (x / teamTotal) * 100 : 0).toFixed(1) + '%';
    const tags = contribTags(c);
    const log = (opts.logFilter ? c.recent.filter(opts.logFilter) : c.recent).slice().reverse();
    return (
      '<div class="contrib-row' + (opts.open ? ' open' : '') + '" data-name="' + escapeHtml(m.memberName) + '">' +
      '<div class="contrib-top"><span class="nm">' + escapeHtml(m.memberName) + '</span>' +
      (m.memberName === myMemberName && opts.markMe !== false ? '<span class="badge badge-you">You</span>' : '') +
      (opts.mvp ? '<span class="mvp-tag">' + Icons.award + 'MVP</span>' : '') +
      (m.isLeader ? '<span class="icon-slot" style="color:var(--gold)" title="Team leader">' + Icons.crown + '</span>' : '') +
      '<span class="share">' + c.share + '%</span></div>' +
      '<div class="contrib-bar">' +
      ['pricing', 'investment', 'execution', 'communication'].map((k) => '<span style="width:' + pct(c[k]) + '; background:' + CONTRIB_COLORS[k] + '" title="' + k + ' ' + c[k] + ' pts"></span>').join('') +
      '</div>' +
      '<div class="contrib-tags">' + (tags.length ? tags.map((t) => '<span class="t">' + escapeHtml(t) + '</span>').join('') : '<span class="t">No actions yet</span>') + '<span class="t" style="border-color:transparent; background:none; color:var(--ink-dim)">' + c.total + ' pts</span></div>' +
      (log.length && !opts.hideLog
        ? (opts.alwaysLog ? '' : '<button class="contrib-toggle" type="button">' + (opts.open ? 'Hide' : 'Show') + ' activity</button>') +
          '<div class="contrib-log"' + (opts.alwaysLog ? ' style="display:block"' : '') + '>' + log.map((e) => '<div><b>R' + e.round + '</b>' + escapeHtml(e.text) + '</div>').join('') + '</div>'
        : '') +
      '</div>'
    );
  }
  function renderContribution(me) {
    const list = $('contrib-list');
    if (!me || !me.members) return;
    const members = me.members.slice().sort((a, b) => (b.contribution ? b.contribution.total : 0) - (a.contribution ? a.contribution.total : 0));
    const total = members.reduce((s, m) => s + (m.contribution ? m.contribution.total : 0), 0);
    list.innerHTML = members.map((m) => contribRowHtml(m, total, { open: openContribRows.has(m.memberName) })).join('');
    if (members.length === 1) list.insertAdjacentHTML('beforeend', '<p class="hint-text" style="padding-top:8px;">Playing solo. Share the room code and teammates can join your company.</p>');
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.contrib-toggle');
    if (!btn) return;
    const row = btn.closest('.contrib-row');
    row.classList.toggle('open');
    btn.textContent = (row.classList.contains('open') ? 'Hide' : 'Show') + ' activity';
    if (row.closest('#contrib-list')) {
      const n = row.dataset.name;
      if (row.classList.contains('open')) openContribRows.add(n);
      else openContribRows.delete(n);
    }
  });

  // ---------- game screen ----------
  function renderDots(containerId, level) {
    let html = '';
    for (let i = 0; i < 5; i++) html += '<span class="lvl-dot' + (i < level ? ' filled' : '') + '"></span>';
    $(containerId).innerHTML = html;
  }
  function renderRoundTrack(round, total, phase) {
    let html = '';
    for (let i = 1; i <= total; i++) {
      const cls = i < round || (i === round && phase !== 'round_active') ? 'done' : i === round ? 'now' : '';
      html += '<span class="' + cls + '"></span>';
    }
    $('round-track').innerHTML = html;
  }

  function renderGameState(payload) {
    $('hdr-round').textContent = payload.round;
    $('hdr-total-rounds').textContent = payload.totalRounds;
    renderRoundTrack(payload.round, payload.totalRounds, payload.phase);
    $('hdr-mp').textContent = payload.marketPrice ? payload.marketPrice.toFixed(0) : '—';
    if (payload.totalDemand != null) {
      $('hdr-demand').textContent = payload.totalDemand.toLocaleString();
      $('tip-demand').setAttribute(
        'data-tip',
        'Apple buys ' + payload.totalDemand.toLocaleString() + ' chips in total this round (' + payload.demandPerTeam + ' × ' + payload.teams.length + ' teams) from one shared pool. The best-scoring sellers are filled first; the rest can sell nothing.'
      );
    }
    if (payload.timeLeft != null && lastTimeLeft == null) updateTimer(payload.timeLeft);
    if (payload.phase === 'round_active') renderShock(payload.shock);

    renderTicker(payload.teams);
    if (payload.phase === 'round_active') sampleChartPoint(payload.teams);

    const me = payload.teams.find((t) => t.teamId === myTeamId);
    if (!me) return;

    $('hdr-me').textContent = me.teamName;
    $('bar-me-name').textContent = myMemberName || 'My team';
    $('my-capital').textContent = money(me.capital);
    $('my-capital').className = 'v' + (me.capital < 0 ? ' neg' : '');
    $('my-inventory').textContent = me.inventory.toLocaleString();
    $('my-value').textContent = money(companyValue(me));
    $('inventory-hint').textContent = 'In stock: ' + me.inventory;

    renderDots('tech-dots', me.techLevel);
    renderDots('cap-dots', me.capacityLevel);
    $('tech-level').textContent = me.techLevel;
    $('cap-level').textContent = me.capacityLevel;
    $('btn-buy-tech').disabled = me.locked || me.techLevel >= 5;
    $('btn-buy-cap').disabled = me.locked || me.capacityLevel >= 5;
    $('btn-buy-tech-label').textContent = me.techLevel >= 5 ? 'Maxed' : 'Buy ' + money(me.nextTechCost);
    $('btn-buy-cap-label').textContent = me.capacityLevel >= 5 ? 'Maxed' : 'Buy ' + money(me.nextCapacityCost);
    $('btn-undo-tech').disabled = me.locked || !me.canUndoTech;
    $('btn-undo-cap').disabled = me.locked || !me.canUndoCapacity;

    amILeader = !!payload.amILeader;
    const leaderMember = (me.members || []).find((m) => m.isLeader);
    myLeaderName = leaderMember ? leaderMember.memberName : null;
    updateChatComposer();
    renderContribution(me);

    const priceInput = $('in-price');
    const qtyInput = $('in-qty');
    qtyInput.max = me.inventory;
    if (payload.maxPrice) {
      priceInput.max = payload.maxPrice;
      $('price-cap-hint').textContent = 'Cap $' + payload.maxPrice.toLocaleString();
    }
    if (document.activeElement !== priceInput) priceInput.value = me.price;
    if (document.activeElement !== qtyInput) qtyInput.value = me.quantity;
    priceInput.disabled = me.locked;
    qtyInput.disabled = me.locked;

    $('btn-lockin').disabled = me.locked;
    $('btn-lockin-label').textContent = me.locked ? 'Locked in' : 'Lock in';
    $('ticket-state').textContent = me.locked ? 'Locked' : 'Open';
    $('ticket-state').style.color = me.locked ? 'var(--ok)' : '';
    $('ticket-state').style.borderColor = me.locked ? 'rgba(63,182,139,.5)' : '';
    const waiting = payload.teams.filter((t) => !t.locked).length;
    $('lockin-status').textContent = me.locked ? (waiting ? 'Waiting for ' + waiting + ' more team' + (waiting > 1 ? 's' : '') + ' to lock in.' : 'Everyone is in. Apple is buying…') : 'Final for this round once locked.';
    renderRankPreview(payload.phase === 'round_active' ? payload.preview : null);
  }

  function sendInputUpdate() {
    clearTimeout(priceTimer);
    priceTimer = setTimeout(() => {
      socket.emit('UPDATE_INPUT', { roomCode: myRoomCode, teamId: myTeamId, price: Number($('in-price').value) || 0, quantity: Number($('in-qty').value) || 0 });
    }, 120);
  }

  function updateTimer(timeLeft) {
    lastTimeLeft = timeLeft;
    const m = Math.max(0, Math.floor(timeLeft / 60));
    const s = Math.max(0, timeLeft % 60);
    const el = $('hdr-timer');
    el.textContent = m + ':' + String(s).padStart(2, '0');
    el.classList.remove('warn', 'danger');
    if (timeLeft <= 20) el.classList.add('danger');
    else if (timeLeft <= 60) el.classList.add('warn');
  }

  // ---------- celebration ----------
  function triggerCelebration(revenue) {
    Sound.victory();
    const overlay = $('celebration-overlay');
    const rain = $('money-rain');
    rain.innerHTML = '';
    for (let i = 0; i < 28; i++) {
      const span = document.createElement('span');
      span.className = 'money-particle' + (i % 3 === 0 ? ' alt' : '');
      span.style.left = Math.random() * 100 + '%';
      span.style.animationDuration = 1.6 + Math.random() * 1.4 + 's';
      span.style.animationDelay = Math.random() * 0.6 + 's';
      rain.appendChild(span);
    }
    $('celebration-sub').textContent = money(revenue) + ' revenue, the most of any team';
    overlay.classList.add('active');
    setTimeout(() => {
      overlay.classList.remove('active');
      rain.innerHTML = '';
    }, 3200);
  }

  // ---------- results ----------
  function renderResults(payload) {
    Sound.results();
    $('res-round').textContent = payload.round;
    $('res-mp').textContent = payload.marketPrice.toFixed(0);
    const shockEl = $('res-shock-banner');
    if (payload.shock) {
      shockEl.classList.add('active');
      fillShock('res-', payload.shock);
    } else shockEl.classList.remove('active');

    const body = $('res-table-body');
    body.innerHTML = '';
    payload.results.forEach((r, idx) => {
      const tr = document.createElement('tr');
      if (r.teamId === myTeamId) tr.classList.add('me');
      if (idx === 0) tr.classList.add('winner');
      const prev = lastHistory.length > 1 ? lastHistory[lastHistory.length - 2].results.find((x) => x.teamId === r.teamId) : null;
      let valCls = '';
      if (prev && prev.companyValue != null && r.companyValue != null) valCls = r.companyValue > prev.companyValue ? 'chg-up' : r.companyValue < prev.companyValue ? 'chg-down' : '';
      tr.innerHTML =
        '<td><b>' + (idx === 0 ? '<span class="star-icon">' + Icons.star + '</span> ' : '') + escapeHtml(r.teamName) + '</b></td>' +
        '<td>$' + r.price + '</td><td>' + r.quantitySold + '<span class="muted">/' + r.quantityOffered + '</span></td><td>' + money(r.revenue) + '</td>' +
        '<td>' + r.unsoldInventory + '</td><td>' + r.techLevel + '</td><td>' + r.capacityLevel + '</td>' +
        '<td class="' + valCls + '">' + (r.companyValue != null ? money(r.companyValue) : '—') + '</td>';
      body.appendChild(tr);
    });
    const myIdx = payload.results.findIndex((r) => r.teamId === myTeamId);
    const mine = payload.results[myIdx];
    $('res-my-rank').textContent = mine ? '#' + (myIdx + 1) : '—';
    $('res-my-rev').textContent = mine ? money(mine.revenue) : '—';
    $('res-my-value').textContent = mine && mine.companyValue != null ? money(mine.companyValue) : '—';
    $('res-waiting-text').textContent = payload.isFinalRound ? 'Tallying final Company Values…' : 'Round ' + (payload.round + 1) + ' opens automatically in a few seconds.';
    renderRoundContribution(payload.round);

    if (mine && myIdx === 0 && mine.revenue > 0) triggerCelebration(mine.revenue);
  }
  function renderRoundContribution(round) {
    const el = $('res-contrib');
    const me = lastState && lastState.teams.find((t) => t.teamId === myTeamId);
    if (!me) return (el.innerHTML = '');
    const members = me.members || [];
    const rows = members.map((m) => {
      const acts = ((m.contribution && m.contribution.recent) || []).filter((e) => e.round === round);
      return (
        '<div class="contrib-row open"><div class="contrib-top"><span class="nm">' + escapeHtml(m.memberName) + '</span>' +
        (m.memberName === myMemberName ? '<span class="badge badge-you">You</span>' : '') +
        '<span class="pts" style="margin-left:auto">' + acts.length + ' action' + (acts.length === 1 ? '' : 's') + '</span></div>' +
        '<div class="contrib-log">' + (acts.length ? acts.map((e) => '<div>' + escapeHtml(e.text) + '</div>').join('') : '<div>No decisions this round</div>') + '</div></div>'
      );
    });
    el.innerHTML = rows.join('');
  }

  // ---------- game over ----------
  function renderGameOver(payload) {
    if (payload.winner && payload.winner.teamId === myTeamId) Sound.victory();
    else Sound.results();
    $('final-winner-banner').textContent = payload.winner ? payload.winner.teamName + ' wins' : 'Game over';
    const el = $('final-leaderboard');
    el.innerHTML = '';
    payload.leaderboard.forEach((t, idx) => {
      const mvp = (t.contributions || []).slice().sort((a, b) => b.total - a.total)[0];
      const row = document.createElement('div');
      row.className = 'leaderboard-row' + (idx === 0 ? ' first' : '');
      row.innerHTML =
        '<div class="rank">' + (idx === 0 ? Icons.star : '') + (idx + 1) + '</div>' +
        '<div class="name"><b>' + escapeHtml(t.teamName) + '</b>' + (t.teamId === myTeamId ? ' <span class="badge badge-you">You</span>' : '') +
        '<div class="breakdown">Cash ' + money(t.capital) + ' + ' + t.inventory + ' chips (' + money(t.inventory * 10) + ') + Tech ' + t.techLevel + ' (' + money(t.techLevel * 500) + ') + Capacity ' + t.capacityLevel + ' (' + money(t.capacityLevel * 500) + ')' +
        (mvp && mvp.total > 0 ? ' · MVP ' + escapeHtml(mvp.memberName) : '') + '</div></div>' +
        '<div class="value">' + money(t.companyValue) + '</div>';
      el.appendChild(row);
    });
    const mine = payload.leaderboard.find((t) => t.teamId === myTeamId);
    const fc = $('final-contrib');
    if (mine && mine.contributions && mine.contributions.length) {
      const sorted = mine.contributions.slice().sort((a, b) => b.total - a.total);
      const total = sorted.reduce((s, m) => s + m.total, 0);
      fc.innerHTML = sorted.map((m, i) => contribRowHtml({ memberName: m.memberName, contribution: m }, total, { mvp: i === 0 && m.total > 0 && sorted.length > 1 })).join('');
    } else fc.innerHTML = '<div class="empty-state">No contribution data.</div>';
    lastHistory = payload.history || [];
    renderCharts(lastHistory);
  }

  // ---------- post-match charts + CSV ----------
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
        borderWidth: id === myTeamId ? 3 : 1.8,
        cubicInterpolationMode: 'monotone',
        spanGaps: true
      }));
    const valueData = seriesFor((r) => (r.companyValue != null ? r.companyValue : r.capital + r.unsoldInventory * 10 + r.techLevel * 500 + r.capacityLevel * 500));
    const priceData = seriesFor((r) => r.price);
    const mpData = [{ label: 'Market price', data: history.map((h) => h.marketPrice), borderColor: '#e3b341', backgroundColor: '#e3b341', cubicInterpolationMode: 'monotone' }];
    charts.value = new Chart($('chart-value').getContext('2d'), { type: 'line', data: { labels, datasets: valueData }, options: chartOptions() });
    charts.price = new Chart($('chart-price').getContext('2d'), { type: 'line', data: { labels, datasets: priceData }, options: Object.assign(chartOptions(), { aspectRatio: 3.4 }) });
    charts.mp = new Chart($('chart-mp').getContext('2d'), { type: 'line', data: { labels, datasets: mpData }, options: chartOptions() });
  }

  function downloadMatchCSV() {
    if (!lastHistory || !lastHistory.length) return;
    const rows = [['round', 'marketPrice', 'shockTitle', 'teamName', 'price', 'quantityOffered', 'quantitySold', 'revenue', 'unsoldInventory', 'capital', 'techLevel', 'capacityLevel', 'companyValue', 'competitiveScore']];
    lastHistory.forEach((h) =>
      h.results.forEach((r) => rows.push([h.round, h.marketPrice, h.shock ? h.shock.title : '', r.teamName, r.price, r.quantityOffered, r.quantitySold, r.revenue, r.unsoldInventory, r.capital, r.techLevel, r.capacityLevel, r.companyValue, r.competitiveScore]))
    );
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
  function chatLogEl(channel) {
    return $(channel === 'global' ? 'chat-log-global' : 'chat-log-team');
  }
  function appendRow(log, row) {
    const empty = log.querySelector('.chat-empty');
    if (empty) empty.remove();
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  function appendChatBubble(msg) {
    const log = chatLogEl(msg.channel);
    const row = document.createElement('div');
    const isHost = msg.name === 'HOST' && !msg.teamId;
    row.className = 'chat-msg' + (isHost ? ' host' : '');
    const color = msg.channel === 'team' ? colorFor(msg.name) : colorFor(msg.teamId || msg.name);
    const who = isHost ? 'Host' : escapeHtml(msg.name) + (msg.actor ? ' <small>' + escapeHtml(msg.actor) + '</small>' : '');
    row.innerHTML = '<span class="who" style="color:' + color + '">' + who + '</span>' + escapeHtml(msg.text);
    appendRow(log, row);
  }
  function appendKillfeed(msg) {
    const log = chatLogEl(msg.channel);
    const row = document.createElement('div');
    row.className = 'chat-msg system act-' + (msg.actionType || '');
    const icon = Icons[ACTION_ICON[msg.actionType]] || Icons.trending;
    row.innerHTML = '<span class="act-icon">' + icon + '</span><span><b>' + escapeHtml(msg.name) + '</b>' + (msg.actor ? ' (' + escapeHtml(msg.actor) + ')' : '') + ' ' + escapeHtml(msg.text) + '</span>';
    appendRow(log, row);
  }
  function appendBlockedNotice(reason) {
    Sound.error();
    const row = document.createElement('div');
    row.className = 'chat-msg notice';
    row.textContent = reason;
    appendRow(chatLogEl(activeChannel === 'global' ? 'global' : 'team'), row);
  }
  function routeChatMessage(msg) {
    if (msg.kind === 'system') appendKillfeed(msg);
    else appendChatBubble(msg);
  }
  function updateChatComposer() {
    document.querySelectorAll('.channel-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.channel === activeChannel));
    const isChat = activeChannel !== 'contrib';
    $('comms-chat').style.display = isChat ? '' : 'none';
    $('comms-contrib').style.display = isChat ? 'none' : '';
    if (!isChat) return;
    chatLogEl('team').style.display = activeChannel === 'team' ? '' : 'none';
    chatLogEl('global').style.display = activeChannel === 'global' ? '' : 'none';
    const input = $('chat-input');
    const canPost = activeChannel === 'team' || amILeader;
    input.disabled = !canPost;
    $('btn-chat-send').disabled = !canPost;
    input.placeholder = activeChannel === 'team' ? 'Message your team' : canPost ? 'Negotiate with every team' : 'Only your team leader can post here';
    const hint = $('channel-hint');
    if (activeChannel !== 'global') hint.innerHTML = '';
    else if (amILeader) hint.innerHTML = Icons.crown + '<span>You lead your team, so you speak for it here.</span>';
    else if (myLeaderName) hint.innerHTML = Icons.crown + '<span><b>' + escapeHtml(myLeaderName) + '</b> speaks for your team here. You can read along.</span>';
    else hint.innerHTML = '<span>Only your team leader can post here.</span>';
  }
  function switchChannel(channel) {
    activeChannel = ['team', 'global', 'contrib'].includes(channel) ? channel : 'team';
    updateChatComposer();
  }
  function sendChat() {
    const input = $('chat-input');
    if (input.disabled) return;
    const text = input.value.trim();
    if (!text) return;
    Sound.tick();
    socket.emit('CHAT_MESSAGE', { roomCode: myRoomCode, teamId: myTeamId, channel: activeChannel, text });
    input.value = '';
  }

  // ---------- wire up ----------
  function invest(kind, btnId) {
    Sound.buy();
    Juice.squish($(btnId));
    Juice.burst($(btnId), { color: 'var(--gold)' });
    socket.emit('TEAM_INVEST', { roomCode: myRoomCode, teamId: myTeamId, kind });
  }
  function undo(kind, btnId) {
    Sound.undo();
    Juice.squish($(btnId));
    socket.emit('TEAM_UNDO_INVEST', { roomCode: myRoomCode, teamId: myTeamId, kind });
  }
  $('btn-buy-tech').addEventListener('click', () => invest('tech', 'btn-buy-tech'));
  $('btn-buy-cap').addEventListener('click', () => invest('capacity', 'btn-buy-cap'));
  $('btn-undo-tech').addEventListener('click', () => undo('tech', 'btn-undo-tech'));
  $('btn-undo-cap').addEventListener('click', () => undo('capacity', 'btn-undo-cap'));
  $('in-price').addEventListener('input', sendInputUpdate);
  $('in-qty').addEventListener('input', sendInputUpdate);
  $('btn-lockin').addEventListener('click', () => {
    const price = Number($('in-price').value) || 0;
    const qty = Number($('in-qty').value) || 0;
    let warning = null;
    if (qty === 0 && price === 0) warning = "Your price is $0 and you're offering 0 chips. Apple can't buy anything from you this round.";
    else if (qty === 0) warning = "You're offering 0 chips. Apple can't buy anything from you this round.";
    else if (price === 0) warning = 'Your price is $0. Apple would get your chips for free.';
    const doLock = () => {
      Sound.lockIn();
      Juice.squish($('btn-lockin'));
      Juice.burst($('btn-lockin'), { color: 'var(--ok)', count: 10 });
      socket.emit('LOCK_IN', { roomCode: myRoomCode, teamId: myTeamId });
    };
    if (warning) return showConfirm('Lock in anyway?', warning, 'Lock in anyway', doLock);
    doLock();
  });
  $('btn-chat-send').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChat();
  });
  document.querySelectorAll('.channel-tab').forEach((btn) =>
    btn.addEventListener('click', () => {
      Sound.click();
      switchChannel(btn.dataset.channel);
    })
  );

  // ---------- socket events ----------
  socket.on('HISTORY_SYNC', ({ history }) => {
    lastHistory = history || [];
  });
  socket.on('LOBBY_UPDATE', (payload) => {
    if (!myTeamId || !payload.teams.some((t) => t.teamId === myTeamId)) return;
    if (payload.phase === 'lobby') {
      lastHistory = [];
      resetLiveChart();
    }
    renderLobby(payload);
    routeScreen(payload.phase);
  });
  socket.on('STATE_SYNC', (payload) => {
    if (!myTeamId) return;
    if (!payload.teams.some((t) => t.teamId === myTeamId)) return;
    lastState = payload;
    if (payload.timeLeft != null) lastTimeLeft = payload.timeLeft;
    renderGameState(payload);
    setPhaseClasses(payload.phase);
    if (payload.phase === 'round_active') routeScreen('round_active');
    if (payload.phase === 'round_results') renderRoundContribution(payload.round);
    analyst.update(analystState());
  });
  socket.on('ROUND_STARTING', () => {
    routeScreen('round_active');
    showShockLoading();
  });
  socket.on('ROUND_START', (payload) => {
    lastTicker = {};
    routeScreen('round_active');
    if (payload && payload.timeLeft != null) updateTimer(payload.timeLeft);
    if (payload && payload.shock) {
      renderShock(payload.shock);
      Sound.shock();
      Juice.shake($('shock-banner'));
    }
  });
  socket.on('TIMER_TICK', ({ timeLeft }) => {
    updateTimer(timeLeft);
    if (lastState) lastState.timeLeft = timeLeft;
    if (lastTeamsSnapshot) sampleChartPoint(lastTeamsSnapshot);
    analyst.update(analystState());
  });
  socket.on('ROUND_RESULT', (payload) => {
    if (!lastHistory.length || lastHistory[lastHistory.length - 1].round !== payload.round) lastHistory.push(payload);
    renderResults(payload);
    routeScreen('round_results');
  });
  socket.on('GAME_OVER', (payload) => {
    renderGameOver(payload);
    routeScreen('game_over');
  });
  socket.on('CHAT_MESSAGE', routeChatMessage);
  socket.on('CHAT_BLOCKED', ({ reason }) => appendBlockedNotice(reason || 'Message blocked.'));
  socket.on('CHAT_SYNC', (payload) => {
    chatLogEl('team').innerHTML = '<div class="chat-empty">Plan privately here. Only your teammates can read this channel.</div>';
    chatLogEl('global').innerHTML = '<div class="chat-empty">Every team reads this. Each team\'s leader can post, and every lock-in and upgrade shows up here.</div>';
    (payload.team || []).forEach(routeChatMessage);
    (payload.global || []).forEach(routeChatMessage);
  });
  socket.on('ROOM_CLOSED', ({ reason }) => {
    showConfirm('Room closed', reason || 'The host has closed this room.', 'OK', backToJoin, { noCancel: true, neutral: true });
  });
  socket.on('KICKED', ({ reason }) => {
    showConfirm('Removed from the room', reason || 'The host removed your team from this room.', 'OK', backToJoin, { noCancel: true, neutral: true });
  });

  // Tooltips: hover on desktop; tap to toggle on touch.
  document.addEventListener('click', (e) => {
    const tip = e.target.closest('.info-tip');
    if (tip) {
      e.stopPropagation();
      document.querySelectorAll('.info-tip.show').forEach((o) => o !== tip && o.classList.remove('show'));
      tip.classList.toggle('show');
    } else {
      document.querySelectorAll('.info-tip.show').forEach((o) => o.classList.remove('show'));
    }
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

  // ---------- analyst (in-browser assistant) ----------
  function analystState() {
    if (!lastState) return null;
    return Object.assign({}, lastState, { myTeamId, timeLeft: lastTimeLeft });
  }
  const analyst = Analyst.mount({ mode: 'player', getState: analystState });

  injectIcons();
  updateSoundToggleIcon();
  updateChatComposer();
  showStep('roomcode');
  if (wafer) wafer.start();
  tryAutoRejoin();
})();
