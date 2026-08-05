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

// ---------------------------------------------------------------------------
// Market Shocks
// ---------------------------------------------------------------------------

// 8) calcProduction stays backward-compatible with no multiplier argument
assert.strictEqual(e.calcProduction(2), 200, 'calcProduction defaults multiplier to 1 (100 + 2*50)');
// multiplier only scales the per-level bonus, never the free floor
approx(e.calcProduction(2, 0.5), 150, 'capacity multiplier scales only the bonus (100 + 2*50*0.5)');
approx(e.calcProduction(0, 0.5), 100, 'multiplier has no effect at capacity 0 (nothing to scale)');

// 9) sanitizeShock rejects garbage and clamps out-of-range numbers instead of trusting them
{
  assert.strictEqual(e.sanitizeShock(null), null, 'null input rejected');
  assert.strictEqual(e.sanitizeShock({}), null, 'missing title/description rejected');
  assert.strictEqual(e.sanitizeShock({ title: 'x', description: 'y', effects: 'not-an-object' }) === null, false, 'malformed effects falls back to neutral instead of crashing');
  const wild = e.sanitizeShock(
    {
      title: 'Absurd Market Manipulation',
      description: 'Someone asked the AI for a 100x multiplier.',
      effects: { capacityProductionMultiplier: 100, demandMultiplier: -5, weightBias: { tech: 999 } }
    },
    'ai'
  );
  assert.ok(wild.effects.capacityProductionMultiplier <= 1.6, 'capacityProductionMultiplier clamped to safe ceiling');
  assert.ok(wild.effects.demandMultiplier >= 0.6, 'demandMultiplier clamped to safe floor even when given a negative number');
  assert.ok(wild.effects.weightBias.tech <= 2.5, 'weightBias.tech clamped to safe ceiling');
  assert.strictEqual(wild.source, 'ai', 'source tag preserved through sanitization');
}

// 10) pickProceduralShock always returns a valid, engine-safe shock and avoids recent repeats when possible
{
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const s = e.pickProceduralShock([]);
    assert.ok(s && s.title && s.description && s.effects, 'every procedural shock is well-formed');
    seen.add(s.title);
  }
  assert.ok(seen.size >= 5, `expected real variety across 40 draws, only saw ${seen.size} distinct titles`);

  // if we tell it to avoid every possible title, it must still return something valid (fallback to allowing repeats)
  const allTitles = ['Supply Chain Crisis', 'Logistics Breakthrough', "Apple's Quality Push", "Apple's Value Push", 'Reliability Focus', 'Chip Glut', 'Emergency Restock', 'Talent War', 'R&D Grant', 'Factory Subsidy', 'Import Tariff', "Rival's Quality Scandal", 'Budget Slack', 'Calm Market'];
  const forced = e.pickProceduralShock(allTitles);
  assert.ok(forced && forced.title, 'never returns nothing, even when every title is supposedly recent');
}

// 11) getEffectiveWeights/getEffectiveDemandPerTeam thread shock effects correctly and always stay normalized
{
  const base = e.CONFIG.WEIGHTS_DEFAULT; // { price:0.5, tech:0.3, capacity:0.2 }
  const noShockW = e.getEffectiveWeights(base, null);
  approx(noShockW.price + noShockW.tech + noShockW.capacity, 1, 'weights still sum to 1 with no shock');
  approx(noShockW.price, 0.5, 'no shock leaves weights unchanged');

  const techPush = { effects: { weightBias: { tech: 2 } } };
  const biasedW = e.getEffectiveWeights(base, techPush);
  approx(biasedW.price + biasedW.tech + biasedW.capacity, 1, 'weights still sum to 1 after a bias');
  assert.ok(biasedW.tech > noShockW.tech, "Apple's Quality Push actually raises tech's effective weight");
  assert.ok(biasedW.price < noShockW.price, 'raising one weight proportionally lowers the others after renormalization');

  const demandDown = e.getEffectiveDemandPerTeam(200, { effects: { demandMultiplier: 0.6 } });
  assert.strictEqual(demandDown, 120, 'Chip Glut-style shock reduces demand per team as expected (200*0.6)');
  const demandNoShock = e.getEffectiveDemandPerTeam(200, null);
  assert.strictEqual(demandNoShock, 200, 'no shock leaves demand unchanged');
}

// 12) computeLivePreview matches what resolveApplePurchase would actually do
{
  const teams = [
    { teamId: 'a', price: 30, quantity: 250, inventory: 250, techLevel: 5, capacityLevel: 5 }, // cheapest + maxed -> should rank 1st
    { teamId: 'b', price: 80, quantity: 250, inventory: 250, techLevel: 0, capacityLevel: 0 }, // priciest + weakest -> should rank last
    { teamId: 'c', price: 50, quantity: 250, inventory: 250, techLevel: 2, capacityLevel: 2 }
  ];
  const preview = e.computeLivePreview({ teams, weights: e.CONFIG.WEIGHTS_DEFAULT, demandPerTeam: 200 }); // total demand 600
  assert.strictEqual(preview.a.rank, 1, 'cheapest + fully maxed team previews as rank 1');
  assert.strictEqual(preview.b.rank, 3, 'priciest + weakest team previews as last');
  assert.strictEqual(preview.a.status, 'safe', 'rank 1 with demand to spare previews as safe (green)');
  assert.ok(preview.b.status === 'risk' || preview.b.status === 'caution', 'weakest team is not previewed as safe');

  // a team offering 0 units can never preview as anything but risk, regardless of score
  const zeroQtyTeams = teams.map((t) => (t.teamId === 'a' ? { ...t, quantity: 0 } : t));
  const preview2 = e.computeLivePreview({ teams: zeroQtyTeams, weights: e.CONFIG.WEIGHTS_DEFAULT, demandPerTeam: 200 });
  assert.strictEqual(preview2.a.status, 'risk', 'offering 0 units always previews as risk even with the best score');
  assert.strictEqual(preview2.a.predictedSold, 0, 'offering 0 units always predicts 0 sold');
}

console.log('All market-shock + live-preview checks passed.');

// 13) parseShockResponseText tolerates the messy ways an LLM actually replies
{
  const good = JSON.stringify({ title: 'Trade Winds Shift', icon: '🌏', description: 'A new export rule changes the math for Capacity this round.', effects: { capacityProductionMultiplier: 0.8 } });
  assert.ok(e.parseShockResponseText(good), 'plain clean JSON parses');
  assert.ok(e.parseShockResponseText('```json\n' + good + '\n```'), 'JSON wrapped in a ```json fence still parses');
  assert.ok(e.parseShockResponseText('Sure, here you go:\n' + good + '\nHope that helps!'), 'stray prose around the JSON is tolerated');
  assert.strictEqual(e.parseShockResponseText('not json at all'), null, 'pure garbage returns null, never throws');
  assert.strictEqual(e.parseShockResponseText('{ this is not: valid, json ]'), null, 'malformed JSON returns null, never throws');
  assert.strictEqual(e.parseShockResponseText(undefined), null, 'non-string input returns null, never throws');
  assert.strictEqual(e.parseShockResponseText('{"effects":{}}'), null, 'valid JSON missing required title/description still gets rejected by sanitizeShock');
}

console.log('All parseShockResponseText checks passed.');
