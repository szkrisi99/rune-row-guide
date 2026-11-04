// Measures the solver on simulated games.
// Usage: node tests/simulate.js check | verify | tune [iterations] | matrix [games] [rounds per move]
const R = require('../engine.js').RuneRow;
const [mode = 'check', a1, a2] = process.argv.slice(2);

// The rules the real game might be using: how likely gone cards are to come back.
const TRUTHS = {
  'no returns      ': { d: 0, p: 0 },
  'discards return ': { d: 1, p: 0 },
  'all return      ': { d: 1, p: 1 },
  'some return (.3)': { d: 0.3, p: 0.3 },
};
const GUIDES = { 'assume none': { d: 0, p: 0 }, 'assume .25': { d: 0.25, p: 0.25 }, 'assume .5': { d: 0.5, p: 0.5 }, 'assume 1': { d: 1, p: 1 } };

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b), n = s.length, m = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return { n, mean: +m.toFixed(1), se: +(sd / Math.sqrt(n)).toFixed(1), p10: s[n * 0.1 | 0], p50: s[n >> 1], p90: s[n * 0.9 | 0], max: s[n - 1] };
}
const run = (games, seed, chooser, truth) => {
  const rng = R.makeRng(seed), out = [];
  for (let i = 0; i < games; i++) out.push(R.playGame(rng, chooser, truth));
  return out;
};

if (mode === 'check') {
  const by = {};
  for (const c of R.COMBOS) (by[c.type] ||= []).push(c.pts);
  for (const t in by) console.log(t, 'count', by[t].length, 'range', Math.min(...by[t]), Math.max(...by[t]));
  for (const [name, truth] of Object.entries(TRUTHS)) {
    const rr = R.makeRng(7);
    const random = (pos) => { const l = R.legalActions(pos.hand, pos.k); return l.length ? l[Math.floor(rr() * l.length)] : null; };
    const greedy = (pos) => {
      const l = R.legalActions(pos.hand, pos.k), plays = l.filter((a) => a.kind === 'play');
      if (plays.length) return plays.reduce((x, y) => (y.pts > x.pts ? y : x));
      return l.length ? l[Math.floor(rr() * l.length)] : null;
    };
    console.log(name, 'random', stats(run(10000, 1, random, truth)).mean, 'greedy', stats(run(10000, 2, greedy, truth)).mean,
      'heuristic', stats(run(10000, 3, R.heuristicChooser(truth), truth)).mean);
  }
}

if (mode === 'verify') {
  // The exact solver's predicted value must match the average of actually playing its moves.
  const rng = R.makeRng(2024);
  for (let t = 0; t < 5; t++) {
    const model = t % 2 ? { d: 0.5, p: 0.5 } : { d: 1, p: 0.2 };
    const order = Array.from({ length: 24 }, (_, i) => i);
    for (let i = 23; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const bit = (l) => l.reduce((m, c) => m | (1 << c), 0);
    const start = { hand: bit(order.slice(0, 5)), discarded: bit(order.slice(5, 11)), played: bit(order.slice(11, 17)), k: 2 };
    const predicted = R.createAnalysis(start, { model }).result()[0].value;
    let sum = 0; const games = +a1 || 3000;
    for (let g = 0; g < games; g++) {
      const pos = { ...start };
      let pts = 0;
      while (true) {
        const a = R.createAnalysis(pos, { model }).result()[0];
        if (!a || a.value <= 0) break;
        let draw = 1;
        if (a.kind === 'play') {
          const c = R.COMBOS[a.combo];
          pts += a.pts; pos.hand &= ~c.mask; pos.played |= c.mask; pos.discarded &= ~c.mask; draw = 3;
        } else { pos.hand &= ~(1 << a.card); pos.discarded |= 1 << a.card; pos.played &= ~(1 << a.card); }
        for (; draw > 0 && pos.k > 0; draw--) {
          const list = R.drawChances(pos, model);
          let x = rng(), c = list[list.length - 1].card;
          for (const e of list) { x -= e.chance; if (x < 0) { c = e.card; break; } }
          pos.hand |= 1 << c; pos.discarded &= ~(1 << c); pos.played &= ~(1 << c); pos.k--;
        }
      }
      sum += pts;
    }
    console.log(`position ${t}: predicted ${predicted.toFixed(1)}, played ${(sum / games).toFixed(1)}`);
  }
  // Slowest exact solve and simulation speed.
  const bit = (l) => l.reduce((m, c) => m | (1 << c), 0);
  let worst = 0;
  for (let t = 0; t < 10; t++) {
    const o = Array.from({ length: 24 }, (_, i) => i).sort(() => rng() - 0.5);
    const t0 = Date.now();
    R.createAnalysis({ hand: bit(o.slice(0, 5)), discarded: bit(o.slice(5, 12)), played: bit(o.slice(12, 18)), k: 2 });
    worst = Math.max(worst, Date.now() - t0);
  }
  console.log('slowest exact solve with 2 draws left:', worst, 'ms');
  const o = Array.from({ length: 24 }, (_, i) => i).sort(() => rng() - 0.5);
  const an = R.createAnalysis({ hand: bit(o.slice(0, 5)), k: 19 }), t1 = Date.now();
  while (Date.now() - t1 < 1000) an.step(25);
  console.log('rounds per second from the start of a game:', an.rounds());
}

if (mode === 'tune') {
  const rng = R.makeRng(1234), truth = { d: 0.5, p: 0.5 };
  const score = (c, games, seed) => stats(run(games, seed, R.heuristicChooser(truth, c), truth)).mean;
  let best = { ...R.DEFAULT_PARAMS }, bestScore = score(best, 4000, 99);
  console.log('start', bestScore);
  for (let it = 0; it < (+a1 || 100); it++) {
    const c = { ...best };
    for (const k of Object.keys(c)) if (rng() < 0.4) c[k] *= 0.6 + rng() * 0.8;
    c.tEnd = Math.round(c.tEnd);
    const s = score(c, 4000, 99);
    if (s > bestScore) { bestScore = s; best = c; console.log(it, s); }
  }
  console.log('fresh games', score(best, 20000, 5), 'vs start', score(R.DEFAULT_PARAMS, 20000, 5));
  console.log(JSON.stringify(best));
}

if (mode === 'matrix') {
  // Each guide assumption against each possible true rule, so we can see what a wrong guess costs.
  const games = +a1 || 150, rounds = +a2 || 200;
  for (const [tName, truth] of Object.entries(TRUTHS)) {
    const line = [];
    for (const [gName, model] of Object.entries(GUIDES)) {
      const rng = R.makeRng(42), out = [];
      for (let i = 0; i < games; i++) out.push(R.playGame(rng, (pos) => R.bestMoveSync(pos, rounds, rng, { model }), truth));
      const s = stats(out);
      line.push(`${gName}: ${s.mean}±${s.se}`);
    }
    console.log(tName, '|', line.join(' | '));
  }
}
