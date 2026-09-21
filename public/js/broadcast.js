// broadcast.js
// The read-only "share screen" - joins a room as a spectator (SPECTATE_ROOM,
// see server.js) and renders the same public data every player already sees
// on their own ticker, as one big real-time price chart (same engine as the
// player's own in-game chart) rather than a decorative scene. No controls
// live here on purpose - this is meant to be projected for a whole
// classroom to watch, not operated.
(function () {
  const $ = (id) => document.getElementById(id);
  const TEAM_COLORS = ['#f1f5f9', '#2dd4bf', '#fb923c', '#f472b6', '#84cc16', '#c084fc', '#e879f9', '#94a3b8'];
  const CATEGORY_ICON = { CAPACITY: 'layers', COST: 'dollar', DEMAND: 'package', PRIORITY: 'target', MARKET: 'trending' };
  // Korean market convention (not the US green-up one): red = up, blue = down.
  const COLOR_UP = '#ef4444';
  const COLOR_DOWN = '#3b82f6';

  function colorFor(teamId) {
    let h = 0;
    for (let i = 0; i < teamId.length; i++) h = (h * 31 + teamId.charCodeAt(i)) | 0;
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
    const v = Math.round(n);
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString();
  }

  injectIcons();

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
      activateScreen('bc-main');
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

  // ---------- live price chart (same engine as player.js's in-game chart) ----------
  let chart = null;
  let chartSeries = {};
  let chartStartTime = null;
  let lastTeamsSnapshot = null;
  let lastValidPriceByTeam = {};
  let lastPhase = null;

  function renderChartLegend(teams) {
    $('bc-chart-legend').innerHTML = teams
      .map((t) => '<span class="item"><span class="dot" style="background:' + colorFor(t.teamId) + '"></span>' + escapeHtml(t.teamName) + '</span>')
      .join('');
  }
  function ensureChart() {
    const canvas = $('bc-chart');
    if (!canvas || typeof Chart === 'undefined') return null;
    if (chart) return chart;
    chart = new Chart(canvas.getContext('2d'), {
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
          x: {
            type: 'linear',
            ticks: { color: '#868690', font: { size: 13 }, callback: (v) => Math.floor(v / 60) + ':' + String(Math.floor(v % 60)).padStart(2, '0') },
            grid: { color: '#19191c' }
          },
          y: { ticks: { color: '#868690', font: { size: 13 }, callback: (v) => '$' + v }, grid: { color: '#19191c' } }
        }
      }
    });
    return chart;
  }
  function chartPointRadius(ctx) {
    return ctx.dataIndex === ctx.dataset.data.length - 1 ? 6 : 0;
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
  function drawChart(teams) {
    const c = ensureChart();
    if (!c) return;
    const teamIds = teams.map((t) => t.teamId);
    const existingIds = c.data.datasets.map((d) => d._teamId);
    const rosterChanged = teamIds.length !== existingIds.length || teamIds.some((id, i) => id !== existingIds[i]);
    if (rosterChanged) {
      c.data.datasets = teams.map((t) => ({
        _teamId: t.teamId,
        label: t.teamName,
        data: [],
        borderColor: colorFor(t.teamId),
        backgroundColor: colorFor(t.teamId),
        tension: 0.2,
        borderWidth: 3,
        pointRadius: chartPointRadius,
        pointBackgroundColor: chartPointColor,
        pointBorderColor: chartPointColor,
        spanGaps: true
      }));
      renderChartLegend(teams);
    }
    c.data.datasets.forEach((ds) => {
      ds.data = (chartSeries[ds._teamId] || []).map((p) => ({ x: p.t, y: p.y }));
    });
    c.update('none');
  }
  function sampleChart(teams) {
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
    drawChart(teams);
  }
  function resetChart() {
    chartSeries = {};
    chartStartTime = null;
    lastTeamsSnapshot = null;
    lastValidPriceByTeam = {};
    if (chart) {
      chart.destroy();
      chart = null;
    }
  }

  function updateScene(payload) {
    const teams = payload.teams || [];

    if (payload.phase === 'lobby' && lastPhase !== 'lobby') resetChart();
    lastPhase = payload.phase;
    if (payload.phase === 'round_active') sampleChart(teams);

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

  socket.on('STATE_SYNC', (payload) => {
    if (connected) updateScene(payload);
  });
  socket.on('TIMER_TICK', ({ timeLeft }) => {
    const m = Math.floor(timeLeft / 60),
      s = timeLeft % 60;
    $('bc-timer').textContent = m + ':' + String(s).padStart(2, '0');
    $('bc-timer').classList.toggle('low', timeLeft <= 20);
    if (lastPhase === 'round_active' && lastTeamsSnapshot) sampleChart(lastTeamsSnapshot);
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
