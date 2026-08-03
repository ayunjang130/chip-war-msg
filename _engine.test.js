const assert = require('assert');
const e = require('./engine');

function approx(a, b, msg) {
  assert.ok(Math.abs(a - b) < 0.01, `${msg}: expected ~${b}, got ${a}`);
}

// 1) Equal prices -> Qp = 100 for everyone (division-by-zero guard)
{
  const scores = e.calcPriceScores([
    { teamId: 'a', price: 50 },
    { teamId: 'b', price: 50 }
  ]);
  approx(scores.a, 100, 'equal price Qp a');
  approx(scores.b, 100, 'equal price Qp b');
}

// 2) Tech/Capacity score bounds: level 0 -> 0, level 5 (max) -> 100
approx(e.calcTechScore(0), 0, 'tech score at level 0');
approx(e.calcTechScore(5), 100, 'tech score at level 5 (max)');
approx(e.calcCapacityScore(5), 100, 'capacity score at level 5 (max)');
// level above max is clamped, not extrapolated past 100
approx(e.calcTechScore(9), 100, 'tech score clamps above max');

// 3) Weight normalization always sums to 1
{
  const w = e.normalizeWeights({ price: 5, tech: 3, capacity: 2 });
  approx(w.price + w.tech + w.capacity, 1, 'weights sum to 1');
  approx(w.price, 0.5, 'price weight normalized');
}

// 4) Production formula
assert.strictEqual(e.calcProduction(0), 100, 'base production at capacity 0');
assert.strictEqual(e.calcProduction(3), 250, 'production at capacity 3 (100+3*50)');

// 5) Full purchase round: 3 teams, demand caps who gets served, leftover discarded
{
  const teams = [
    { teamId: 'nvidia', price: 60, quantity: 300, techLevel: 5, capacityLevel: 0, lockOrder: 1 }, // premium, low volume
    { teamId: 'tsmc', price: 40, quantity: 500, techLevel: 0, capacityLevel: 5, lockOrder: 2 }, // cheap, high volume
    { teamId: 'samsung', price: 50, quantity: 300, techLevel: 2, capacityLevel: 2, lockOrder: 3 } // balanced
  ];
  const results = e.resolveApplePurchase({
    teams,
    weights: e.CONFIG.WEIGHTS_DEFAULT,
    demandPerTeam: 200
  });
  const totalDemand = 3 * 200; // 600
  const totalPurchased = results.reduce((s, r) => s + r.purchased, 0);
  assert.ok(totalPurchased <= totalDemand, 'never purchase more than total demand');
  assert.ok(totalPurchased <= teams.reduce((s, t) => s + t.quantity, 0), 'never purchase more than offered');
  // Cheapest price (tsmc, Wp=0.5 dominant) should out-rank pure premium nvidia here
  const order = results.map((r) => r.teamId);
  assert.ok(order.indexOf('tsmc') < order.indexOf('nvidia'), 'lower price + higher capacity should rank above pure premium under default weights');

  const mp = e.calcMarketPrice(results, 0);
  assert.ok(mp > 0, 'market price should be a positive weighted average');
}

// 6) Zero-quantity round never divides by zero
{
  const results = e.resolveApplePurchase({
    teams: [{ teamId: 'a', price: 50, quantity: 0, techLevel: 0, capacityLevel: 0, lockOrder: 1 }],
    weights: e.CONFIG.WEIGHTS_DEFAULT,
    demandPerTeam: 200
  });
  const mp = e.calcMarketPrice(results, 42);
  assert.strictEqual(mp, 50, 'falls back to average submitted price when nothing sells');
}

// 7) Company value handles debt (negative capital) without crashing
{
  const value = e.calcCompanyValue({ capital: -7500, inventory: 40, techLevel: 5, capacityLevel: 5 });
  approx(value, -7500 + 40 * 10 + 5 * 500 + 5 * 500, 'company value formula with debt');
}

console.log('All engine.js checks passed.');
