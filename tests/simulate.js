// Measures the solver on simulated games.
// Usage: node tests/simulate.js check | tune [iterations] | full [games] [rounds per move]
const R = require('../engine.js').RuneRow;
const [mode = 'check', a1, a2] = process.argv.slice(2);

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b), n = s.length, m = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  return { n, mean: +m.toFixed(1), se: +(sd / Math.sqrt(n)).toFixed(1), p10: s[n * 0.1 | 0], p50: s[n >> 1], p90: s[n * 0.9 | 0], max: s[n - 1] };
}
const run = (games, seed, chooser) => {
  const rng = R.makeRng(seed), out = [];
  for (let i = 0; i < games; i++) out.push(R.playGame(rng, chooser));
  return out;
};

if (mode === 'check') {
  const by = {};
  for (const c of R.COMBOS) (by[c.type] ||= []).push(c.pts);
  for (const t in by) console.log(t, 'count', by[t].length, 'range', Math.min(...by[t]), Math.max(...by[t]));
  const rr = R.makeRng(7);
  const random = (h, d) => { const l = R.legalActions(h, d); return l.length ? l[Math.floor(rr() * l.length)] : null; };
  console.log('random   ', stats(run(20000, 1, random)));
  // Greedy: always play the best set available, otherwise discard at random.
  const greedy = (h, d) => {
    const l = R.legalActions(h, d), plays = l.filter((a) => a.kind === 'play');
    if (plays.length) return plays.reduce((x, y) => (y.pts > x.pts ? y : x));
    return l.length ? l[Math.floor(rr() * l.length)] : null;
  };
  console.log('greedy   ', stats(run(20000, 2, greedy)));
  console.log('heuristic', stats(run(20000, 3, R.heuristicChooser())));
}

if (mode === 'tune') {
  const rng = R.makeRng(1234);
  let best = { ...R.DEFAULT_PARAMS }, bestScore = stats(run(4000, 99, R.heuristicChooser(best))).mean;
  console.log('start', bestScore);
  const jitter = (v) => v * (0.6 + rng() * 0.8);
  for (let it = 0; it < (+a1 || 150); it++) {
    const c = { ...best };
    for (const k of Object.keys(c)) if (rng() < 0.4) c[k] = jitter(c[k]);
    c.tEnd = Math.round(c.tEnd);
    const s = stats(run(4000, 99, R.heuristicChooser(c))).mean;
    if (s > bestScore) { bestScore = s; best = c; console.log(it, s); }
  }
  console.log('validation (fresh games)', stats(run(20000, 5, R.heuristicChooser(best))));
  console.log(JSON.stringify(best));
}

if (mode === 'verify') {
  // The exact solver's predicted value must match the average of actually playing its moves.
  const rng = R.makeRng(2024);
  const shuffled = () => { const o = Array.from({ length: 24 }, (_, i) => i); for (let i = 23; i > 0; i--) { const j = Math.floor(rng() * (i + 1)), t = o[i]; o[i] = o[j]; o[j] = t; } return o; };
  for (let t = 0; t < 5; t++) {
    const o = shuffled(), bit = (l) => l.reduce((m, c) => m | (1 << c), 0);
    const hand0 = bit(o.slice(0, 5)), deck0 = bit(o.slice(5, 11));
    const predicted = R.createAnalysis(hand0, deck0).result()[0].value;
    let sum = 0; const games = 4000;
    for (let g = 0; g < games; g++) {
      let hand = hand0, deck = deck0, pts = 0;
      while (true) {
        const a = R.createAnalysis(hand, deck).result()[0];
        if (!a) break;
        if (a.value <= 0) break;
        let draw = 1;
        if (a.kind === 'play') { pts += a.pts; hand &= ~R.COMBOS[a.combo].mask; draw = 3; } else hand &= ~(1 << a.card);
        const left = R.cardsOf(deck);
        for (; draw > 0 && left.length; draw--) { const c = left.splice(Math.floor(rng() * left.length), 1)[0]; hand |= 1 << c; deck &= ~(1 << c); }
      }
      sum += pts;
    }
    console.log(`position ${t}: predicted ${predicted.toFixed(1)}, played ${(sum / games).toFixed(1)}`);
  }
  // Slowest exact solve: a cold cache at the largest deck solved exactly.
  let worst = 0;
  for (let t = 0; t < 10; t++) {
    const o = shuffled(), bit = (l) => l.reduce((m, c) => m | (1 << c), 0);
    R.clearMemo();
    const t0 = Date.now(); R.createAnalysis(bit(o.slice(0, 5)), bit(o.slice(5, 12))); worst = Math.max(worst, Date.now() - t0);
  }
  console.log('slowest exact solve at deck 7:', worst, 'ms');
  // Simulation speed from a full deck.
  const o = shuffled(), bit = (l) => l.reduce((m, c) => m | (1 << c), 0);
  const an = R.createAnalysis(bit(o.slice(0, 5)), bit(o.slice(5))), t1 = Date.now();
  while (Date.now() - t1 < 1000) an.step(50);
  console.log('rounds per second from a full deck:', an.rounds());
}

if (mode === 'full') {
  const games = +a1 || 50, rounds = +a2 || 500, rng = R.makeRng(42), out = [], t0 = Date.now();
  for (let i = 0; i < games; i++) out.push(R.playGame(rng, (h, d) => R.bestMoveSync(h, d, rounds, rng)));
  console.log(`full rounds=${rounds}`, stats(out), ((Date.now() - t0) / games / 1000).toFixed(1) + 's/game');
}
