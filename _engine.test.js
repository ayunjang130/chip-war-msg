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
  const good = JSON.stringify({ title: 'Trade Winds Shift', description: 'A new export rule changes the math for Capacity this round.', effects: { capacityProductionMultiplier: 0.8 } });
  assert.ok(e.parseShockResponseText(good), 'plain clean JSON parses');
  assert.ok(e.parseShockResponseText('```json\n' + good + '\n```'), 'JSON wrapped in a ```json fence still parses');
  assert.ok(e.parseShockResponseText('Sure, here you go:\n' + good + '\nHope that helps!'), 'stray prose around the JSON is tolerated');
  assert.strictEqual(e.parseShockResponseText('not json at all'), null, 'pure garbage returns null, never throws');
  assert.strictEqual(e.parseShockResponseText('{ this is not: valid, json ]'), null, 'malformed JSON returns null, never throws');
  assert.strictEqual(e.parseShockResponseText(undefined), null, 'non-string input returns null, never throws');
  assert.strictEqual(e.parseShockResponseText('{"effects":{}}'), null, 'valid JSON missing required title/description still gets rejected by sanitizeShock');
}

console.log('All parseShockResponseText checks passed.');

// 14) calcUpgradeCost escalates 1.5x per purchase, and clamps at max level
{
  assert.strictEqual(e.calcUpgradeCost('tech', 0), 2000, 'first tech upgrade costs the base price');
  assert.strictEqual(e.calcUpgradeCost('tech', 1), 3000, 'second tech upgrade costs 1.5x base (2000*1.5)');
  assert.strictEqual(e.calcUpgradeCost('tech', 2), 4500, 'third tech upgrade costs 1.5^2 x base');
  approx(e.calcUpgradeCost('tech', 4), 10125, 'fifth tech upgrade follows the curve (2000*1.5^4)');
  assert.strictEqual(e.calcUpgradeCost('capacity', 0), 1500, 'first capacity upgrade costs the base price');
  assert.strictEqual(e.calcUpgradeCost('capacity', 1), 2250, 'second capacity upgrade costs 1.5x base (1500*1.5)');
  // level input is clamped so an out-of-range value can never crash or return nonsense
  assert.strictEqual(e.calcUpgradeCost('tech', 99), e.calcUpgradeCost('tech', 5), 'level above max clamps to max, does not extrapolate forever');
}

// 15) containsProfanity does whole-word matching only (no false positives on innocent words)
{
  assert.strictEqual(e.containsProfanity('this is a totally normal chat message'), false, 'clean message passes');
  assert.strictEqual(e.containsProfanity('my classmate has a glass of grass'), false, '"ass"-containing but innocent words are NOT false-flagged (class/glass/grass)');
  assert.strictEqual(e.containsProfanity('you are a Fucking idiot'), true, 'catches profanity regardless of capitalization');
  assert.strictEqual(e.containsProfanity('what the shit is going on'), true, 'catches profanity in the middle of a sentence');
  assert.strictEqual(e.containsProfanity(''), false, 'empty string is never flagged');
  assert.strictEqual(e.containsProfanity(undefined), false, 'non-string input never throws, just returns false');
}

console.log('All calcUpgradeCost + containsProfanity checks passed.');

// 16) calcMaxPrice blocks the "astronomical price" exploit while leaving real premium play intact
{
  assert.strictEqual(e.calcMaxPrice(50), 150, '3x ceiling over a $50 market price');
  assert.strictEqual(e.calcMaxPrice(0), 150, 'round 1 (no market price yet) falls back to the $50 reference (3x = 150)');
  assert.strictEqual(e.calcMaxPrice(-10), 150, 'a nonsensical negative reference still falls back safely');
  // the actual exploit scenario: demand exceeds supply, so EVERY offer sells regardless of rank
  const teams = [
    { teamId: 'exploiter', price: Math.min(999999, e.calcMaxPrice(50)), quantity: 50, techLevel: 0, capacityLevel: 0, lockOrder: 1 },
    { teamId: 'normal', price: 50, quantity: 50, techLevel: 2, capacityLevel: 2, lockOrder: 2 }
  ];
  const results = e.resolveApplePurchase({ teams, weights: e.CONFIG.WEIGHTS_DEFAULT, demandPerTeam: 200 }); // 400 total demand, only 100 offered - everyone sells
  const exploiter = results.find((r) => r.teamId === 'exploiter');
  assert.ok(exploiter.purchased > 0, 'the capped price still sells when supply < demand (legitimate premium play preserved)');
  assert.ok(exploiter.revenue < 999999 * 50, 'revenue is nowhere near the uncapped-exploit amount');
  approx(exploiter.price, 150, 'the clamp actually took effect at 3x, not the requested absurd number');
}

// 17) summarizeShockImpact always matches the real numbers and stays readable
{
  assert.strictEqual(e.summarizeShockImpact(null), '', 'no shock -> empty string, not a crash');
  const noop = e.summarizeShockImpact({ capacityProductionMultiplier: 1, techUpgradeCostMultiplier: 1, capacityUpgradeCostMultiplier: 1, demandMultiplier: 1, weightBias: { price: 1, tech: 1, capacity: 1 } });
  assert.strictEqual(noop, 'No numeric change this round.', 'an all-1.0 effects object reads as no change');
  const summary = e.summarizeShockImpact({ capacityProductionMultiplier: 0.6, techUpgradeCostMultiplier: 1, capacityUpgradeCostMultiplier: 1, demandMultiplier: 1, weightBias: { price: 1, tech: 1.8, capacity: 1 } });
  assert.ok(summary.includes('Capacity payoff -40%'), 'correctly reports a 40% capacity payoff cut');
  assert.ok(summary.includes('Tech weight +80%'), 'correctly reports an 80% tech weight increase');
  assert.ok(!summary.includes('Price weight'), 'fields that did not change are omitted, not padded with +0%');
}

console.log('All calcMaxPrice + summarizeShockImpact checks passed.');

// 18) Total Apple Demand scales correctly for every host-selectable team
// count (3-8) with the new default of 70/team, and allocation invariants
// (never exceed the pool, never exceed what a team offered) hold every time.
{
  const expectedTotals = { 3: 210, 4: 280, 5: 350, 6: 420, 7: 490, 8: 560 };
  Object.keys(expectedTotals).forEach((key) => {
    const teamCount = Number(key);
    const expectedTotal = expectedTotals[key];
    assert.strictEqual(teamCount * e.CONFIG.DEMAND_PER_TEAM, expectedTotal, `${teamCount} teams x ${e.CONFIG.DEMAND_PER_TEAM}/team should equal ${expectedTotal} - formula must never be hardcoded per team-count`);

    // Every team offers 100 units (the default production floor) so total
    // supply (teamCount*100) exceeds total demand whenever teamCount < 10 -
    // exactly the scenario the pool has to ration.
    const teams = [];
    for (let i = 0; i < teamCount; i++) {
      teams.push({ teamId: 't' + i, price: 40 + i * 5, quantity: 100, techLevel: Math.max(0, 5 - i), capacityLevel: Math.max(0, 5 - i), lockOrder: i });
    }
    const results = e.resolveApplePurchase({ teams, weights: e.CONFIG.WEIGHTS_DEFAULT, demandPerTeam: e.CONFIG.DEMAND_PER_TEAM });
    const totalPurchased = results.reduce((s, r) => s + r.purchased, 0);

    assert.strictEqual(totalPurchased, expectedTotal, `${teamCount} teams: total units sold (${totalPurchased}) must exactly fill the ${expectedTotal}-unit pool, never more`);
    results.forEach((r) => {
      assert.ok(r.purchased <= 100, `${teamCount} teams: no team ever sells more than it offered/had in inventory`);
      assert.ok(r.purchased >= 0, `${teamCount} teams: never a negative sale`);
    });
    const lowestRanked = results[results.length - 1];
    assert.ok(lowestRanked.purchased < 100, `${teamCount} teams: the lowest-scoring team never sells its full offer once the pool runs out - competition is real, not everyone just sells 100`);
  });

  // The exact worked example from the spec: 5 teams, 70/team -> 350 total,
  // supply 500 -> allocation should land on 100/100/100/50/0.
  {
    const teams = [0, 1, 2, 3, 4].map((i) => ({ teamId: 'team' + i, price: 40 + i * 5, quantity: 100, techLevel: 5 - i, capacityLevel: 5 - i, lockOrder: i }));
    const results = e.resolveApplePurchase({ teams, weights: e.CONFIG.WEIGHTS_DEFAULT, demandPerTeam: 70 });
    const sold = results.map((r) => r.purchased);
    assert.deepStrictEqual(sold, [100, 100, 100, 50, 0], '5-team worked example matches the spec exactly: A/B/C sell out, D gets the remainder, E gets nothing');
  }
}

console.log('All Total-Apple-Demand (3-8 team) checks passed.');

// 19) shockCategoryTag always returns one of a fixed, professional-looking
// set of tags - never emoji, never missing, regardless of source.
{
  assert.strictEqual(e.shockCategoryTag(null), 'MARKET', 'no effects -> MARKET fallback, never a crash');
  assert.strictEqual(e.shockCategoryTag({ capacityProductionMultiplier: 0.6 }), 'CAPACITY');
  assert.strictEqual(e.shockCategoryTag({ techUpgradeCostMultiplier: 1.8 }), 'COST');
  assert.strictEqual(e.shockCategoryTag({ capacityUpgradeCostMultiplier: 0.5 }), 'COST');
  assert.strictEqual(e.shockCategoryTag({ demandMultiplier: 0.6 }), 'DEMAND');
  assert.strictEqual(e.shockCategoryTag({ weightBias: { tech: 2 } }), 'PRIORITY');
  assert.strictEqual(e.shockCategoryTag({}), 'MARKET', 'an all-default effects object reads as MARKET, not a crash');

  const validTags = new Set(['MARKET', 'CAPACITY', 'COST', 'DEMAND', 'PRIORITY']);
  // Every procedural template, drawn many times, must sanitize to a shock
  // with a real title/description and a valid tag - and never an `icon`
  // field, confirming the emoji concept is fully gone from the data shape.
  for (let i = 0; i < 40; i++) {
    const s = e.pickProceduralShock([]);
    assert.ok(validTags.has(s.categoryTag), `procedural shock has a valid categoryTag, got "${s.categoryTag}"`);
    assert.strictEqual(s.icon, undefined, 'procedural shocks no longer carry an icon field at all');
  }
  assert.strictEqual(e.NEUTRAL_SHOCK.icon, undefined, 'NEUTRAL_SHOCK no longer carries an icon field either');
}

console.log('All shockCategoryTag checks passed.');
