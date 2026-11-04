// Rune Row solver. Pure logic, no DOM; loaded by index.html and by tests/simulate.js.
// A card is a bit in a 24-bit mask: id = colour * 8 + (number - 1). A state is (hand, deck),
// where deck is the set of unseen cards. Everything unseen is in the deck, so its contents
// are known exactly and only the order is unknown.
(function (root) {
  'use strict';

  const NUMBERS = 8, COLOURS = 3, ALL = (1 << 24) - 1;
  const cardId = (colour, number) => colour * NUMBERS + (number - 1);
  const colourOf = (id) => Math.floor(id / NUMBERS);
  const numberOf = (id) => (id % NUMBERS) + 1;

  // Point rules, read off the in-game table: colour run 60-110, triple 30-100, mixed run 10-60.
  const COMBOS = [];
  const addCombo = (a, b, c, type, pts) =>
    COMBOS.push({ mask: (1 << a) | (1 << b) | (1 << c), cards: [a, b, c], type, pts });
  for (let s = 1; s <= 6; s++) {
    for (let x = 0; x < COLOURS; x++) for (let y = 0; y < COLOURS; y++) for (let z = 0; z < COLOURS; z++) {
      const a = cardId(x, s), b = cardId(y, s + 1), c = cardId(z, s + 2);
      if (x === y && y === z) addCombo(a, b, c, 'colour', 50 + 10 * s);
      else addCombo(a, b, c, 'mixed', 10 * s);
    }
  }
  for (let n = 1; n <= 8; n++) addCombo(cardId(0, n), cardId(1, n), cardId(2, n), 'triple', 20 + 10 * n);

  const N = COMBOS.length;
  const C_MASK = new Int32Array(N), C_PTS = new Int32Array(N), C_TYPE = new Int8Array(N);
  COMBOS.forEach((c, i) => {
    C_MASK[i] = c.mask; C_PTS[i] = c.pts;
    C_TYPE[i] = c.type === 'colour' ? 0 : c.type === 'triple' ? 1 : 2;
  });
  const BY_CARD = Array.from({ length: 24 }, () => []);
  COMBOS.forEach((c, i) => c.cards.forEach((id) => BY_CARD[id].push(i)));
  const BY_CARD_T = BY_CARD.map((l) => Int32Array.from(l));

  const popcount = (v) => {
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  const lowBit = (v) => 31 - Math.clz32(v & -v);
  const cardsOf = (mask) => { const r = []; for (let m = mask; m; m &= m - 1) r.push(lowBit(m)); return r; };

  // Small seeded RNG so simulations are reproducible.
  function makeRng(seed) {
    let s = seed >>> 0 || 88172645;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  }

  // Fast playing rule used inside simulations. Weights are tuned by `simulate.js tune`.
  const DEFAULT_PARAMS = { w1: 0.035, w2: 0.079, w3: 0.047, tMixed: 84, tTriple: 6, tEnd: 1, beta: 0.7 };

  function keepValue(id, hand, avail, p) {
    let v = 0;
    const list = BY_CARD_T[id];
    for (let i = 0; i < list.length; i++) {
      const k = list[i], m = C_MASK[k];
      if ((m & avail) !== m) continue;
      const held = popcount(m & hand);
      v += C_PTS[k] * (held === 3 ? p.w3 : held === 2 ? p.w2 : p.w1);
    }
    return v;
  }

  // Returns a combo index >= 0 to play, -1 - cardId to discard, or -1000 to stop.
  function policy(hand, deck, deckSize, p) {
    const avail = hand | deck;
    const late = deckSize <= p.tEnd;
    let best = -1, bestScore = -1;
    for (let k = 0; k < N; k++) {
      const m = C_MASK[k];
      if ((hand & m) !== m) continue;
      const min = late || C_TYPE[k] === 0 ? 0 : C_TYPE[k] === 1 ? p.tTriple : p.tMixed;
      if (C_PTS[k] < min) continue;
      let s = C_PTS[k];
      for (let r = hand & ~m; r; r &= r - 1) s += p.beta * keepValue(lowBit(r), hand & ~m, avail & ~m, p);
      if (s > bestScore) { bestScore = s; best = k; }
    }
    if (best >= 0) return best;
    if (deckSize === 0) return -1000;
    let worst = -1, worstV = Infinity;
    for (let r = hand; r; r &= r - 1) {
      const id = lowBit(r), v = keepValue(id, hand, avail, p);
      if (v < worstV) { worstV = v; worst = id; }
    }
    return -1 - worst;
  }

  // Exact expectimax for short decks. Value = best expected points still to come.
  const memo = new Map();
  const MEMO_LIMIT = 4000000;
  function exactValue(hand, deck) {
    const key = hand * 16777216 + deck;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let best = 0;
    for (let k = 0; k < N; k++) {
      const m = C_MASK[k];
      if ((hand & m) !== m) continue;
      const v = C_PTS[k] + expectDraw(hand & ~m, deck, 3);
      if (v > best) best = v;
    }
    if (deck) for (let r = hand; r; r &= r - 1) {
      const v = expectDraw(hand & ~(r & -r), deck, 1);
      if (v > best) best = v;
    }
    if (memo.size > MEMO_LIMIT) memo.clear();
    memo.set(key, best);
    return best;
  }
  function expectDraw(hand, deck, count) {
    const cards = cardsOf(deck), n = cards.length;
    if (n === 0) return exactValue(hand, 0);
    if (n <= count) return exactValue(hand | deck, 0);
    let sum = 0, ways = 0;
    if (count === 1) {
      for (let i = 0; i < n; i++) { const b = 1 << cards[i]; sum += exactValue(hand | b, deck & ~b); ways++; }
    } else {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let l = j + 1; l < n; l++) {
        const b = (1 << cards[i]) | (1 << cards[j]) | (1 << cards[l]);
        sum += exactValue(hand | b, deck & ~b); ways++;
      }
    }
    return sum / ways;
  }

  // Plays one game out from (hand, order[pos..]) and returns the points scored.
  function rollout(hand, deck, order, pos, p, exactAt) {
    let pts = 0, deckSize = order.length - pos;
    while (true) {
      if (deckSize <= exactAt) return pts + exactValue(hand, deck);
      const a = policy(hand, deck, deckSize, p);
      if (a === -1000) return pts;
      let draw;
      if (a >= 0) { pts += C_PTS[a]; hand &= ~C_MASK[a]; draw = 3; }
      else { hand &= ~(1 << (-1 - a)); draw = 1; }
      for (; draw > 0 && deckSize > 0; draw--, deckSize--) {
        const b = 1 << order[pos++];
        hand |= b; deck &= ~b;
      }
    }
  }

  function legalActions(hand, deck) {
    const acts = [];
    for (let k = 0; k < N; k++) if ((hand & C_MASK[k]) === C_MASK[k]) acts.push({ kind: 'play', combo: k, pts: C_PTS[k] });
    if (deck) for (const id of cardsOf(hand)) acts.push({ kind: 'discard', card: id, pts: 0 });
    return acts;
  }

  function afterAction(hand, a) {
    return a.kind === 'play' ? { hand: hand & ~C_MASK[a.combo], draw: 3 } : { hand: hand & ~(1 << a.card), draw: 1 };
  }

  // Ranks every legal move. Short decks are solved exactly; longer ones are simulated with
  // the same shuffles for each move, so differences between moves stay low-noise.
  // Call step() until it returns false, then read result().
  function createAnalysis(hand, deck, opts = {}) {
    const p = opts.params || DEFAULT_PARAMS;
    const exactAt = opts.exactAt === undefined ? 4 : opts.exactAt;
    const solveAt = opts.solveAt === undefined ? 7 : opts.solveAt;
    const rng = opts.rng || makeRng((hand ^ (deck * 31) ^ 0x9e3779b9) >>> 0);
    const maxRounds = opts.maxRounds || Infinity;
    const acts = legalActions(hand, deck).map((a) => ({ ...a, n: 0, sum: 0, sq: 0, alive: true, hist: new Int32Array(66) }));
    const deckCards = cardsOf(deck);
    const exact = deckCards.length <= solveAt;
    let rounds = 0;

    if (exact) for (const a of acts) {
      const after = afterAction(hand, a);
      a.value = a.pts + expectDraw(after.hand, deck, after.draw);
    }

    function round() {
      const order = deckCards.slice();
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1)), t = order[i];
        order[i] = order[j]; order[j] = t;
      }
      for (const a of acts) {
        if (!a.alive) continue;
        const after = afterAction(hand, a);
        let h = after.hand, d = deck, pos = 0;
        for (let draw = after.draw; draw > 0 && pos < order.length; draw--) { h |= 1 << order[pos]; d &= ~(1 << order[pos]); pos++; }
        const v = a.pts + rollout(h, d, order, pos, p, exactAt);
        a.n++; a.sum += v; a.sq += v * v;
        a.hist[Math.min(65, Math.round(v / 10))]++;
      }
      rounds++;
    }

    const sem2 = (a) => Math.max(0, a.sq / a.n - (a.sum / a.n) ** 2) / a.n;
    function prune() {
      const live = acts.filter((a) => a.alive);
      if (live.length < 2 || rounds < 200) return;
      const lead = live.reduce((x, y) => (y.sum / y.n > x.sum / x.n ? y : x));
      for (const a of live) {
        if (a === lead) continue;
        if (lead.sum / lead.n - a.sum / a.n > 4 * Math.sqrt(sem2(a) + sem2(lead))) a.alive = false;
      }
    }

    return {
      exact,
      // Runs up to `batch` rounds; returns false when there is nothing more to learn.
      step(batch = 100) {
        if (exact || !acts.length || rounds >= maxRounds) return false;
        for (let i = 0; i < batch && rounds < maxRounds; i++) round();
        prune();
        return true;
      },
      rounds: () => rounds,
      result() {
        const list = acts.map((a) => ({
          kind: a.kind, combo: a.combo, card: a.card, pts: a.pts,
          value: exact ? a.value : (a.n ? a.sum / a.n : 0),
          se: exact || !a.n ? 0 : Math.sqrt(sem2(a)),
          hist: a.hist, samples: a.n,
        }));
        list.sort((x, y) => y.value - x.value);
        return list;
      },
    };
  }

  function bestMoveSync(hand, deck, rounds, rng, extra = {}) {
    if (!legalActions(hand, deck).length) return null;
    const an = createAnalysis(hand, deck, { maxRounds: rounds, rng, ...extra });
    while (an.step(50));
    return an.result()[0];
  }

  // Plays a whole game. chooser(hand, deck, deckSize) returns a move, or null to stop.
  function playGame(rng, chooser) {
    const order = Array.from({ length: 24 }, (_, i) => i);
    for (let i = 23; i > 0; i--) { const j = Math.floor(rng() * (i + 1)), t = order[i]; order[i] = order[j]; order[j] = t; }
    let hand = 0, deck = ALL, pos = 0, pts = 0;
    const draw = (k) => { for (; k > 0 && pos < 24; k--) { const b = 1 << order[pos++]; hand |= b; deck &= ~b; } };
    draw(5);
    while (true) {
      const a = chooser(hand, deck, 24 - pos);
      if (!a) return pts;
      if (a.kind === 'play') { pts += C_PTS[a.combo]; hand &= ~C_MASK[a.combo]; draw(3); }
      else { hand &= ~(1 << a.card); draw(1); }
    }
  }

  const heuristicChooser = (p = DEFAULT_PARAMS) => (hand, deck, n) => {
    const a = policy(hand, deck, n, p);
    if (a === -1000) return null;
    return a >= 0 ? { kind: 'play', combo: a } : { kind: 'discard', card: -1 - a };
  };

  root.RuneRow = {
    NUMBERS, COLOURS, ALL, COMBOS, cardId, colourOf, numberOf, cardsOf, popcount, makeRng,
    DEFAULT_PARAMS, createAnalysis, bestMoveSync, legalActions, playGame, heuristicChooser,
    clearMemo: () => memo.clear(),
  };
})(typeof module !== 'undefined' ? module.exports : window);
