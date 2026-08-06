// engine.js
// Chip War (MSG) - pure game-logic engine, zero dependencies.
// Every formula here is taken directly from the GDD v2.0 "Final Effective
// Price System (v3.0)" and "Default Economic Balancing Table" sections.
// Kept dependency-free on purpose so it can be unit-tested with plain
// `node engine.js` and reused unchanged by server.js.

const CONFIG = Object.freeze({
  ROUNDS: 6,
  ROUND_TIMER_SECONDS: 180, // 3 minutes, GDD 2.3 / Match Length table

  INITIAL_CAPITAL: 5000, // default Starting Budget (host-configurable per room)
  INITIAL_INVENTORY: 0,
  INITIAL_TECH: 0,
  INITIAL_CAPACITY: 0,

  BASE_PRODUCTION: 100,
  PRODUCTION_PER_LEVEL: 50,

  TECH_UPGRADE_COST: 2000, // cost of the FIRST tech upgrade (0->1)
  CAPACITY_UPGRADE_COST: 1500, // cost of the FIRST capacity upgrade (0->1)
  UPGRADE_COST_GROWTH: 1.5, // each purchase makes the next one 1.5x more expensive

  TECH_MAX: 5, // Developer note: Tmax fixed at 5
  CAPACITY_MAX: 5, // Developer note: Cmax fixed at 5
  Q_BASE: 0, // Developer note: Qbase fixed at 0

  DEMAND_PER_TEAM: 200, // Apple RemainingDemand = teams.length * 200

  WEIGHTS_DEFAULT: Object.freeze({ price: 0.5, tech: 0.3, capacity: 0.2 }),

  ASSET_RATES: Object.freeze({
    inventory: 10, // $ per remaining unit
    tech: 500, // $ per tech level
    capacity: 500 // $ per capacity level
  })
});

/** Force Wp+Wt+Wc = 1.0 no matter what the host typed in. */
function normalizeWeights(w) {
  const price = Number(w && w.price) || 0;
  const tech = Number(w && w.tech) || 0;
  const capacity = Number(w && w.capacity) || 0;
  const sum = price + tech + capacity;
  if (sum <= 0) return { ...CONFIG.WEIGHTS_DEFAULT };
  return { price: price / sum, tech: tech / sum, capacity: capacity / sum };
}

/**
 * Production = BaseProduction + (CapacityLevel x ProductionPerLevel x multiplier)
 * multiplier defaults to 1 (no shock). Only the per-level BONUS is scaled -
 * the base floor everyone gets for free is never touched by a shock, so a
 * "Supply Chain Crisis" punishes capacity investment specifically instead
 * of punishing every team equally regardless of strategy.
 */
function calcProduction(capacityLevel, multiplier = 1) {
  const c = Math.max(0, Math.min(capacityLevel, CONFIG.CAPACITY_MAX));
  const m = Number.isFinite(multiplier) ? multiplier : 1;
  return Math.round(CONFIG.BASE_PRODUCTION + c * CONFIG.PRODUCTION_PER_LEVEL * m);
}

/**
 * Cost of a team's NEXT Tech/Capacity upgrade. Each purchase makes the next
 * one UPGRADE_COST_GROWTH (1.5x) more expensive: level 0->1 costs the base
 * price, 1->2 costs base*1.5, 2->3 costs base*1.5^2, and so on. Callers may
 * layer additional situational multipliers (inflation, a shock) on top of
 * this return value - this function only owns the level-based curve.
 */
function calcUpgradeCost(kind, currentLevel) {
  const base = kind === 'tech' ? CONFIG.TECH_UPGRADE_COST : CONFIG.CAPACITY_UPGRADE_COST;
  const max = kind === 'tech' ? CONFIG.TECH_MAX : CONFIG.CAPACITY_MAX;
  const level = Math.max(0, Math.min(currentLevel, max));
  return Math.round(base * Math.pow(CONFIG.UPGRADE_COST_GROWTH, level));
}

/** Qt = Qbase + (Ti/Tmax) x (100-Qbase); with Qbase=0 this is (Ti/5)*100 */
function calcTechScore(techLevel) {
  const t = Math.max(0, Math.min(techLevel, CONFIG.TECH_MAX));
  return CONFIG.Q_BASE + (t / CONFIG.TECH_MAX) * (100 - CONFIG.Q_BASE);
}

/** Qc = Qbase + (Ci/Cmax) x (100-Qbase) */
function calcCapacityScore(capacityLevel) {
  const c = Math.max(0, Math.min(capacityLevel, CONFIG.CAPACITY_MAX));
  return CONFIG.Q_BASE + (c / CONFIG.CAPACITY_MAX) * (100 - CONFIG.Q_BASE);
}

/**
 * Qp = (Pmax-Pi)/(Pmax-Pmin) x 100, with the Division-by-Zero Protection
 * rule: if every team submitted the same price, Qp = 100 for everyone.
 * entries: [{ teamId, price }]
 * returns: { [teamId]: Qp }
 */
function calcPriceScores(entries) {
  const prices = entries.map((e) => e.price);
  const pMax = Math.max(...prices);
  const pMin = Math.min(...prices);
  const scores = {};
  for (const e of entries) {
    scores[e.teamId] = pMax === pMin ? 100 : ((pMax - e.price) / (pMax - pMin)) * 100;
  }
  return scores;
}

/** CS = (Qp x Wp) + (Qt x Wt) + (Qc x Wc) */
function calcCompetitiveScore(Qp, Qt, Qc, weights) {
  return Qp * weights.price + Qt * weights.tech + Qc * weights.capacity;
}

/**
 * Runs Apple's full purchase algorithm for one round.
 * teams: [{ teamId, price, quantity, techLevel, capacityLevel, lockOrder? }]
 * weights: { price, tech, capacity } (will be re-normalized defensively)
 * demandPerTeam: units of demand contributed by each participating team
 *
 * Returns each team enriched with { Qp, Qt, Qc, CS, purchased, revenue },
 * sorted by purchase priority (highest CS first). Any demand left over
 * after every team's offered quantity is exhausted is discarded, per the
 * "Apple Unsold Demand Handling" rule - it is never force-assigned.
 */
function resolveApplePurchase({ teams, weights, demandPerTeam }) {
  if (!teams || teams.length === 0) return [];
  const w = normalizeWeights(weights);
  const qpMap = calcPriceScores(teams.map((t) => ({ teamId: t.teamId, price: t.price })));

  const scored = teams.map((t) => {
    const Qp = qpMap[t.teamId];
    const Qt = calcTechScore(t.techLevel);
    const Qc = calcCapacityScore(t.capacityLevel);
    const CS = calcCompetitiveScore(Qp, Qt, Qc, w);
    return { ...t, Qp, Qt, Qc, CS };
  });

  // Highest Competitive Score buys first. Ties broken by whoever locked in
  // earlier (lower lockOrder) - rewards committing instead of stalling.
  scored.sort((a, b) => b.CS - a.CS || (a.lockOrder || 0) - (b.lockOrder || 0));

  let remainingDemand = teams.length * demandPerTeam;
  return scored.map((t) => {
    const purchased = Math.max(0, Math.min(t.quantity, remainingDemand));
    remainingDemand -= purchased;
    const revenue = purchased * t.price;
    return { ...t, purchased, revenue };
  });
}

/** MP = sum(Price_i x Purchased_i) / sum(Purchased_i), with a safe fallback. */
function calcMarketPrice(results, previousMP) {
  if (!results || results.length === 0) return previousMP || 0;
  const totalPurchased = results.reduce((s, r) => s + r.purchased, 0);
  if (totalPurchased === 0) {
    // Nobody sold anything (e.g. an all-zero-quantity round) - fall back to
    // the plain average of submitted prices instead of dividing by zero.
    const avg = results.reduce((s, r) => s + r.price, 0) / results.length;
    return Math.round(avg * 100) / 100;
  }
  const weighted = results.reduce((s, r) => s + r.price * r.purchased, 0);
  return Math.round((weighted / totalPurchased) * 100) / 100;
}

/** CompanyValue = Capital + InventoryValue + TechnologyValue + CapacityValue */
function calcCompanyValue(team) {
  return (
    team.capital +
    team.inventory * CONFIG.ASSET_RATES.inventory +
    team.techLevel * CONFIG.ASSET_RATES.tech +
    team.capacityLevel * CONFIG.ASSET_RATES.capacity
  );
}

/* ============================================================================
 * MARKET SHOCKS ("오점 1" fix) - a per-round modifier that stops every match
 * from converging on the same "max invest early, dump late" build order.
 *
 * A shock is: { title, icon, description, effects, source }
 * effects is always the same shape regardless of where the shock came from
 * (hand-written template below, or an AI-generated one in server.js), which
 * is what lets sanitizeShock() validate AI output with the exact same rules
 * a template already has to satisfy:
 *   capacityProductionMultiplier  0.4 - 1.6   (hits pure-Capacity rush builds)
 *   techUpgradeCostMultiplier     0.5 - 2.0
 *   capacityUpgradeCostMultiplier 0.5 - 2.0
 *   demandMultiplier              0.6 - 1.8
 *   weightBias { price, tech, capacity }  0.4 - 2.5 each (hits pure-price
 *     dumping builds when price gets biased down, or tech/capacity up)
 * ==========================================================================*/

const NEUTRAL_SHOCK = Object.freeze({
  title: 'Calm Market',
  icon: '🌤️',
  description: 'No major disruptions this round — standard rules apply.',
  effects: Object.freeze({
    capacityProductionMultiplier: 1,
    techUpgradeCostMultiplier: 1,
    capacityUpgradeCostMultiplier: 1,
    demandMultiplier: 1,
    weightBias: Object.freeze({ price: 1, tech: 1, capacity: 1 })
  }),
  source: 'neutral'
});

function roll(min, max) {
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}
function pct(multiplier) {
  return Math.round(Math.abs(1 - multiplier) * 100);
}

// 13 dramatic templates + Calm Market (weighted heavier so chaos isn't
// constant). Magnitudes re-roll every time a template is picked, so even a
// template repeating later in a long match reads a little differently.
function getShockTemplates() {
  return [
    {
      id: 'supply_crisis',
      title: 'Supply Chain Crisis',
      icon: '⚠️',
      build() {
        const m = roll(0.45, 0.75);
        return { effects: { capacityProductionMultiplier: m }, description: `A component shortage cuts everyone's Capacity efficiency by ${pct(m)}% this round.` };
      }
    },
    {
      id: 'capacity_boom',
      title: 'Logistics Breakthrough',
      icon: '⚙️',
      build() {
        const m = roll(1.15, 1.45);
        return { effects: { capacityProductionMultiplier: m }, description: `A new shipping route boosts Capacity efficiency by ${pct(m)}% this round.` };
      }
    },
    {
      id: 'apple_quality_push',
      title: "Apple's Quality Push",
      icon: '🍎',
      build() {
        const m = roll(1.5, 2.3);
        return { effects: { weightBias: { tech: m } }, description: `Apple is prioritizing quality this round — Tech scores count for noticeably more.` };
      }
    },
    {
      id: 'apple_value_push',
      title: "Apple's Value Push",
      icon: '💵',
      build() {
        const m = roll(1.4, 2.0);
        return { effects: { weightBias: { price: m } }, description: `Apple is watching every dollar this round — Price matters more than usual.` };
      }
    },
    {
      id: 'reliability_focus',
      title: 'Reliability Focus',
      icon: '🔧',
      build() {
        const m = roll(1.5, 2.2);
        return { effects: { weightBias: { capacity: m } }, description: `Apple wants proof you can deliver at scale — Capacity counts for more this round.` };
      }
    },
    {
      id: 'chip_glut',
      title: 'Chip Glut',
      icon: '📦',
      build() {
        const m = roll(0.55, 0.75);
        return { effects: { demandMultiplier: m }, description: `Apple trimmed its forecast — total demand is down ${pct(m)}% this round.` };
      }
    },
    {
      id: 'emergency_restock',
      title: 'Emergency Restock',
      icon: '🚨',
      build() {
        const m = roll(1.3, 1.75);
        return { effects: { demandMultiplier: m }, description: `A surprise product launch means Apple needs ${pct(m)}% more chips this round.` };
      }
    },
    {
      id: 'talent_war',
      title: 'Talent War',
      icon: '🧠',
      build() {
        const m = roll(1.4, 1.9);
        return { effects: { techUpgradeCostMultiplier: m }, description: `Engineers are hard to hire right now — Tech upgrades cost ${pct(m)}% more this round.` };
      }
    },
    {
      id: 'rd_grant',
      title: 'R&D Grant',
      icon: '🎓',
      build() {
        const m = roll(0.5, 0.7);
        return { effects: { techUpgradeCostMultiplier: m }, description: `A government grant cuts the cost of Tech upgrades by ${pct(m)}% this round.` };
      }
    },
    {
      id: 'factory_subsidy',
      title: 'Factory Subsidy',
      icon: '🏗️',
      build() {
        const m = roll(0.5, 0.7);
        return { effects: { capacityUpgradeCostMultiplier: m }, description: `A regional subsidy cuts the cost of Capacity upgrades by ${pct(m)}% this round.` };
      }
    },
    {
      id: 'import_tariff',
      title: 'Import Tariff',
      icon: '🛃',
      build() {
        const m = roll(1.4, 1.9);
        return { effects: { capacityUpgradeCostMultiplier: m }, description: `New equipment tariffs make Capacity upgrades ${pct(m)}% more expensive this round.` };
      }
    },
    {
      id: 'quality_scandal',
      title: "Rival's Quality Scandal",
      icon: '🔍',
      build() {
        const m = roll(0.5, 0.7);
        return { effects: { weightBias: { tech: m } }, description: `A competitor's recall has buyers distracted — Tech matters a bit less this round.` };
      }
    },
    {
      id: 'budget_slack',
      title: 'Budget Slack',
      icon: '💰',
      build() {
        const m = roll(0.5, 0.7);
        return { effects: { weightBias: { price: m } }, description: `Apple has extra budget slack this round — Price matters a bit less than usual.` };
      }
    },
    { id: 'calm_market', title: NEUTRAL_SHOCK.title, icon: NEUTRAL_SHOCK.icon, weight: 4, build: () => ({ effects: {}, description: NEUTRAL_SHOCK.description }) }
  ];
}

/** Clamp + validate a raw shock object from ANY source (template or AI JSON). */
function sanitizeShock(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 60) : '';
  const description = typeof raw.description === 'string' ? raw.description.trim().slice(0, 220) : '';
  if (!title || !description) return null;
  const icon = typeof raw.icon === 'string' && raw.icon.trim() ? raw.icon.trim().slice(0, 4) : '⚡';
  const e = raw.effects && typeof raw.effects === 'object' ? raw.effects : {};
  const bias = e.weightBias && typeof e.weightBias === 'object' ? e.weightBias : {};
  const clamp = (v, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 1;
  };
  return {
    title,
    description,
    icon,
    effects: {
      capacityProductionMultiplier: clamp(e.capacityProductionMultiplier, 0.4, 1.6),
      techUpgradeCostMultiplier: clamp(e.techUpgradeCostMultiplier, 0.5, 2.0),
      capacityUpgradeCostMultiplier: clamp(e.capacityUpgradeCostMultiplier, 0.5, 2.0),
      demandMultiplier: clamp(e.demandMultiplier, 0.6, 1.8),
      weightBias: {
        price: clamp(bias.price, 0.4, 2.5),
        tech: clamp(bias.tech, 0.4, 2.5),
        capacity: clamp(bias.capacity, 0.4, 2.5)
      }
    },
    source: source || 'procedural'
  };
}

/** Picks a template (skipping recently-used titles where possible) and rolls it. */
function pickProceduralShock(recentTitles) {
  const avoid = new Set(recentTitles || []);
  const templates = getShockTemplates();
  let pool = [];
  templates.forEach((t) => {
    if (avoid.has(t.title)) return;
    for (let i = 0; i < (t.weight || 1); i++) pool.push(t);
  });
  if (pool.length === 0) pool = templates; // everything was used recently - allow a repeat rather than break
  const chosen = pool[Math.floor(Math.random() * pool.length)];
  const built = chosen.build();
  return sanitizeShock({ title: chosen.title, icon: chosen.icon, description: built.description, effects: built.effects }, 'procedural');
}

function getEffectiveWeights(baseWeights, shock) {
  const bias = (shock && shock.effects && shock.effects.weightBias) || { price: 1, tech: 1, capacity: 1 };
  return normalizeWeights({
    price: baseWeights.price * (bias.price || 1),
    tech: baseWeights.tech * (bias.tech || 1),
    capacity: baseWeights.capacity * (bias.capacity || 1)
  });
}
function getEffectiveDemandPerTeam(baseDemand, shock) {
  const mult = (shock && shock.effects && shock.effects.demandMultiplier) || 1;
  return Math.max(1, Math.round(baseDemand * mult));
}
function getCostMultiplier(shock, kind) {
  if (!shock || !shock.effects) return 1;
  return kind === 'tech' ? shock.effects.techUpgradeCostMultiplier || 1 : shock.effects.capacityUpgradeCostMultiplier || 1;
}
function getCapacityProdMultiplier(shock) {
  return (shock && shock.effects && shock.effects.capacityProductionMultiplier) || 1;
}

/* ============================================================================
 * LIVE PURCHASE-RANK PREVIEW ("오점 2" fix) - pure math, no AI needed. Reuses
 * resolveApplePurchase() as a read-only simulation: "if the round ended on
 * these currently-visible numbers right now, who would Apple buy from?"
 * Safe to call on every keystroke - it does not mutate anything.
 * ==========================================================================*/
function computeLivePreview({ teams, weights, demandPerTeam }) {
  if (!teams || teams.length === 0) return {};
  const entries = teams.map((t) => ({
    teamId: t.teamId,
    price: t.price,
    quantity: Math.max(0, Math.min(t.quantity, t.inventory)),
    techLevel: t.techLevel,
    capacityLevel: t.capacityLevel,
    lockOrder: t.lockOrder || 0
  }));
  const results = resolveApplePurchase({ teams: entries, weights, demandPerTeam });
  const preview = {};
  results.forEach((r, idx) => {
    const offered = entries.find((e) => e.teamId === r.teamId).quantity;
    let status = 'risk';
    if (offered > 0 && r.purchased >= offered) status = 'safe';
    else if (r.purchased > 0) status = 'caution';
    preview[r.teamId] = { rank: idx + 1, totalTeams: teams.length, predictedSold: r.purchased, offered, status };
  });
  return preview;
}

/**
 * Pulls the first {...} JSON object out of a raw LLM text response (tolerant
 * of stray prose or ```json fences around it) and runs it through
 * sanitizeShock(). Returns null on ANY parse/validation failure - this is
 * the one function standing between "whatever the model said" and the
 * actual game state, so it never throws, it just declines.
 */
function parseShockResponseText(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return sanitizeShock(parsed, 'ai');
  } catch (err) {
    return null;
  }
}

/* ============================================================================
 * BASIC ENGLISH PROFANITY FILTER - a plain word-list check, not an NLP
 * moderation system. Whole-word matching only (so "class" never matches
 * "ass") on a normalized (lowercased, punctuation-stripped) copy of the
 * text. Easy to bypass with creative spelling; good enough to stop the
 * common case in a classroom chat. Swap in a real moderation API later if
 * stronger coverage is needed - see README "what to expand next".
 * ==========================================================================*/
const PROFANITY_WORDLIST = [
  'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch', 'asshole', 'ass',
  'bastard', 'dick', 'pussy', 'cunt', 'whore', 'slut', 'retard', 'retarded', 'cock', 'twat',
  'wanker', 'douchebag', 'nigger', 'nigga', 'faggot', 'fag', 'dumbass'
];
function containsProfanity(text) {
  if (typeof text !== 'string' || !text) return false;
  const normalized = text.toLowerCase().replace(/[^a-z\s]/g, ' ');
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.some((w) => PROFANITY_WORDLIST.includes(w));
}

module.exports = {
  CONFIG,
  normalizeWeights,
  calcProduction,
  calcUpgradeCost,
  calcTechScore,
  calcCapacityScore,
  calcPriceScores,
  calcCompetitiveScore,
  resolveApplePurchase,
  calcMarketPrice,
  calcCompanyValue,
  NEUTRAL_SHOCK,
  sanitizeShock,
  pickProceduralShock,
  parseShockResponseText,
  getEffectiveWeights,
  getEffectiveDemandPerTeam,
  getCostMultiplier,
  getCapacityProdMultiplier,
  computeLivePreview,
  containsProfanity
};
