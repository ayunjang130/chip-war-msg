(function () {
  // Deliberately red/blue-free (those are reserved for price up/down below)
  // and gold-free (the old theme color is gone) - 8 clearly distinct hues.
  const TEAM_COLORS = ['#f1f5f9', '#2dd4bf', '#fb923c', '#f472b6', '#84cc16', '#c084fc', '#e879f9', '#94a3b8'];
  // Korean market convention (not the US green-up/red-down one): red = up, blue = down.
  const COLOR_UP = '#ef4444';
  const COLOR_DOWN = '#3b82f6';
  const SESSION_KEY = 'chipwar_session';

  const socket = io();

  let myRoomCode = null;
  let myTeamId = null;
  let myMemberId = null;
  let selectedJoinTeamId = null;
  let lookupTimer = null;
  let lastTicker = {}; // teamId -> "price:quantity" for whole-card flash-on-change
  let lastPriceByTeam = {};
  let lastQtyByTeam = {};
  let lastTechByTeam = {};
  let lastCapByTeam = {};
  let lastLockByTeam = {};
  let priceTimer = null;
  let lastHistory = [];
  let charts = {};
  let liveChart = null; // the in-game real-time price chart (separate from the post-match summary charts)
  let chartSeries = {}; // teamId -> [{t: secondsSinceMatchStart, y: price}], continuous across the whole match
  let chartStartTime = null;
  let lastTeamsSnapshot = null; // most recent teams array, so TIMER_TICK can sample without its own payload
  let confirmCallback = null;
  let activeChannel = 'team'; // 'team' | 'global' - which negotiation channel tab is showing
  let amILeader = false; // this device's current post permission in the All-Teams channel
  let myLeaderName = null; // display name of whoever currently leads my team

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  function injectIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (window.Icons && Icons[el.dataset.icon] != null) el.innerHTML = Icons[el.dataset.icon];
    });
  }
  const CATEGORY_ICON = { CAPACITY: 'layers', COST: 'dollar', DEMAND: 'package', PRIORITY: 'target', MARKET: 'trending' };
  const ACTION_ICON = { lock: 'lock', tech_up: 'cpu', tech_down: 'cpu', capacity_up: 'layers', capacity_down: 'layers' };
  function money(n) {
    n = Math.round(n || 0);
    return n < 0 ? '-$' + Math.abs(n).toLocaleString() : '$' + n.toLocaleString();
  }
  function colorFor(teamId) {
    let h = 0;
    for (let i = 0; i < teamId.length; i++) h = (h * 31 + teamId.charCodeAt(i)) | 0;
    return TEAM_COLORS[Math.abs(h) % TEAM_COLORS.length];
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  function forgetSession() {
    localStorage.removeItem(SESSION_KEY);
    myRoomCode = null;
    myTeamId = null;
    myMemberId = null;
  }
  function saveSession() {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: myRoomCode, teamId: myTeamId, memberId: myMemberId }));
  }

  // ---------- custom confirm/notice modal (replaces native confirm()/alert()) ----------
  function showConfirm(title, message, confirmLabel, onConfirm, opts) {
    opts = opts || {};
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-ok-btn').textContent = confirmLabel || 'Confirm';
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

  // ---------- step navigation (join screen) ----------
  function showStep(name) {
    ['roomcode', 'choice', 'create', 'join'].forEach((s) => {
      $('step-' + s).style.display = s === name ? 'block' : 'none';
    });
  }
  document.querySelectorAll('[data-back]').forEach((b) => {
    b.addEventListener('click', () => showStep(b.dataset.back));
  });

  $('btn-find-room').addEventListener('click', () => doLookup());
  $('in-roomcode').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLookup(); });

  function doLookup() {
    const code = $('in-roomcode').value.trim().toUpperCase();
    const err = $('lookup-error');
    err.textContent = '';
    if (code.length !== 5) return (err.textContent = 'Room codes are 5 characters.');
    socket.emit('LOOKUP_ROOM', { roomCode: code }, (res) => {
      if (!res || !res.ok) return (err.textContent = 'Room not found — check the code.');
      renderChoiceStep(res.teams, res.phase);
    });
  }

  let lastLookupTeams = [];
  let lastLookupPhase = 'lobby';
  function renderChoiceStep(teams, phase) {
    lastLookupTeams = teams;
    lastLookupPhase = phase;
    $('choice-roomcode').textContent = $('in-roomcode').value.trim().toUpperCase();
    const openTeams = teams.filter((t) => t.memberCount < t.maxMembers);
    const blocked = phase !== 'lobby';
    $('choice-create').disabled = blocked;
    $('choice-create').style.opacity = blocked ? '0.4' : '';
    $('choice-create-note').textContent = blocked ? 'Match already started' : 'Name your team and start fresh';
    $('choice-join').disabled = openTeams.length === 0;
    $('choice-join').style.opacity = openTeams.length === 0 ? '0.4' : '';
    $('choice-join-note').textContent = openTeams.length === 0 ? 'No teams have an open seat yet' : openTeams.length + ' team' + (openTeams.length === 1 ? '' : 's') + ' have an open seat';
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
      card.dataset.teamId = t.teamId;
      card.innerHTML =
        '<div class="row-1">' +
        '<b style="font-family:var(--display);">' + escapeHtml(t.teamName) + '</b>' +
        '<span class="pill" style="margin-left:auto;">' + t.memberCount + '/' + t.maxMembers + (full ? ' · Full' : '') + '</span>' +
        '</div>';
      if (!full) {
        card.addEventListener('click', () => {
          document.querySelectorAll('.team-select-card').forEach((c) => c.classList.remove('selected'));
          card.classList.add('selected');
          selectedJoinTeamId = t.teamId;
          $('btn-join-existing').disabled = false;
        });
      }
      list.appendChild(card);
    });
  }

  function doJoin() {
    const roomCode = $('choice-roomcode').textContent.trim();
    const teamName = $('in-teamname').value.trim();
    const err = $('join-error');
    err.textContent = '';
    if (!teamName) return (err.textContent = 'Give your team a name.');

    const btn = $('btn-join');
    btn.disabled = true;
    btn.textContent = 'Creating…';
    socket.emit('JOIN_ROOM', { roomCode, teamName }, (res) => {
      btn.disabled = false;
      btn.textContent = 'Create team';
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
      myMemberId = res.memberId;
      saveSession();
    });
  }
  $('btn-join').addEventListener('click', doJoin);
  $('in-teamname').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  function doJoinExisting() {
    if (!selectedJoinTeamId) return;
    const roomCode = $('choice-roomcode').textContent.trim();
    const memberName = $('in-membername').value.trim();
    const err = $('join-existing-error');
    err.textContent = '';
    const btn = $('btn-join-existing');
    btn.disabled = true;
    btn.textContent = 'Joining…';
    socket.emit('JOIN_ROOM', { roomCode, teamId: selectedJoinTeamId, memberName }, (res) => {
      btn.disabled = false;
      btn.textContent = 'Join team';
      if (!res || !res.ok) {
        err.textContent = res && res.error === 'TEAM_FULL' ? 'That team just filled up — pick another.' : 'Could not join — try again.';
        return;
      }
      myRoomCode = res.roomCode;
      myTeamId = res.teamId;
      myMemberId = res.memberId;
      saveSession();
    });
  }
  $('btn-join-existing').addEventListener('click', doJoinExisting);

  function tryAutoRejoin() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
      saved = null;
    }
    if (!saved || !saved.roomCode || !saved.teamId || !saved.memberId) return;
    socket.emit('JOIN_ROOM', { roomCode: saved.roomCode, teamId: saved.teamId, memberId: saved.memberId }, (res) => {
      if (res && res.ok) {
        myRoomCode = res.roomCode;
        myTeamId = res.teamId;
        myMemberId = res.memberId;
      } else {
        forgetSession();
      }
    });
  }

  $('btn-exit-blocked').addEventListener('click', () => {
    $('in-roomcode').value = '';
    showStep('roomcode');
    activateScreen('screen-join');
  });

  function leaveRoom() {
    showConfirm('Leave this game?', "You'll be removed from your team. You can rejoin later with the room code.", 'Leave Game', () => {
      socket.emit('LEAVE_ROOM', { roomCode: myRoomCode, teamId: myTeamId, memberId: myMemberId });
      forgetSession();
      $('in-roomcode').value = '';
      $('in-teamname').value = '';
      showStep('roomcode');
      activateScreen('screen-join');
    });
  }
  ['btn-leave-room', 'btn-leave-room-game', 'btn-leave-room-results', 'btn-leave-room-final'].forEach((id) => {
    $(id).addEventListener('click', leaveRoom);
  });

  // ---------- lobby screen ----------
  function renderLobby(payload) {
    $('lobby-roomcode').textContent = payload.roomCode;
    $('lobby-count').textContent = payload.teams.length;
    const me = payload.teams.find((t) => t.teamId === myTeamId);
    $('lobby-company').textContent = me ? me.teamName : '—';
    const list = $('lobby-team-list');
    list.innerHTML = '';
    payload.teams.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'pill';
      row.style.justifyContent = 'flex-start';
      row.style.alignItems = 'center';
      row.innerHTML =
        '<span class="dot" style="background:' + colorFor(t.teamId) + '"></span>' +
        '<span><b style="font-family:var(--display);">' + escapeHtml(t.teamName) + '</b>' + (t.teamId === myTeamId ? ' (me)' : '') + '</span>' +
        (t.isBot ? '' : '<span class="pill" style="margin-left:8px;">' + t.memberCount + '/' + t.maxMembers + '</span>') +
        (t.isBot ? '<span class="badge badge-bot">' + Icons.bot + ' BOT</span>' : '') +
        (!t.connected && !t.isBot ? '<span class="badge badge-offline">OFFLINE</span>' : '');
      list.appendChild(row);
    });

    if (me) {
      const rosterList = $('lobby-roster-list');
      rosterList.innerHTML = '';
      me.members.forEach((m) => {
        const row = document.createElement('div');
        row.className = 'roster-row';
        row.innerHTML =
          '<span class="dot ' + (m.connected ? 'on' : 'off') + '"></span><span>' + escapeHtml(m.memberName) + (m.connected ? '' : ' (offline)') + '</span>' +
          (m.isLeader ? '<span class="crown-badge" title="Team leader — can post in All Teams">' + Icons.crown + '</span>' : '');
        rosterList.appendChild(row);
      });
      $('lobby-roster-full-hint').textContent =
        me.memberCount >= me.maxMembers ? 'Your team is full (' + me.maxMembers + '/' + me.maxMembers + ').' : 'Share the room code — ' + (me.maxMembers - me.memberCount) + ' more seat' + (me.maxMembers - me.memberCount === 1 ? '' : 's') + ' open on your team.';
    }
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

  // ---------- market shock + live rank preview ----------
  function showShockLoading() {
    $('shock-loading').style.display = 'flex';
    $('shock-banner').style.display = 'none';
  }
  function renderShock(shock) {
    $('shock-loading').style.display = 'none';
    const el = $('shock-banner');
    if (!shock) {
      el.classList.remove('active');
      return;
    }
    el.classList.add('active');
    const tag = shock.categoryTag || 'MARKET';
    $('shock-tag').innerHTML = Icons[CATEGORY_ICON[tag] || 'trending'] + tag;
    $('shock-title').textContent = shock.title + (shock.source === 'ai' ? '' : '');
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

  // ---------- ticker ----------
  // ---------- live price chart (real-time centerpiece) ----------
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
        animation: false, // sampled too often for tweened animation to read as anything but noise
        parsing: false, // we feed {x,y} points directly
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        plugins: { legend: { display: false } },
        scales: {
          x: {
            type: 'linear',
            ticks: { color: '#868690', callback: (v) => Math.floor(v / 60) + ':' + String(Math.floor(v % 60)).padStart(2, '0') },
            grid: { color: '#19191c' }
          },
          y: { ticks: { color: '#868690', callback: (v) => '$' + v }, grid: { color: '#19191c' } }
        }
      }
    });
    return liveChart;
  }
  // The live-tick point at the end of each team's line: red if that team's
  // price just rose vs. its previous sample, blue if it fell (Korean market
  // convention, not the US green-up one), team-color otherwise. Every other
  // point stays invisible (radius 0) so only the line + this one "ticking"
  // dot draw the eye, the same way a real stock chart reads.
  function chartPointRadius(ctx) {
    return ctx.dataIndex === ctx.dataset.data.length - 1 ? 4 : 0;
  }
  function chartPointColor(ctx) {
    const data = ctx.dataset.data;
    const i = ctx.dataIndex;
    const base = colorFor(ctx.dataset._teamId);
    if (i === 0 || i !== data.length - 1) return base;
    const prev = data[i - 1].y,
      cur = data[i].y;
    if (cur > prev) return COLOR_UP;
    if (cur < prev) return COLOR_DOWN;
    return base;
  }
  function drawLiveChart(teams) {
    const chart = ensureLiveChart();
    if (!chart) return;
    const teamIds = teams.map((t) => t.teamId);
    const existingIds = chart.data.datasets.map((d) => d._teamId);
    const rosterChanged = teamIds.length !== existingIds.length || teamIds.some((id, i) => id !== existingIds[i]);
    if (rosterChanged) {
      chart.data.datasets = teams.map((t) => ({
        _teamId: t.teamId,
        label: t.teamName,
        data: [],
        borderColor: colorFor(t.teamId),
        backgroundColor: colorFor(t.teamId),
        tension: 0.2,
        borderWidth: 2,
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
  // Every team's current price, sampled onto its own continuous timeline for
  // the WHOLE MATCH (never reset per round - see resetLiveChart for when it
  // actually clears). Called on every STATE_SYNC, so an actual edit shows up
  // immediately, and once a second via TIMER_TICK, so the line keeps flowing
  // even when nobody's mid-edit - that steady tick is what makes it read as
  // "live" rather than a chart that only moves when you personally touch it.
  function sampleChartPoint(teams) {
    if (!teams || !teams.length) return;
    if (chartStartTime == null) chartStartTime = Date.now();
    const t = (Date.now() - chartStartTime) / 1000;
    teams.forEach((team) => {
      if (!chartSeries[team.teamId]) chartSeries[team.teamId] = [];
      const series = chartSeries[team.teamId];
      series.push({ t, y: team.price });
      if (series.length > 600) series.shift(); // defensive cap; not expected to matter at this game's scale
    });
    lastTeamsSnapshot = teams;
    drawLiveChart(teams);
  }
  function resetLiveChart() {
    chartSeries = {};
    chartStartTime = null;
    lastTeamsSnapshot = null;
    if (liveChart) {
      liveChart.destroy();
      liveChart = null;
    }
  }

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
  // % change vs. that team's price in the last COMPLETED round - lastHistory
  // is appended to as each ROUND_RESULT arrives (see the socket handler),
  // so this is real "since last close" math, the same shape a real ticker uses.
  function changePctFor(teamId, currentPrice) {
    if (!lastHistory.length) return null;
    const prevResult = lastHistory[lastHistory.length - 1].results.find((r) => r.teamId === teamId);
    if (!prevResult || !prevResult.price) return null;
    return ((currentPrice - prevResult.price) / prevResult.price) * 100;
  }
  // A minimal inline trend line - last few rounds' price plus this round's
  // live price, no charting library needed for something this small.
  function sparklineSvg(points, color) {
    if (!points || points.length < 2) return '<svg class="spark" viewBox="0 0 60 24" width="60" height="24"></svg>';
    const min = Math.min.apply(null, points);
    const max = Math.max.apply(null, points);
    const range = max - min || 1;
    const step = 60 / (points.length - 1);
    const coords = points.map((v, i) => i * step + ',' + (22 - ((v - min) / range) * 20)).join(' ');
    return '<svg class="spark" viewBox="0 0 60 24" width="60" height="24"><polyline points="' + coords + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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
      // A visible "just happened" ping the moment a team locks in (false ->
      // true only, so it fires once, not on every re-render while locked).
      const justLocked = lastLockByTeam[t.teamId] === false && t.locked === true;
      lastLockByTeam[t.teamId] = t.locked;

      const chgPct = changePctFor(t.teamId, t.price);
      let chgCls = 'chg-flat',
        chgText = '—';
      if (chgPct != null) {
        if (chgPct > 0.05) {
          chgCls = 'chg-up';
          chgText = '▲ +' + chgPct.toFixed(1) + '%';
        } else if (chgPct < -0.05) {
          chgCls = 'chg-down';
          chgText = '▼ ' + chgPct.toFixed(1) + '%';
        } else {
          chgText = '0.0%';
        }
      }

      const teamPoints = lastHistory
        .map((h) => h.results.find((r) => r.teamId === t.teamId))
        .filter(Boolean)
        .map((r) => r.price);
      teamPoints.push(t.price);
      const spark = sparklineSvg(teamPoints.slice(-8), colorFor(t.teamId));

      const row = document.createElement('div');
      row.className = 'watchlist-row' + (changed ? ' flash' : '') + (justLocked ? ' lock-flash' : '') + (!t.connected && !t.isBot ? ' offline' : '');
      row.innerHTML =
        '<div class="sym"><span class="sym-dot" style="background:' + colorFor(t.teamId) + '"></span>' + escapeHtml(t.teamName) +
        (t.teamId === myTeamId ? ' <span class="pill" style="margin-left:4px; padding:1px 6px; font-size:10px;">You</span>' : '') + '</div>' +
        '<div>$' + priceHtml + '</div>' +
        '<div><span class="chg ' + chgCls + '">' + chgText + '</span></div>' +
        '<div>' + qtyHtml + '</div>' +
        '<div>' + techHtml + '·' + capHtml + '</div>' +
        '<div>' + spark + '</div>' +
        '<div class="lock-cell"><span class="lock-indicator ' + (t.locked ? 'locked' : 'open') + '" title="' + (t.locked ? 'Locked' : 'Not locked yet') + '">' + (t.locked ? Icons.lock : Icons.unlock) + '</span></div>';
      el.appendChild(row);
    });
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
    if (payload.totalDemand != null) {
      $('hdr-demand').textContent = payload.totalDemand.toLocaleString();
      const teamCount = payload.teams.length;
      $('hdr-demand').parentElement.querySelector('.info-tip').setAttribute(
        'data-tip',
        'Apple buys ' + payload.totalDemand.toLocaleString() + ' chips total this round (' + payload.demandPerTeam + ' × ' + teamCount + ' teams), split across everyone. Highest-scoring sellers get filled first — the rest can sell zero.'
      );
    }
    renderShock(payload.shock);

    renderTicker(payload.teams);
    if (payload.phase === 'round_active') sampleChartPoint(payload.teams);

    const me = payload.teams.find((t) => t.teamId === myTeamId);
    if (!me) return;

    $('hdr-me').textContent = me.teamName;
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
    // Target the inner label span, not the button itself - the button also
    // holds a fixed icon-slot child that a raw textContent write would wipe.
    $('btn-buy-tech-label').textContent = me.techLevel >= 5 ? 'Maxed' : 'Buy ($' + (me.nextTechCost || 0).toLocaleString() + ')';
    $('btn-buy-cap-label').textContent = me.capacityLevel >= 5 ? 'Maxed' : 'Buy ($' + (me.nextCapacityCost || 0).toLocaleString() + ')';
    $('btn-undo-tech').disabled = me.locked || !me.canUndoTech;
    $('btn-undo-cap').disabled = me.locked || !me.canUndoCapacity;

    // Team-leader state for the negotiation channel tabs (point 3): only
    // the current leader can post in All Teams, so the composer needs to
    // know both "am I the leader" and "who is, if not me".
    amILeader = !!payload.amILeader;
    const leaderMember = (me.members || []).find((m) => m.isLeader);
    myLeaderName = leaderMember ? leaderMember.memberName : null;
    updateChatComposer();

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
    $('lockin-status').textContent = me.locked ? 'Locked in — waiting for other teams…' : 'Final once locked in.';
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

  // ---------- round-winner celebration (geometric particles, no emoji) ----------
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
    $('celebration-sub').textContent = money(revenue) + ' revenue — best in the round';
    overlay.classList.add('active');
    setTimeout(() => {
      overlay.classList.remove('active');
      rain.innerHTML = '';
    }, 3200);
  }

  // ---------- results / game over ----------
  function renderResults(payload) {
    Sound.results();
    $('res-round').textContent = payload.round;
    $('res-mp').textContent = payload.marketPrice.toFixed(0);
    const shockEl = $('res-shock-banner');
    if (payload.shock) {
      shockEl.classList.add('active');
      const tag = payload.shock.categoryTag || 'MARKET';
      $('res-shock-tag').innerHTML = Icons[CATEGORY_ICON[tag] || 'trending'] + tag;
      $('res-shock-title').textContent = payload.shock.title;
      $('res-shock-desc').textContent = payload.shock.description;
      $('res-shock-impact').textContent = payload.shock.impact || 'No numeric change this round.';
    } else {
      shockEl.classList.remove('active');
    }
    const body = $('res-table-body');
    body.innerHTML = '';
    payload.results.forEach((r, idx) => {
      const tr = document.createElement('tr');
      if (r.teamId === myTeamId) tr.classList.add('me');
      if (idx === 0) tr.classList.add('winner');
      tr.innerHTML =
        '<td><b style="font-family:var(--display);">' + (idx === 0 ? '<span class="star-icon" style="color:var(--gold);">' + Icons.star + '</span> ' : '') + escapeHtml(r.teamName) + '</b></td>' +
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

  function renderGameOver(payload) {
    if (payload.winner && payload.winner.teamId === myTeamId) Sound.victory();
    else Sound.results();
    $('final-winner-banner').textContent = payload.winner ? payload.winner.teamName + ' wins' : 'Game over';
    const el = $('final-leaderboard');
    el.innerHTML = '';
    payload.leaderboard.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row' + (idx === 0 ? ' first' : '');
      row.innerHTML =
        '<div class="rank">' + (idx === 0 ? Icons.star + ' ' : '') + (idx + 1) + '</div>' +
        '<div class="name"><b style="font-family:var(--display);">' + escapeHtml(t.teamName) + '</b>' +
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
      plugins: { legend: { labels: { color: '#f2f4f7', font: { family: 'Inter' } } } },
      scales: {
        x: { ticks: { color: '#868690' }, grid: { color: '#19191c' } },
        y: { ticks: { color: '#868690' }, grid: { color: '#19191c' } }
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
        tension: 0.25,
        spanGaps: true
      }));

    const valueData = seriesFor((r) => r.capital + r.unsoldInventory * 10 + r.techLevel * 500 + r.capacityLevel * 500);
    const priceData = seriesFor((r) => r.price);
    const mpData = [{ label: 'Market Price', data: history.map((h) => h.marketPrice), borderColor: '#a78bfa', backgroundColor: '#a78bfa', tension: 0.25 }];

    if ($('chart-value')) charts.value = new Chart($('chart-value').getContext('2d'), { type: 'line', data: { labels, datasets: valueData }, options: chartOptions() });
    if ($('chart-price')) charts.price = new Chart($('chart-price').getContext('2d'), { type: 'line', data: { labels, datasets: priceData }, options: chartOptions() });
    if ($('chart-mp')) charts.mp = new Chart($('chart-mp').getContext('2d'), { type: 'line', data: { labels, datasets: mpData }, options: chartOptions() });
  }

  function downloadMatchCSV() {
    if (!lastHistory || !lastHistory.length) return;
    const rows = [['round', 'marketPrice', 'shockTitle', 'teamName', 'price', 'quantityOffered', 'quantitySold', 'revenue', 'unsoldInventory', 'capital', 'techLevel', 'capacityLevel', 'competitiveScore']];
    lastHistory.forEach((h) => {
      h.results.forEach((r) => {
        rows.push([h.round, h.marketPrice, h.shock ? h.shock.title : '', r.teamName, r.price, r.quantityOffered, r.quantitySold, r.revenue, r.unsoldInventory, r.capital, r.techLevel, r.capacityLevel, r.competitiveScore]);
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
  $('btn-download-csv').addEventListener('click', downloadMatchCSV);

  // ---------- chat (Team channel + All-Teams channel) ----------
  function chatLogEl(channel) {
    return $(channel === 'global' ? 'chat-log-global' : 'chat-log-team');
  }
  function appendChatBubble(msg) {
    const log = chatLogEl(msg.channel);
    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.innerHTML = '<span class="who" style="color:' + colorFor(msg.name) + '">' + escapeHtml(msg.name) + ':</span> ' + escapeHtml(msg.text);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  // Auto-posted "who did what" row (the kill-feed) - always lands in
  // whichever log msg.channel says (in practice always 'global', since
  // that's the one channel every team can see).
  function appendKillfeed(msg) {
    const log = chatLogEl(msg.channel);
    const row = document.createElement('div');
    row.className = 'chat-msg system act-' + (msg.actionType || '');
    const icon = Icons[ACTION_ICON[msg.actionType]] || Icons.trending;
    row.innerHTML = '<span class="act-icon">' + icon + '</span><b>' + escapeHtml(msg.name) + '</b> ' + escapeHtml(msg.text);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  function appendBlockedNotice(reason) {
    // Feedback on a post attempt always lands wherever that device's
    // composer is currently pointed, not necessarily 'global'.
    Sound.error();
    const log = chatLogEl(activeChannel);
    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.style.color = 'var(--red)';
    row.textContent = reason;
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }
  function routeChatMessage(msg) {
    if (msg.kind === 'system') appendKillfeed(msg);
    else appendChatBubble(msg);
  }
  function updateChatComposer() {
    document.querySelectorAll('.channel-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.channel === activeChannel));
    chatLogEl('team').style.display = activeChannel === 'team' ? 'block' : 'none';
    chatLogEl('global').style.display = activeChannel === 'global' ? 'block' : 'none';
    const input = $('chat-input');
    const sendBtn = $('btn-chat-send');
    const hint = $('channel-hint');
    const canPost = activeChannel === 'team' || amILeader;
    input.disabled = !canPost;
    sendBtn.disabled = !canPost;
    input.placeholder = canPost ? 'Talk, threaten, promise, bluff…' : 'Only your team leader can post here';
    if (activeChannel !== 'global') {
      hint.innerHTML = '';
    } else if (amILeader) {
      hint.innerHTML = Icons.crown + '<span>You are the team leader — you can post here for your team.</span>';
    } else if (myLeaderName) {
      hint.innerHTML = Icons.crown + '<span><b style="color:var(--ink);">' + escapeHtml(myLeaderName) + '</b> is your team leader — only they can post here. You can still read along.</span>';
    } else {
      hint.innerHTML = 'Only your team leader can post here. You can still read along.';
    }
  }
  function switchChannel(channel) {
    activeChannel = channel === 'global' ? 'global' : 'team';
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
  $('btn-buy-tech').addEventListener('click', () => {
    Sound.buy();
    Juice.squish($('btn-buy-tech'));
    Juice.burst($('btn-buy-tech'), { color: 'var(--gold)' });
    socket.emit('TEAM_INVEST', { roomCode: myRoomCode, teamId: myTeamId, kind: 'tech' });
  });
  $('btn-buy-cap').addEventListener('click', () => {
    Sound.buy();
    Juice.squish($('btn-buy-cap'));
    Juice.burst($('btn-buy-cap'), { color: 'var(--gold)' });
    socket.emit('TEAM_INVEST', { roomCode: myRoomCode, teamId: myTeamId, kind: 'capacity' });
  });
  $('btn-undo-tech').addEventListener('click', () => {
    Sound.undo();
    Juice.squish($('btn-undo-tech'));
    socket.emit('TEAM_UNDO_INVEST', { roomCode: myRoomCode, teamId: myTeamId, kind: 'tech' });
  });
  $('btn-undo-cap').addEventListener('click', () => {
    Sound.undo();
    Juice.squish($('btn-undo-cap'));
    socket.emit('TEAM_UNDO_INVEST', { roomCode: myRoomCode, teamId: myTeamId, kind: 'capacity' });
  });
  $('in-price').addEventListener('input', sendInputUpdate);
  $('in-qty').addEventListener('input', sendInputUpdate);
  $('btn-lockin').addEventListener('click', () => {
    const price = Number($('in-price').value) || 0;
    const qty = Number($('in-qty').value) || 0;
    let warning = null;
    if (qty === 0 && price === 0) warning = "You're about to lock in with $0 price AND 0 units offered — Apple can't buy anything from you this round.";
    else if (qty === 0) warning = "You're about to lock in with 0 units offered — Apple can't buy anything from you this round.";
    else if (price === 0) warning = "You're about to lock in with a $0 price — Apple would get your chips for free.";
    const doLock = () => {
      Sound.lockIn();
      Juice.squish($('btn-lockin'));
      Juice.burst($('btn-lockin'), { color: 'var(--gold)', count: 10 });
      socket.emit('LOCK_IN', { roomCode: myRoomCode, teamId: myTeamId });
    };
    if (warning) {
      showConfirm('Lock in anyway?', warning, 'Lock In Anyway', doLock);
      return;
    }
    doLock();
  });
  $('btn-chat-send').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  document.querySelectorAll('.channel-tab').forEach((btn) => btn.addEventListener('click', () => {
    Sound.click();
    Juice.squish(btn);
    switchChannel(btn.dataset.channel);
  }));

  socket.on('HISTORY_SYNC', ({ history }) => {
    lastHistory = history || [];
  });
  socket.on('LOBBY_UPDATE', (payload) => {
    if (!myTeamId || !payload.teams.some((t) => t.teamId === myTeamId)) return;
    if (payload.phase === 'lobby') {
      // Fresh join or a "play again" reset - either way the live chart and
      // watchlist sparklines/%-change must not carry over a previous match's data.
      lastHistory = [];
      resetLiveChart();
    }
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
    if (payload && payload.shock) {
      renderShock(payload.shock);
      Sound.shock();
      Juice.shake($('shock-banner'));
    }
  });
  socket.on('TIMER_TICK', ({ timeLeft }) => {
    updateTimer(timeLeft);
    if (lastTeamsSnapshot) sampleChartPoint(lastTeamsSnapshot); // keeps the chart flowing once a second even with no active edits
  });
  socket.on('ROUND_RESULT', (payload) => {
    lastHistory.push(payload); // accumulate live, round by round - see updateLiveChart/changePctFor
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
    chatLogEl('team').innerHTML = '';
    chatLogEl('global').innerHTML = '';
    (payload.team || []).forEach(routeChatMessage);
    (payload.global || []).forEach(routeChatMessage);
  });
  socket.on('ROOM_CLOSED', ({ reason }) => {
    showConfirm('Room closed', reason || 'The host has closed this room.', 'OK', () => {
      forgetSession();
      showStep('roomcode');
      activateScreen('screen-join');
    }, { noCancel: true, neutral: true });
  });
  socket.on('KICKED', ({ reason }) => {
    showConfirm('Removed from room', reason || 'You were removed from this room.', 'OK', () => {
      forgetSession();
      showStep('roomcode');
      activateScreen('screen-join');
    }, { noCancel: true, neutral: true });
  });

  // Tooltips open on hover on desktop; on touch devices, tap to toggle,
  // tap anywhere else to close. Delegated so it also covers the header's
  // Apple-demand tooltip, whose text is rewritten dynamically.
  document.addEventListener('click', (e) => {
    const tip = e.target.closest('.info-tip');
    if (tip) {
      e.stopPropagation();
      document.querySelectorAll('.info-tip.show').forEach((o) => { if (o !== tip) o.classList.remove('show'); });
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

  injectIcons();
  updateSoundToggleIcon();
  updateChatComposer();
  showStep('roomcode');
  tryAutoRejoin();
})();
