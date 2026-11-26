// analyst.js
// "MSG Analyst" - the in-game assistant. Runs 100% in the browser: no API
// key, no external AI service, nothing leaves the page. It has two halves:
//
//  1. A simulator: a line-for-line port of engine.js's purchase algorithm
//     (price score -> competitive score -> Apple fills the best sellers
//     first). Fed with the live numbers every player can already see, it
//     answers "what if" questions exactly - the same math the server will
//     run when the round closes.
//  2. A knowledge base of the rules, matched by keyword (English + Korean).
//
// Because it only does math on public data plus your own team's numbers,
// it can't hallucinate rules and can't leak a rival's private cash.
(function (global) {
  'use strict';

  // ------------------------------------------------------------------
  // Simulator (mirror of engine.js - keep in sync if formulas change)
  // ------------------------------------------------------------------
  const TECH_MAX = 5, CAP_MAX = 5, INV_VALUE = 10, LEVEL_VALUE = 500, PROD_PER_LEVEL = 50;

  function normalize(w) {
    const p = +w.price || 0, t = +w.tech || 0, c = +w.capacity || 0, s = p + t + c;
    return s > 0 ? { price: p / s, tech: t / s, capacity: c / s } : { price: 0.5, tech: 0.3, capacity: 0.2 };
  }
  function resolve(teams, weights, demandPerTeam) {
    const w = normalize(weights || {});
    const prices = teams.map((t) => t.price);
    const pMax = Math.max.apply(null, prices), pMin = Math.min.apply(null, prices);
    const scored = teams.map((t) => {
      const Qp = pMax === pMin ? 100 : ((pMax - t.price) / (pMax - pMin)) * 100;
      const Qt = (Math.min(t.techLevel, TECH_MAX) / TECH_MAX) * 100;
      const Qc = (Math.min(t.capacityLevel, CAP_MAX) / CAP_MAX) * 100;
      return Object.assign({}, t, { Qp, Qt, Qc, CS: Qp * w.price + Qt * w.tech + Qc * w.capacity });
    });
    scored.sort((a, b) => b.CS - a.CS || (a.lockOrder || 0) - (b.lockOrder || 0));
    let remaining = teams.length * demandPerTeam;
    return scored.map((t, i) => {
      const sold = Math.max(0, Math.min(t.quantity, remaining));
      remaining -= sold;
      return Object.assign({}, t, { rank: i + 1, sold, revenue: sold * t.price });
    });
  }
  function entriesFrom(state, overrides) {
    return state.teams.map((t) => {
      const o = (overrides && overrides[t.teamId]) || {};
      const inv = o.inventory != null ? o.inventory : t.inventory;
      return {
        teamId: t.teamId,
        teamName: t.teamName,
        price: o.price != null ? o.price : t.price,
        quantity: Math.max(0, Math.min(o.quantity != null ? o.quantity : t.quantity, inv)),
        inventory: inv,
        techLevel: o.techLevel != null ? o.techLevel : t.techLevel,
        capacityLevel: o.capacityLevel != null ? o.capacityLevel : t.capacityLevel,
        lockOrder: 0
      };
    });
  }
  function simMine(state, myId, overrides) {
    const res = resolve(entriesFrom(state, overrides), state.weights, state.demandPerTeam);
    return { me: res.find((r) => r.teamId === myId), all: res };
  }

  // ------------------------------------------------------------------
  // Formatting helpers
  // ------------------------------------------------------------------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function money(n) {
    n = Math.round(n || 0);
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString();
  }
  function signed(n, fmt) {
    const f = fmt || ((x) => Math.abs(Math.round(x)).toLocaleString());
    if (Math.round(n) === 0) return '±0';
    return (n > 0 ? '+' : '-') + f(n);
  }
  function signedMoney(n) {
    if (Math.round(n) === 0) return '±$0';
    return (n > 0 ? '+$' : '-$') + Math.abs(Math.round(n)).toLocaleString();
  }
  const hasHangul = (s) => /[ㄱ-힝]/.test(s || '');

  // ------------------------------------------------------------------
  // Knowledge base (rules). Each entry: keywords (en + ko), answer (en, ko)
  // ------------------------------------------------------------------
  const KB = [
    {
      id: 'goal',
      keys: ['win', 'goal', 'objective', 'company value', 'winner', '이기', '승리', '목표', '기업가치', '회사가치', '우승'],
      en: '<p>The team with the highest <b>Company Value</b> after round 6 wins.</p><p>Company Value = cash + unsold chips × $10 + Tech level × $500 + Capacity level × $500.</p><p>So an upgrade only keeps $500 of its price on your books - it has to earn the rest back through sales.</p>',
      ko: '<p>6라운드가 끝났을 때 <b>Company Value(기업가치)</b>가 가장 높은 팀이 이깁니다.</p><p>Company Value = 현금 + 남은 칩 × $10 + Tech 레벨 × $500 + Capacity 레벨 × $500</p><p>즉 업그레이드는 가격 중 $500만 자산으로 남고, 나머지는 판매로 회수해야 합니다.</p>'
    },
    {
      id: 'score',
      keys: ['score', 'competitive', 'rank', 'ranking', 'how does apple', 'apple choose', 'apple pick', 'algorithm', '점수', '순위', '랭킹', '애플이', '알고리즘', '어떻게 고르'],
      en: '<p>Apple ranks every team by <b>Competitive Score</b> and buys from the top down until its demand runs out.</p><ul><li><b>Price score</b>: cheapest team = 100, most expensive = 0, others in between.</li><li><b>Tech score</b> = Tech level × 20.</li><li><b>Capacity score</b> = Capacity level × 20.</li></ul><p>Score = Price × weight + Tech × weight + Capacity × weight. Ask me "weights" to see this round\'s numbers.</p>',
      ko: '<p>애플은 모든 팀을 <b>Competitive Score</b> 순으로 줄 세우고, 수요가 바닥날 때까지 1등부터 삽니다.</p><ul><li><b>가격 점수</b>: 제일 싼 팀 100, 제일 비싼 팀 0, 나머지는 그 사이.</li><li><b>Tech 점수</b> = Tech 레벨 × 20</li><li><b>Capacity 점수</b> = Capacity 레벨 × 20</li></ul><p>총점 = 가격×가중치 + Tech×가중치 + Capacity×가중치. "가중치"라고 물어보면 이번 라운드 숫자를 알려드릴게요.</p>'
    },
    {
      id: 'tech_rule',
      keys: ['what is tech', 'tech do', 'technology', 'tech level', '테크', '기술'],
      en: '<p><b>Tech</b> raises your score immediately - it helps this round. Each level adds 20 to your Tech score (max level 5). Each upgrade costs 1.5× the previous one.</p>',
      ko: '<p><b>Tech</b>는 점수를 즉시 올려줍니다 - 이번 라운드부터 효과. 레벨당 Tech 점수 +20 (최대 5레벨). 업그레이드할 때마다 비용이 1.5배씩 오릅니다.</p>'
    },
    {
      id: 'cap_rule',
      keys: ['what is capacity', 'capacity do', 'production', 'produce', 'how many chips', '캐파', '생산', '용량'],
      en: '<p><b>Capacity</b> does two things: it adds 20 to your Capacity score right away, and from <b>next round</b> on you produce 50 more chips per round per level (base production is 100).</p>',
      ko: '<p><b>Capacity</b>는 두 가지 효과: Capacity 점수 +20(즉시), 그리고 <b>다음 라운드부터</b> 레벨당 라운드마다 칩 50개 추가 생산 (기본 생산량 100).</p>'
    },
    {
      id: 'demand_rule',
      keys: ['demand', 'how much apple', 'apple buy', 'pool', '수요', '애플 수요', '얼마나 사'],
      en: '<p>Apple\'s total demand = demand per team × number of teams. It\'s one shared pool, not a quota per team - the best-scoring sellers fill it first, and whoever is last can sell nothing.</p>',
      ko: '<p>애플 총수요 = 팀당 수요 × 팀 수. 팀별 할당이 아니라 하나의 공동 풀이에요. 점수 높은 팀부터 채워가고, 꼴찌는 하나도 못 팔 수 있습니다.</p>'
    },
    {
      id: 'lock',
      keys: ['lock', 'lock in', 'timer', 'time runs out', 'timeout', '락', '확정', '시간 끝', '타이머'],
      en: '<p><b>Lock In</b> makes your price, quantity and upgrades final for the round. The round ends early once every team has locked. If the timer runs out first, an unlocked team keeps whatever is currently in its boxes.</p><p>Ties in score go to whoever locked in earlier.</p>',
      ko: '<p><b>Lock In</b>을 누르면 이번 라운드의 가격·수량·업그레이드가 확정됩니다. 모든 팀이 락인하면 라운드가 바로 끝나요. 타이머가 먼저 끝나면 락인 안 한 팀은 지금 입력돼 있는 값 그대로 제출됩니다.</p><p>점수가 같으면 먼저 락인한 팀이 우선입니다.</p>'
    },
    {
      id: 'undo',
      keys: ['undo', 'cancel upgrade', 'refund', '취소', '환불', '되돌'],
      en: '<p>You can undo any Tech/Capacity purchase made <b>this round</b>, for a full refund, until you lock in. Purchases from earlier rounds are permanent.</p>',
      ko: '<p><b>이번 라운드</b>에 산 Tech/Capacity는 락인 전까지 전액 환불로 취소할 수 있어요. 이전 라운드 구매는 취소 불가.</p>'
    },
    {
      id: 'cap',
      keys: ['price cap', 'max price', 'ceiling', 'maximum price', '가격 상한', '최대 가격', '상한'],
      en: '<p>Prices are capped at <b>3× the last Market Price</b> ($150 in round 1). High-margin pricing is allowed - absurd numbers are not.</p>',
      ko: '<p>가격은 <b>직전 Market Price의 3배</b>까지만 가능해요 (1라운드는 $150). 고마진 전략은 되지만 터무니없는 가격은 막혀 있습니다.</p>'
    },
    {
      id: 'mp',
      keys: ['market price', '시장가', '마켓 프라이스'],
      en: '<p><b>Market Price</b> is the average price Apple actually paid last round, weighted by units sold. It sets next round\'s price cap.</p>',
      ko: '<p><b>Market Price</b>는 지난 라운드에 애플이 실제로 지불한 평균 가격(판매량 가중)입니다. 다음 라운드 가격 상한의 기준이 돼요.</p>'
    },
    {
      id: 'unsold',
      keys: ['unsold', 'leftover', 'inventory', 'carry over', '재고', '남은', '안 팔'],
      en: '<p>Unsold chips stay in your inventory and can be offered again next round. At the end each leftover chip is worth $10.</p>',
      ko: '<p>안 팔린 칩은 재고로 남아 다음 라운드에 다시 팔 수 있어요. 게임 종료 시 남은 칩은 개당 $10로 계산됩니다.</p>'
    },
    {
      id: 'debt',
      keys: ['debt', 'negative', 'broke', 'no money', '빚', '마이너스', '돈이 없'],
      en: '<p>Going into debt is allowed - you can upgrade even with negative cash. Debt simply counts against your Company Value at the end.</p>',
      ko: '<p>빚은 허용돼요 - 현금이 마이너스여도 업그레이드 가능. 대신 최종 Company Value에서 그만큼 깎입니다.</p>'
    },
    {
      id: 'shock_rule',
      keys: ['shock', 'event', 'news', '쇼크', '이벤트', '뉴스'],
      en: '<p>Every round has one <b>Market Shock</b> that bends the rules for that round only - fewer chips get made, Apple cares more about Tech, upgrades get pricier, and so on. Ask me "this shock" to see what it means for you right now.</p>',
      ko: '<p>매 라운드 <b>Market Shock</b>이 하나씩 터져서 그 라운드에만 규칙이 바뀌어요 - 생산량 감소, 애플이 Tech를 더 중시, 업그레이드 가격 상승 등. "이번 쇼크"라고 물어보면 지금 우리 팀에 어떤 의미인지 알려드릴게요.</p>'
    },
    {
      id: 'team_rule',
      keys: ['leader', 'teammate', 'all teams channel', 'chat', '리더', '팀원', '채팅', '전체 채널'],
      en: '<p>Up to 4 people share one company - anyone can change numbers, invest, or lock in. The Team channel is private. In All Teams only your team\'s leader (the earliest connected member) can post; everyone can read.</p>',
      ko: '<p>한 회사를 최대 4명이 공동 운영해요 - 누구든 숫자 변경·투자·락인 가능. Team 채널은 우리 팀 전용이고, All Teams 채널은 팀 리더(가장 먼저 접속한 사람)만 글을 쓸 수 있고 모두 읽을 수 있습니다.</p>'
    },
    {
      id: 'contrib_rule',
      keys: ['contribution', 'points', 'mvp', 'who did', '기여', '포인트', '공헌'],
      en: '<p><b>Contribution</b> credits the person who actually made each decision:</p><ul><li>Your price was the one locked in: 3 pts (quantity: 2)</li><li>Each upgrade you bought (not undone): 4 pts</li><li>Pressing Lock In: 3 pts</li><li>Editing numbers: 0.1 each, max 2 per round</li><li>Chat: 0.5 team / 1 all-teams, max 3 per round</li></ul>',
      ko: '<p><b>기여도</b>는 실제로 결정을 내린 사람에게 점수를 줍니다:</p><ul><li>내가 입력한 가격이 최종 확정: 3점 (수량은 2점)</li><li>내가 산 업그레이드(취소 안 된 것): 개당 4점</li><li>Lock In 누르기: 3점</li><li>숫자 수정: 회당 0.1점, 라운드당 최대 2점</li><li>채팅: 팀 0.5 / 전체 1점, 라운드당 최대 3점</li></ul>'
    }
  ];

  // ------------------------------------------------------------------
  // Analyst factory
  // ------------------------------------------------------------------
  function mount(opts) {
    const mode = opts.mode || 'player';
    const getState = opts.getState; // () => latest STATE_SYNC payload (+ myTeamId, timeLeft, history)
    let lastLang = 'en';
    let greetedRound = null;
    let alertedRound = null;

    const fab = document.createElement('button');
    fab.className = 'analyst-fab';
    fab.type = 'button';
    fab.innerHTML = '<span class="orb">' + Icons.spark + '</span>Analyst<span class="ping"></span>';
    fab.setAttribute('aria-label', 'Open the MSG Analyst');
    const panel = document.createElement('div');
    panel.className = 'analyst-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'MSG Analyst');
    panel.innerHTML =
      '<div class="analyst-head"><span class="orb">' + Icons.spark + '</span><div><div class="t">MSG Analyst</div><div class="s">' +
      (mode === 'host' ? 'Runs in this browser. Sees what you see.' : 'Runs in this browser. Uses only what your team can see.') +
      '</div></div><button class="btn btn-ghost btn-sm close" type="button" aria-label="Close">' + Icons.close + '</button></div>' +
      '<div class="analyst-log" aria-live="polite"></div><div class="a-chips"></div>' +
      '<form class="a-input"><input type="text" maxlength="200" placeholder="' + (mode === 'host' ? 'Ask about the match or settings' : 'Ask anything, e.g. best price?') + '" aria-label="Ask the analyst"><button class="btn btn-primary btn-sm" type="submit">Ask</button></form>';
    document.body.appendChild(fab);
    document.body.appendChild(panel);
    const log = panel.querySelector('.analyst-log');
    const chips = panel.querySelector('.a-chips');
    const input = panel.querySelector('input');

    const CHIPS = mode === 'host'
      ? [['Match status', 'status'], ['Supply vs demand', 'supply'], ['This shock', 'shock'], ['Pacing tips', 'pacing'], ['Top contributors', 'contributors'], ['Settings guide', 'settings']]
      : [['Brief me', 'brief'], ['Best price', 'price'], ['Buy Tech?', 'tech'], ['Buy Capacity?', 'capacity'], ['Rivals', 'rivals'], ['This shock', 'shock']];
    chips.innerHTML = CHIPS.map((c) => '<button type="button" class="a-chip" data-q="' + c[1] + '">' + c[0] + '</button>').join('');
    chips.querySelectorAll('.a-chip').forEach((b) =>
      b.addEventListener('click', () => {
        ask(b.textContent, b.dataset.q);
      })
    );

    function open() {
      panel.classList.add('open');
      fab.style.display = 'none';
      fab.classList.remove('has-alert');
      const st = getState();
      if (!log.childElementCount) {
        say(intro(st));
      } else if (st && st.phase === 'round_active' && greetedRound !== st.round && mode === 'player') {
        greetedRound = st.round;
        say(brief(st, lastLang));
      }
      setTimeout(() => input.focus(), 50);
    }
    function close() {
      panel.classList.remove('open');
      fab.style.display = '';
    }
    fab.addEventListener('click', open);
    panel.querySelector('.close').addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.classList.contains('open')) close();
    });
    panel.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      ask(q, null);
    });

    function add(html, who) {
      const div = document.createElement('div');
      div.className = 'a-msg ' + who;
      div.innerHTML = html;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
      return div;
    }
    function say(html) {
      const typing = add('<span class="a-typing"><i></i><i></i><i></i></span>', 'bot');
      setTimeout(() => {
        typing.innerHTML = html;
        log.scrollTop = log.scrollHeight;
      }, 320);
    }
    function ask(text, intent) {
      add(esc(text), 'me');
      const lang = intent ? lastLang : hasHangul(text) ? 'ko' : 'en';
      lastLang = lang;
      const st = getState();
      say(answer(intent || classify(text), text, st, lang));
    }

    // ---------------- intent classification ----------------
    function classify(q) {
      const s = q.toLowerCase();
      const has = (...words) => words.some((w) => s.includes(w));
      if (mode === 'host') {
        if (has('status', "who hasn't", 'who has not', 'not locked', 'lock', '누가', '상태', '락')) return 'status';
        if (has('supply', 'demand', 'oversupp', '공급', '수요')) return 'supply';
        if (has('shock', 'event', '쇼크', '이벤트')) return 'shock';
        if (has('pace', 'pacing', 'skip', 'pause', 'timer', '진행', '타이머', '스킵')) return 'pacing';
        if (has('contrib', 'mvp', 'grade', '기여', '평가')) return 'contributors';
        if (has('setting', 'weight', 'volatil', 'inflation', 'config', '설정', '가중치', '변동성', '인플레')) return 'settings';
        if (has('bot', '봇')) return 'bots';
        if (has('broadcast', 'projector', 'share screen', '프로젝터', '공유 화면', '방송')) return 'broadcast';
      } else {
        if (has('brief', 'what should', 'advice', 'recommend', 'help me', 'strategy', '추천', '뭐 해', '뭘 해', '어떻게 해', '전략', '조언', '브리핑')) return 'brief';
        if (has('best price', 'what price', 'optimal', 'price should', 'how much should', 'pricing', '최적', '가격 얼마', '얼마에', '가격 추천', '가격을')) return 'price';
        if (has('buy tech', 'upgrade tech', 'tech worth', 'tech?', '테크 사', '기술 사', '테크 업', '기술 업')) return 'tech';
        if (has('buy capacity', 'upgrade capacity', 'capacity worth', 'capacity?', '캐파 사', '캐파 업', '용량 사', '생산 늘')) return 'capacity';
        if (has('rival', 'competitor', 'threat', 'other team', 'opponent', '경쟁', '라이벌', '상대', '다른 팀')) return 'rivals';
        if (has('this shock', 'current shock', 'shock mean', '이번 쇼크', '지금 쇼크', '쇼크 의미')) return 'shock';
        if (has('weight', '가중치')) return 'weights';
        if (has('my rank', 'where am i', 'predicted', '내 순위', '몇 등', '예상')) return 'rank';
        if (has('supply', 'oversupp', '공급')) return 'supply';
      }
      // rules
      let best = null, bestHits = 0;
      KB.forEach((k) => {
        const hits = k.keys.filter((w) => s.includes(w)).length;
        if (hits > bestHits) {
          best = k;
          bestHits = hits;
        }
      });
      if (best) return 'kb:' + best.id;
      if (mode === 'player' && has('tech', '테크')) return 'tech';
      if (mode === 'player' && has('capacity', '캐파')) return 'capacity';
      if (mode === 'player' && has('price', '가격')) return 'price';
      if (has('shock', '쇼크')) return 'shock';
      return 'fallback';
    }

    function answer(intent, raw, st, lang) {
      const ko = lang === 'ko';
      try {
        if (intent.startsWith('kb:')) {
          const k = KB.find((x) => x.id === intent.slice(3));
          return ko ? k.ko : k.en;
        }
        if (mode === 'host') return hostAnswer(intent, st, ko);
        return playerAnswer(intent, st, ko);
      } catch (err) {
        return ko ? '<p>지금 상태에서는 계산할 수 없어요. 라운드가 진행 중일 때 다시 물어봐 주세요.</p>' : '<p>I can\'t compute that from the current state. Try again while a round is running.</p>';
      }
    }

    function intro(st) {
      if (mode === 'host') {
        return '<p>I\'m the MSG Analyst. I run entirely in this browser and read the same live data as your dashboard.</p><p>Ask about who still needs to lock in, whether the market is oversupplied, what a setting does, or who\'s carrying each team.</p>';
      }
      const live = st && st.phase === 'round_active';
      if (live) greetedRound = st.round;
      return (
        '<p>I\'m the MSG Analyst. I run entirely in this browser and only use numbers your team can already see. I simulate Apple\'s purchase with the exact game formula, so my "what if" numbers match what the server will do - as long as rivals don\'t change theirs.</p>' +
        (live ? brief(st, lastLang) : '<p>Once a round starts, tap <b>Brief me</b>. You can ask in English or 한국어.</p>')
      );
    }

    // ---------------- player answers ----------------
    function needLive(st, ko) {
      if (!st || st.phase !== 'round_active' || !st.teams) return ko ? '<p>라운드가 진행 중일 때만 분석할 수 있어요.</p>' : '<p>I can only run this while a round is live.</p>';
      const me = st.teams.find((t) => t.teamId === st.myTeamId);
      if (!me) return ko ? '<p>팀 정보를 아직 못 받았어요.</p>' : '<p>I haven\'t received your team\'s data yet.</p>';
      return null;
    }
    function myTeam(st) {
      return st.teams.find((t) => t.teamId === st.myTeamId);
    }

    function priceScan(st) {
      const me = myTeam(st);
      const maxP = st.maxPrice || 150;
      const cands = new Set();
      const step = Math.max(1, Math.round(maxP / 80));
      for (let p = 1; p <= maxP; p += step) cands.add(p);
      cands.add(maxP);
      st.teams.forEach((t) => {
        if (t.teamId === me.teamId) return;
        [t.price - 1, t.price, t.price + 1].forEach((p) => {
          if (p >= 1 && p <= maxP) cands.add(p);
        });
      });
      cands.add(me.price);
      const rows = [];
      cands.forEach((p) => {
        const r = simMine(st, me.teamId, { [me.teamId]: { price: p } }).me;
        rows.push({ price: p, sold: r.sold, revenue: r.revenue, rank: r.rank });
      });
      rows.sort((a, b) => a.price - b.price);
      const best = rows.reduce((a, b) => (b.revenue > a.revenue || (b.revenue === a.revenue && b.price > a.price) ? b : a), rows[0]);
      const offered = Math.max(0, Math.min(me.quantity, me.inventory));
      const sellOut = rows.filter((r) => offered > 0 && r.sold >= offered).reduce((a, b) => (!a || b.price > a.price ? b : a), null);
      const current = rows.find((r) => r.price === me.price) || simMine(st, me.teamId).me;
      return { rows, best, sellOut, current, offered };
    }

    function brief(st, lang) {
      const ko = lang === 'ko';
      const nl = needLive(st, ko);
      if (nl) return nl;
      const me = myTeam(st);
      const base = simMine(st, me.teamId).me;
      const scan = priceScan(st);
      const parts = [];
      const left = st.timeLeft != null ? st.timeLeft : null;
      if (ko) {
        parts.push('<p><b>R' + st.round + ' 브리핑</b> - 지금 숫자 그대로면 <b>' + base.rank + '등/' + st.teams.length + '</b>, ' + base.sold + '/' + scan.offered + '개 판매, 매출 ' + money(base.revenue) + '.</p>');
      } else {
        parts.push('<p><b>Round ' + st.round + ' brief</b> - on the numbers showing right now you finish <b>#' + base.rank + ' of ' + st.teams.length + '</b>, selling ' + base.sold + ' of ' + scan.offered + ' for ' + money(base.revenue) + '.</p>');
      }
      const tips = [];
      if (scan.best && scan.best.revenue > base.revenue + 1) {
        tips.push(ko ? '가격을 <b>$' + scan.best.price + '</b>로 바꾸면 매출 ' + money(scan.best.revenue) + ' (' + signedMoney(scan.best.revenue - base.revenue) + ')' : 'Price <b>$' + scan.best.price + '</b> earns ' + money(scan.best.revenue) + ' (' + signedMoney(scan.best.revenue - base.revenue) + ')');
      } else {
        tips.push(ko ? '현재 가격 $' + me.price + '이 지금 상황에선 매출 최대치에 가까워요.' : 'Your $' + me.price + ' is already at or near the revenue-maximising price.');
      }
      if (scan.offered < me.inventory) {
        tips.push(ko ? '재고 ' + me.inventory + '개 중 ' + scan.offered + '개만 내놨어요.' : 'You\'re offering ' + scan.offered + ' of ' + me.inventory + ' chips in stock.');
      }
      const ev = upgradeEval(st, 'tech');
      if (ev && ev.deltaRevenue > 0) tips.push(ko ? 'Tech 업그레이드 시 이번 라운드 매출 ' + signedMoney(ev.deltaRevenue) + ' (비용 ' + money(ev.cost) + ')' : 'Buying Tech now adds ' + signedMoney(ev.deltaRevenue) + ' revenue this round (costs ' + money(ev.cost) + ')');
      const supply = st.teams.reduce((s, t) => s + Math.max(0, Math.min(t.quantity, t.inventory)), 0);
      const total = st.totalDemand || st.demandPerTeam * st.teams.length;
      if (supply > total) tips.push(ko ? '시장 공급과잉: 공급 ' + supply + ' vs 수요 ' + total + ' - 하위 팀은 못 팔아요.' : 'Market is oversupplied: ' + supply + ' offered vs ' + total + ' demanded - the bottom teams sell nothing.');
      if (!me.locked && left != null && left <= 30) tips.push(ko ? '<span class="up">' + left + '초 남음 - 락인하세요.</span>' : '<span class="up">' + left + 's left - lock in.</span>');
      if (me.locked) tips.push(ko ? '이미 락인했어요. 이제 바꿀 수 없어요.' : 'You\'re locked in - nothing more to change this round.');
      parts.push('<ul>' + tips.map((t) => '<li>' + t + '</li>').join('') + '</ul>');
      parts.push('<p class="muted">' + (ko ? '경쟁팀이 숫자를 바꾸면 결과도 바뀌어요.' : 'These numbers move whenever a rival changes theirs.') + '</p>');
      return parts.join('');
    }

    function upgradeEval(st, kind) {
      const me = myTeam(st);
      const lvl = kind === 'tech' ? me.techLevel : me.capacityLevel;
      const max = kind === 'tech' ? TECH_MAX : CAP_MAX;
      const cost = kind === 'tech' ? me.nextTechCost : me.nextCapacityCost;
      if (lvl >= max || cost == null) return { maxed: true };
      const before = simMine(st, me.teamId).me;
      const ov = {};
      ov[me.teamId] = kind === 'tech' ? { techLevel: lvl + 1 } : { capacityLevel: lvl + 1 };
      const after = simMine(st, me.teamId, ov).me;
      const deltaRevenue = after.revenue - before.revenue;
      const deltaSold = after.sold - before.sold;
      // Company Value effect this round: cash -cost, asset +500, revenue
      // change, minus the $10 book value of the extra chips that sold.
      const valueNow = -cost + LEVEL_VALUE + deltaRevenue - deltaSold * INV_VALUE;
      const roundsLeft = Math.max(0, (st.totalRounds || 6) - st.round);
      return { cost, before, after, deltaRevenue, deltaSold, valueNow, roundsLeft, lvl };
    }

    function upgradeAnswer(st, kind, ko) {
      const nl = needLive(st, ko);
      if (nl) return nl;
      const me = myTeam(st);
      const ev = upgradeEval(st, kind);
      const label = kind === 'tech' ? 'Tech' : 'Capacity';
      if (ev.maxed) return ko ? '<p>' + label + '는 이미 최대 레벨이에요.</p>' : '<p>' + label + ' is already maxed.</p>';
      if (me.locked) return ko ? '<p>이미 락인해서 이번 라운드엔 살 수 없어요.</p>' : '<p>You\'re locked in, so you can\'t buy this round.</p>';
      const out = [];
      if (ko) {
        out.push('<p><b>' + label + ' Lv' + (ev.lvl + 1) + '</b> 비용 ' + money(ev.cost) + '. 이번 라운드: 순위 ' + ev.before.rank + '→' + ev.after.rank + '등, 판매 ' + ev.before.sold + '→' + ev.after.sold + '개, 매출 ' + signedMoney(ev.deltaRevenue) + '.</p>');
        out.push('<p>이번 라운드 기업가치 영향: <b class="' + (ev.valueNow >= 0 ? 'good' : 'up') + '">' + signedMoney(ev.valueNow) + '</b> (현금 -' + money(ev.cost).replace('$', '$') + ', 자산 +$500).</p>');
      } else {
        out.push('<p><b>' + label + ' Lv' + (ev.lvl + 1) + '</b> costs ' + money(ev.cost) + '. This round: rank #' + ev.before.rank + ' → #' + ev.after.rank + ', sold ' + ev.before.sold + ' → ' + ev.after.sold + ', revenue ' + signedMoney(ev.deltaRevenue) + '.</p>');
        out.push('<p>Effect on Company Value this round: <b class="' + (ev.valueNow >= 0 ? 'good' : 'up') + '">' + signedMoney(ev.valueNow) + '</b> (cash -' + money(ev.cost) + ', +$500 on the books).</p>');
      }
      if (kind === 'capacity' && ev.roundsLeft > 0) {
        const extra = PROD_PER_LEVEL * ev.roundsLeft;
        out.push(ko ? '<p>추가로 남은 ' + ev.roundsLeft + '라운드 동안 칩 ' + extra + '개 더 생산 - 팔 수 있을 때만 가치가 있어요 (못 팔면 개당 $10).</p>' : '<p>Plus ' + extra + ' more chips over the ' + ev.roundsLeft + ' remaining round' + (ev.roundsLeft > 1 ? 's' : '') + ' - only worth it if you can sell them (unsold chips count $10 each).</p>');
      }
      if (kind === 'tech' && ev.roundsLeft > 0 && ev.deltaRevenue > 0) {
        out.push(ko ? '<p>Tech는 남은 ' + ev.roundsLeft + '라운드에도 계속 점수를 올려줘요. 비슷한 상황이 반복되면 대략 ' + money(ev.deltaRevenue * (ev.roundsLeft + 1)) + ' 매출 증가.</p>' : '<p>Tech keeps boosting your score in the ' + ev.roundsLeft + ' rounds after this. If conditions stay similar that\'s roughly ' + money(ev.deltaRevenue * (ev.roundsLeft + 1)) + ' more revenue in total.</p>');
      }
      if (ev.deltaRevenue <= 0) {
        out.push(ko ? '<p class="muted">지금 상황에선 이번 라운드 판매가 늘지 않아요 - 이미 다 팔고 있거나, 점수 차이가 커서 순위가 안 바뀝니다.</p>' : '<p class="muted">It doesn\'t change this round\'s sales - either you already sell out, or the score gap is too big for one level to move you.</p>');
      }
      return out.join('');
    }

    function playerAnswer(intent, st, ko) {
      if (intent === 'brief') return brief(st, ko ? 'ko' : 'en');
      if (intent === 'tech' || intent === 'capacity') return upgradeAnswer(st, intent, ko);
      if (intent === 'price') {
        const nl = needLive(st, ko);
        if (nl) return nl;
        const scan = priceScan(st);
        const me = myTeam(st);
        // a small table around the interesting points
        const picks = new Map();
        [scan.best, scan.sellOut, scan.current].forEach((r) => r && picks.set(r.price, r));
        const sortedRev = scan.rows.slice().sort((a, b) => b.revenue - a.revenue);
        for (let i = 0; picks.size < 6 && i < sortedRev.length; i++) picks.set(sortedRev[i].price, sortedRev[i]);
        const rows = Array.from(picks.values()).sort((a, b) => a.price - b.price);
        const table =
          '<table class="a-table"><tr><th>' + (ko ? '가격' : 'Price') + '</th><th>' + (ko ? '순위' : 'Rank') + '</th><th>' + (ko ? '판매' : 'Sold') + '</th><th>' + (ko ? '매출' : 'Revenue') + '</th></tr>' +
          rows.map((r) => '<tr' + (r === scan.best ? ' class="best"' : '') + '><td>$' + r.price + (r.price === me.price ? (ko ? ' (현재)' : ' (now)') : '') + '</td><td>#' + r.rank + '</td><td>' + r.sold + '</td><td>' + money(r.revenue) + '</td></tr>').join('') +
          '</table>';
        const head = ko
          ? '<p>경쟁팀 숫자를 고정하고 $1~$' + st.maxPrice + ' 가격을 시뮬레이션했어요. 매출 최대: <b>$' + scan.best.price + '</b> (' + scan.best.sold + '개, ' + money(scan.best.revenue) + ').' + (scan.sellOut ? ' 내놓은 ' + scan.offered + '개를 전부 파는 최고가: <b>$' + scan.sellOut.price + '</b>.' : '') + '</p>'
          : '<p>I held every rival\'s numbers fixed and simulated prices from $1 to $' + st.maxPrice + '. Revenue peaks at <b>$' + scan.best.price + '</b> (' + scan.best.sold + ' sold, ' + money(scan.best.revenue) + ').' + (scan.sellOut ? ' Highest price that still sells all ' + scan.offered + ' you offered: <b>$' + scan.sellOut.price + '</b>.' : '') + '</p>';
        let risk = '';
        if (scan.best.rank === st.teams.length && scan.best.sold > 0) {
          risk = ko
            ? '<p><span class="up">주의:</span> 이 가격이면 꼴찌인데도 팔리는 건 지금 공급이 수요보다 적기 때문이에요. 경쟁팀이 수량을 늘리거나 가격을 내리면 한 개도 못 팔 수 있어요.' + (scan.sellOut ? ' 안전하게 가려면 $' + scan.sellOut.price + '.' : '') + '</p>'
            : '<p><span class="up">Careful:</span> at that price you rank last and only sell because total supply is currently below demand. If a rival raises quantity or undercuts you, you could sell nothing.' + (scan.sellOut ? ' The safer pick is $' + scan.sellOut.price + '.' : '') + '</p>';
        }
        const note = risk + (ko ? '<p class="muted">이번 라운드 매출 기준이에요. 안 팔린 칩은 다음 라운드로 넘어가요.</p>' : '<p class="muted">This optimises this round\'s revenue only - unsold chips carry over to the next round.</p>');
        return head + table + note;
      }
      if (intent === 'rank') {
        const nl = needLive(st, ko);
        if (nl) return nl;
        const r = simMine(st, st.myTeamId).me;
        return ko ? '<p>지금 숫자 기준 예상 순위 <b>' + r.rank + '등</b>, 점수 ' + r.CS.toFixed(1) + ', ' + r.sold + '개 판매 예상.</p>' : '<p>Right now you\'d finish <b>#' + r.rank + '</b> with a score of ' + r.CS.toFixed(1) + ', selling ' + r.sold + '.</p>';
      }
      if (intent === 'rivals') {
        const nl = needLive(st, ko);
        if (nl) return nl;
        const res = simMine(st, st.myTeamId).all;
        const rows = res
          .map((r) => {
            const t = st.teams.find((x) => x.teamId === r.teamId);
            const mine = r.teamId === st.myTeamId;
            return '<tr' + (mine ? ' class="best"' : '') + '><td>#' + r.rank + ' ' + esc(r.teamName) + '</td><td>$' + r.price + '</td><td>T' + r.techLevel + ' C' + r.capacityLevel + '</td><td>' + r.CS.toFixed(0) + '</td><td>' + (t && t.locked ? Icons.lock : '') + '</td></tr>';
          })
          .join('');
        const myIdx = res.findIndex((r) => r.teamId === st.myTeamId);
        const above = myIdx > 0 ? res[myIdx - 1] : null;
        const gap = above ? above.CS - res[myIdx].CS : 0;
        let note = '';
        if (above) {
          const w = normalize(st.weights);
          note = ko
            ? '<p>바로 위 <b>' + esc(above.teamName) + '</b>와 점수 차 ' + gap.toFixed(1) + '점. Tech 1레벨은 ' + (20 * w.tech).toFixed(1) + '점, Capacity 1레벨은 ' + (20 * w.capacity).toFixed(1) + '점이에요.</p>'
            : '<p>You trail <b>' + esc(above.teamName) + '</b> by ' + gap.toFixed(1) + ' points. One Tech level is worth ' + (20 * w.tech).toFixed(1) + ', one Capacity level ' + (20 * w.capacity).toFixed(1) + '.</p>';
        } else {
          note = ko ? '<p>지금 1등이에요. 다른 팀이 가격을 내리는지 주시하세요.</p>' : '<p>You\'re on top. Watch for anyone undercutting your price.</p>';
        }
        return '<table class="a-table"><tr><th>' + (ko ? '팀' : 'Team') + '</th><th>' + (ko ? '가격' : 'Price') + '</th><th>Lv</th><th>' + (ko ? '점수' : 'Score') + '</th><th></th></tr>' + rows + '</table>' + note;
      }
      if (intent === 'shock') return shockAnswer(st, ko);
      if (intent === 'weights') {
        if (!st || !st.weights) return ko ? '<p>라운드 중에 다시 물어봐 주세요.</p>' : '<p>Ask again during a round.</p>';
        const w = normalize(st.weights);
        return ko
          ? '<p>이번 라운드 가중치(쇼크 반영): 가격 <b>' + Math.round(w.price * 100) + '%</b>, Tech <b>' + Math.round(w.tech * 100) + '%</b>, Capacity <b>' + Math.round(w.capacity * 100) + '%</b>.</p><p>제일 싼 팀이 되면 ' + (100 * w.price).toFixed(0) + '점, Tech 1레벨 = ' + (20 * w.tech).toFixed(1) + '점.</p>'
          : '<p>This round\'s weights (shock included): Price <b>' + Math.round(w.price * 100) + '%</b>, Tech <b>' + Math.round(w.tech * 100) + '%</b>, Capacity <b>' + Math.round(w.capacity * 100) + '%</b>.</p><p>Being the cheapest is worth ' + (100 * w.price).toFixed(0) + ' points; one Tech level is worth ' + (20 * w.tech).toFixed(1) + '.</p>';
      }
      if (intent === 'supply') return supplyAnswer(st, ko);
      return fallback(ko);
    }

    function shockAnswer(st, ko) {
      if (!st || !st.shock) return ko ? '<p>아직 이번 라운드 쇼크가 없어요.</p>' : '<p>No shock is active yet.</p>';
      const s = st.shock;
      const imp = s.impact || '';
      let angle = '';
      const tag = s.categoryTag;
      const angles = {
        CAPACITY: ['Production is hit this round - stock is tighter for everyone, so a higher price may still sell.', '이번 라운드 생산량이 바뀌었어요 - 공급이 줄면 높은 가격도 팔릴 수 있어요.'],
        COST: ['Upgrade prices moved - if an upgrade got cheaper, this is the round to buy it; if pricier, wait.', '업그레이드 가격이 바뀌었어요 - 싸졌으면 이번이 기회, 비싸졌으면 다음으로 미루세요.'],
        DEMAND: ['Apple\'s order size changed - check Supply vs demand before setting quantity.', '애플 주문량이 바뀌었어요 - 수량 정하기 전에 공급 vs 수요를 확인하세요.'],
        PRIORITY: ['Apple is weighing price, Tech and Capacity differently this round - ask me "weights" for the exact split.', '이번 라운드는 애플의 평가 비중이 달라요 - "가중치"라고 물어보면 정확한 비율을 알려드려요.'],
        MARKET: ['Standard rules this round.', '이번 라운드는 기본 규칙 그대로예요.']
      };
      const a = angles[tag] || angles.MARKET;
      angle = ko ? a[1] : a[0];
      return '<p><b>' + esc(s.title) + '</b> - ' + esc(s.description) + '</p>' + (imp ? '<p class="mono">' + esc(imp) + '</p>' : '') + '<p>' + angle + '</p>';
    }

    function supplyAnswer(st, ko) {
      if (!st || !st.teams || !st.teams.length) return fallback(ko);
      const supply = st.teams.reduce((s, t) => s + Math.max(0, Math.min(t.quantity, t.inventory)), 0);
      const total = st.totalDemand || st.demandPerTeam * st.teams.length;
      const diff = supply - total;
      if (ko) return '<p>현재 공급 <b>' + supply + '</b>개 vs 애플 수요 <b>' + total + '</b>개. ' + (diff > 0 ? diff + '개 공급과잉 - 점수 낮은 팀부터 못 팝니다.' : Math.abs(diff) + '개 수요가 남아요 - 내놓은 팀은 순위와 상관없이 다 팝니다.') + '</p>';
      return '<p>Offered right now: <b>' + supply + '</b> chips vs Apple\'s <b>' + total + '</b>. ' + (diff > 0 ? 'Oversupplied by ' + diff + ' - the lowest-scoring teams get squeezed out.' : 'Short by ' + Math.abs(diff) + ' - everyone who offers sells everything, whatever their rank.') + '</p>';
    }

    function fallback(ko) {
      return ko
        ? '<p>그건 아직 잘 몰라요. 이런 걸 물어볼 수 있어요: "최적 가격", "테크 사야 해?", "경쟁팀", "이번 쇼크", "점수 계산", "기여도", "어떻게 이겨?"</p>'
        : '<p>I don\'t have an answer for that one. Try: "best price", "buy tech?", "rivals", "this shock", "how is score calculated", "contribution", "how do I win?"</p>';
    }

    // ---------------- host answers ----------------
    function hostAnswer(intent, st, ko) {
      const live = st && st.teams && st.teams.length;
      if (intent === 'status') {
        if (!live) return ko ? '<p>아직 팀이 없어요.</p>' : '<p>No teams yet.</p>';
        if (st.phase !== 'round_active') return ko ? '<p>현재 단계: ' + st.phase + '. 라운드 진행 중에 락인 현황을 볼 수 있어요.</p>' : '<p>Phase: ' + st.phase + '. Lock-in status shows while a round is live.</p>';
        const open = st.teams.filter((t) => !t.locked);
        const offline = st.teams.filter((t) => !t.connected && !t.isBot);
        const t = st.timeLeft != null ? st.timeLeft + 's' : '—';
        let html = ko
          ? '<p>R' + st.round + ', 남은 시간 ' + t + '. 락인 ' + (st.teams.length - open.length) + '/' + st.teams.length + '팀.</p>'
          : '<p>Round ' + st.round + ', ' + t + ' left. ' + (st.teams.length - open.length) + ' of ' + st.teams.length + ' teams locked.</p>';
        if (open.length) html += '<p>' + (ko ? '아직: ' : 'Still open: ') + open.map((x) => '<b>' + esc(x.teamName) + '</b>').join(', ') + '</p>';
        if (offline.length) html += '<p class="up">' + (ko ? '접속 끊김: ' : 'Offline: ') + offline.map((x) => esc(x.teamName)).join(', ') + '</p>';
        return html;
      }
      if (intent === 'supply') return supplyAnswer(st, ko);
      if (intent === 'shock') {
        if (!st || !st.shock) return ko ? '<p>활성 쇼크 없음.</p>' : '<p>No active shock.</p>';
        const e = st.shock.effects || {};
        const b = e.weightBias || {};
        const raw = [['Capacity output', e.capacityProductionMultiplier], ['Tech cost', e.techUpgradeCostMultiplier], ['Capacity cost', e.capacityUpgradeCostMultiplier], ['Demand', e.demandMultiplier], ['Price weight', b.price], ['Tech weight', b.tech], ['Capacity weight', b.capacity]]
          .filter((x) => x[1] != null && x[1] !== 1)
          .map((x) => x[0] + ' ×' + x[1])
          .join(', ');
        return '<p><b>' + esc(st.shock.title) + '</b> (' + (st.shock.source === 'ai' ? 'AI' : 'template') + ')</p><p>' + esc(st.shock.description) + '</p><p class="mono">' + (raw || 'No numeric change') + '</p><p class="muted">' + (ko ? 'Market volatility 설정이 이 값을 키우거나 줄여요.' : 'Your Market volatility setting scales these before they apply.') + '</p>';
      }
      if (intent === 'pacing') {
        return ko
          ? '<ul><li>첫 라운드는 시간을 넉넉히(180초+). 다들 숫자 감 잡는 중이에요.</li><li>대부분 락인했는데 한 팀만 남았으면 Pause 후 말로 재촉하거나 Force skip.</li><li>결과 화면은 20초 후 자동으로 다음 라운드 - 토론이 필요하면 Pause 대신 결과 화면에서 바로 이야기하세요.</li><li>4~5라운드부터 타이머를 줄이면 긴장감이 올라가요.</li></ul>'
          : '<ul><li>Give round 1 plenty of time (180s+) - everyone is still learning the numbers.</li><li>If everyone but one team has locked, pause and nudge them out loud, or Force skip.</li><li>Results auto-advance after 20s; click Start next round early if the room is ready.</li><li>Shortening the timer in rounds 4-6 raises the tension.</li></ul>';
      }
      if (intent === 'contributors') {
        if (!live) return fallback(ko);
        const rows = [];
        st.teams.forEach((t) => {
          if (t.isBot) return;
          const ms = (t.members || []).filter((m) => m.contribution).slice().sort((a, b) => b.contribution.total - a.contribution.total);
          if (!ms.length) return;
          const top = ms[0];
          const quiet = ms.length > 1 ? ms[ms.length - 1] : null;
          rows.push('<li><b>' + esc(t.teamName) + '</b>: ' + esc(top.memberName) + ' ' + top.contribution.share + '%' + (quiet && quiet.contribution.share < 15 ? (ko ? ' · 참여 적음: ' : ' · quiet: ') + esc(quiet.memberName) + ' ' + quiet.contribution.share + '%' : '') + '</li>');
        });
        return rows.length ? '<p>' + (ko ? '팀별 최고 기여자:' : 'Top contributor per team:') + '</p><ul>' + rows.join('') + '</ul>' : ko ? '<p>아직 기여 데이터가 없어요.</p>' : '<p>No contribution data yet.</p>';
      }
      if (intent === 'settings') {
        return ko
          ? '<ul><li><b>가중치</b>: 애플이 가격/Tech/Capacity를 얼마나 중시하는지. 가격 비중↑ = 가격 전쟁.</li><li><b>팀당 수요</b>: 기본 70 (기본 생산 100보다 낮아서 경쟁이 생김). 올리면 다들 팔기 쉬워짐.</li><li><b>Market volatility</b>: 쇼크 강도 0.5~2배. 경기 중에도 변경 가능.</li><li><b>Inflation</b>: 라운드마다 업그레이드 비용이 복리로 상승 → 초반 투자 유리.</li><li><b>Starting budget</b>: 기본 $5,000.</li></ul>'
          : '<ul><li><b>Weights</b>: how much Apple cares about Price / Tech / Capacity. A heavier Price weight means a price war.</li><li><b>Demand per team</b>: default 70, deliberately below base production (100), so not everyone sells out. Raise it for an easier match.</li><li><b>Market volatility</b>: scales every shock 0.5-2×. Adjustable mid-match.</li><li><b>Inflation</b>: upgrade costs compound each round, rewarding early investment.</li><li><b>Starting budget</b>: default $5,000.</li></ul>';
      }
      if (intent === 'bots') {
        return ko ? '<p>로비에서 AI 봇 추가 가능: Tech형, Capacity형, Balanced형. 최소 3팀이 필요하니 인원이 적을 때 채워 넣으세요.</p>' : '<p>Add AI bots from the lobby: Tech-heavy, Capacity-heavy or Balanced. A match needs 3 teams, so bots fill gaps in small groups.</p>';
      }
      if (intent === 'broadcast') {
        return ko ? '<p>"Projector view"를 누르면 새 탭에 읽기 전용 화면이 열려요: 각 팀의 기업가치를 캔들차트로 보여주고(상승 빨강/하락 파랑), 컨트롤이나 현금 정보는 없습니다.</p>' : '<p>"Projector view" opens a read-only tab: each team\'s Company Value as a candlestick chart (red up, blue down), plus the leaderboard and live activity - no controls, no cash figures.</p>';
      }
      return fallback(ko).replace('"best price", "buy tech?", "rivals", ', '"who hasn\'t locked", "supply vs demand", ').replace('"최적 가격", "테크 사야 해?", "경쟁팀", ', '"누가 락인 안 했어?", "공급 수요", ');
    }

    // ---------------- passive alerts ----------------
    function update(st) {
      if (!st || st.phase !== 'round_active') return;
      if (mode === 'player') {
        const me = st.teams && st.teams.find((t) => t.teamId === st.myTeamId);
        if (me && !me.locked && st.timeLeft != null && st.timeLeft <= 30 && alertedRound !== st.round) {
          alertedRound = st.round;
          if (!panel.classList.contains('open')) fab.classList.add('has-alert');
        }
      }
    }

    return { open, close, update, simulate: resolve };
  }

  global.Analyst = { mount, simulate: resolve };
})(window);
