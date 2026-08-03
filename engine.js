// engine.js
// Chip War (MSG) - pure game-logic engine, zero dependencies.
// Every formula here is taken directly from the GDD v2.0 "Final Effective
// Price System (v3.0)" and "Default Economic Balancing Table" sections.
// Kept dependency-free on purpose so it can be unit-tested with plain
// `node engine.js` and reused unchanged by server.js.

const CONFIG = Object.freeze({
  ROUNDS: 6,
  ROUND_TIMER_SECONDS: 180, // 3 minutes, GDD 2.3 / Match Length table

  INITIAL_CAPITAL: 10000,
  INITIAL_INVENTORY: 0,
  INITIAL_TECH: 0,
  INITIAL_CAPACITY: 0,

  BASE_PRODUCTION: 100,
  PRODUCTION_PER_LEVEL: 50,

  TECH_UPGRADE_COST: 2000,
  CAPACITY_UPGRADE_COST: 1500,

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

/** Production = BaseProduction + (CapacityLevel x ProductionPerLevel) */
function calcProduction(capacityLevel) {
  const c = Math.max(0, Math.min(capacityLevel, CONFIG.CAPACITY_MAX));
  return CONFIG.BASE_PRODUCTION + c * CONFIG.PRODUCTION_PER_LEVEL;
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

module.exports = {
  CONFIG,
  normalizeWeights,
  calcProduction,
  calcTechScore,
  calcCapacityScore,
  calcPriceScores,
  calcCompetitiveScore,
  resolveApplePurchase,
  calcMarketPrice,
  calcCompanyValue
};
