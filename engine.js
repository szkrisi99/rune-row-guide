// Rune Row solver. Pure logic, no DOM; loaded by index.html and by tests/simulate.js.
// A card is a bit in a 24-bit mask: id = colour * 8 + (number - 1).
// The game always deals 24 cards in total, but cards that already left the hand can come back,
// and the exact rule is unknown. So a state is the hand, the number of draws left (k), and a weight
// per card for how likely it is to be the next draw: unseen cards weigh 1, discarded cards model.d,
// played cards model.p, and cards in hand 0.
(function (root) {
  'use strict';

  const NUMBERS = 8, COLOURS = 3, CARDS = 24, TOTAL_DEAL = 24, ALL = (1 << CARDS) - 1;
  const cardId = (colour, number) => colour * NUMBERS + (number - 1);
  const colourOf = (id) => Math.floor(id / NUMBERS);
  const numberOf = (id) => (id % NUMBERS) + 1;

  // How strongly gone cards are assumed to come back. Zero means each card appears once, which is what
  // the last verified game showed. If a real game disproves it, `simulate.js matrix` compares the options.
  const DEFAULT_MODEL = { d: 0, p: 0 };

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
  const C_A = new Int8Array(N), C_B = new Int8Array(N), C_C = new Int8Array(N);
  COMBOS.forEach((c, i) => {
    C_MASK[i] = c.mask; C_PTS[i] = c.pts;
    C_TYPE[i] = c.type === 'colour' ? 0 : c.type === 'triple' ? 1 : 2;
    C_A[i] = c.cards[0]; C_B[i] = c.cards[1]; C_C[i] = c.cards[2];
  });
  const BY_CARD = Array.from({ length: CARDS }, () => []);
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

  // Per-card draw weights for a position. discarded and played are masks of gone cards.
  function makeWeights(hand, discarded, played, model) {
    const w = new Float64Array(CARDS);
    for (let c = 0; c < CARDS; c++) {
      const b = 1 << c;
      w[c] = hand & b ? 0 : played & b ? model.p : discarded & b ? model.d : 1;
    }
    return w;
  }

  // Fast playing rule used inside simulations. Weights are tuned by `simulate.js tune`.
  const DEFAULT_PARAMS = { w1: 0.035, w2: 0.079, w3: 0.047, tMixed: 84, tTriple: 6, tEnd: 1, beta: 0.7 };

  function keepValue(id, hand, W, p) {
    let v = 0;
    const list = BY_CARD_T[id];
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      let f = 1, held = 0;
      const a = C_A[k], b = C_B[k], c = C_C[k];
      if (hand & (1 << a)) held++; else f *= W[a];
      if (hand & (1 << b)) held++; else f *= W[b];
      if (hand & (1 << c)) held++; else f *= W[c];
      if (f === 0) continue;
      v += C_PTS[k] * f * (held === 3 ? p.w3 : held === 2 ? p.w2 : p.w1);
    }
    return v;
  }

  function bestPlay(hand) {
    let best = -1, pts = -1;
    for (let k = 0; k < N; k++) if ((hand & C_MASK[k]) === C_MASK[k] && C_PTS[k] > pts) { pts = C_PTS[k]; best = k; }
    return best;
  }

  // Returns a combo index >= 0 to play, -1 - cardId to discard, or -1000 to stop.
  function policy(hand, W, k, p) {
    if (k === 0) { const b = bestPlay(hand); return b >= 0 ? b : -1000; }
    const late = k <= p.tEnd;
    let best = -1, bestScore = -1;
    for (let i = 0; i < N; i++) {
      const m = C_MASK[i];
      if ((hand & m) !== m) continue;
      const min = late || C_TYPE[i] === 0 ? 0 : C_TYPE[i] === 1 ? p.tTriple : p.tMixed;
      if (C_PTS[i] < min) continue;
      let s = C_PTS[i];
      for (let r = hand & ~m; r; r &= r - 1) s += p.beta * keepValue(lowBit(r), hand & ~m, W, p);
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best >= 0) return best;
    let worst = -1, worstV = Infinity;
    for (let r = hand; r; r &= r - 1) {
      const id = lowBit(r), v = keepValue(id, hand, W, p);
      if (v < worstV) { worstV = v; worst = id; }
    }
    return worst >= 0 ? -1 - worst : -1000;
  }

  // Picks a card by weight with u in [0, 1). Returns -1 if nothing can be drawn.
  function pick(W, u) {
    let total = 0;
    for (let c = 0; c < CARDS; c++) total += W[c];
    if (total <= 0) return -1;
    let x = u * total;
    for (let c = 0; c < CARDS; c++) {
      if (W[c] > 0) { x -= W[c]; if (x < 0) return c; }
    }
    for (let c = CARDS - 1; c >= 0; c--) if (W[c] > 0) return c;
    return -1;
  }

  // Plays one game out and returns the points scored. W is overwritten.
  function rollout(hand, W, k, us, pos, p, model) {
    let pts = 0;
    while (true) {
      const a = policy(hand, W, k, p);
      if (a === -1000) return pts;
      let draw;
      if (a >= 0) {
        pts += C_PTS[a];
        hand &= ~C_MASK[a];
        W[C_A[a]] = model.p; W[C_B[a]] = model.p; W[C_C[a]] = model.p;
        draw = 3;
      } else {
        const id = -1 - a;
        hand &= ~(1 << id);
        W[id] = model.d;
        draw = 1;
      }
      if (k === 0) return pts;
      for (; draw > 0 && k > 0; draw--) {
        const c = pick(W, us[pos++]);
        if (c < 0) { k = 0; break; }
        hand |= 1 << c; W[c] = 0; k--;
      }
    }
  }

  // Exact expectimax for the last few draws. Value = best expected points still to come.
  function exactValue(hand, W, k, model) {
    if (k === 0) { const b = bestPlay(hand); return b >= 0 ? C_PTS[b] : 0; }
    let best = 0;
    for (let i = 0; i < N; i++) {
      const m = C_MASK[i];
      if ((hand & m) !== m) continue;
      const w2 = W.slice();
      w2[C_A[i]] = model.p; w2[C_B[i]] = model.p; w2[C_C[i]] = model.p;
      const v = C_PTS[i] + expectDraw(hand & ~m, w2, k, Math.min(3, k), model);
      if (v > best) best = v;
    }
    for (let r = hand; r; r &= r - 1) {
      const id = lowBit(r), w2 = W.slice();
      w2[id] = model.d;
      const v = expectDraw(hand & ~(1 << id), w2, k, 1, model);
      if (v > best) best = v;
    }
    return best;
  }
  function expectDraw(hand, W, k, count, model) {
    if (count === 0 || k === 0) return exactValue(hand, W, k, model);
    let total = 0, sum = 0;
    for (let c = 0; c < CARDS; c++) {
      const w = W[c];
      if (w <= 0) continue;
      const w2 = W.slice();
      w2[c] = 0;
      total += w;
      sum += w * expectDraw(hand | (1 << c), w2, k - 1, count - 1, model);
    }
    return total > 0 ? sum / total : exactValue(hand, W, 0, model);
  }

  // A card held twice is one bit in the hand mask plus one bit in dup, so spending one copy keeps the card.
  function legalActions(hand, k) {
    const acts = [];
    for (let i = 0; i < N; i++) if ((hand & C_MASK[i]) === C_MASK[i]) acts.push({ kind: 'play', combo: i, pts: C_PTS[i] });
    if (k > 0) for (const id of cardsOf(hand)) acts.push({ kind: 'discard', card: id, pts: 0 });
    return acts;
  }

  function afterAction(hand, W, a, model, dup) {
    const w = W.slice();
    if (a.kind === 'play') {
      const c = COMBOS[a.combo];
      for (const id of c.cards) w[id] = dup & (1 << id) ? 0 : model.p;
      return { hand: (hand & ~c.mask) | (dup & c.mask), w, draw: 3 };
    }
    if (dup & (1 << a.card)) return { hand, w, draw: 1 };
    w[a.card] = model.d;
    return { hand: hand & ~(1 << a.card), w, draw: 1 };
  }

  // Ranks every legal move. With few draws left it is solved exactly; otherwise simulated with the
  // same random numbers for each move, so differences between moves stay low-noise.
  // position: { hand, discarded, played, k, dup }. Call step() until it returns false, then result().
  function createAnalysis(position, opts = {}) {
    const { hand, k, discarded = 0, played = 0, dup = 0 } = position;
    const model = opts.model || DEFAULT_MODEL;
    const p = opts.params || DEFAULT_PARAMS;
    const solveAt = opts.solveAt === undefined ? 2 : opts.solveAt;
    const rng = opts.rng || makeRng((hand ^ (discarded * 31) ^ (played * 17) ^ (k * 131) ^ 0x9e3779b9) >>> 0);
    const maxRounds = opts.maxRounds || Infinity;
    const W = makeWeights(hand, discarded, played, model);
    const acts = legalActions(hand, k).map((a) => ({ ...a, n: 0, sum: 0, sq: 0, alive: true }));
    const exact = k <= solveAt;
    const us = new Float64Array(k + 8);
    const scratch = new Float64Array(CARDS);
    let rounds = 0;

    if (exact) for (const a of acts) {
      const after = afterAction(hand, W, a, model, dup);
      a.value = a.pts + expectDraw(after.hand, after.w, k, Math.min(after.draw, k), model);
    }

    function round() {
      for (let i = 0; i < us.length; i++) us[i] = rng();
      for (const a of acts) {
        if (!a.alive) continue;
        const after = afterAction(hand, W, a, model, dup);
        scratch.set(after.w);
        let h = after.hand, left = k, pos = 0;
        for (let draw = after.draw; draw > 0 && left > 0; draw--) {
          const c = pick(scratch, us[pos++]);
          if (c < 0) { left = 0; break; }
          h |= 1 << c; scratch[c] = 0; left--;
        }
        const v = a.pts + rollout(h, scratch, left, us, pos, p, model);
        a.n++; a.sum += v; a.sq += v * v;
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
          samples: a.n,
        }));
        list.sort((x, y) => y.value - x.value);
        return list;
      },
    };
  }

  // Chance of each card being the next draw.
  function drawChances(position, model = DEFAULT_MODEL) {
    const W = makeWeights(position.hand, position.discarded || 0, position.played || 0, model);
    let total = 0;
    for (let c = 0; c < CARDS; c++) total += W[c];
    const out = [];
    if (total > 0) for (let c = 0; c < CARDS; c++) if (W[c] > 0) out.push({ card: c, chance: W[c] / total });
    return out;
  }

  function bestMoveSync(position, rounds, rng, extra = {}) {
    if (!legalActions(position.hand, position.k).length) return null;
    const an = createAnalysis(position, { maxRounds: rounds, rng, ...extra });
    while (an.step(50));
    return an.result()[0];
  }

  // Plays a whole game under a true return rule. chooser(position) returns a move, or null to stop.
  function playGame(rng, chooser, truth) {
    let hand = 0, discarded = 0, played = 0, k = TOTAL_DEAL, pts = 0;
    const W = new Float64Array(CARDS).fill(1);
    const draw = (count) => {
      for (; count > 0 && k > 0; count--) {
        const c = pick(W, rng());
        if (c < 0) { k = 0; return; }
        hand |= 1 << c; W[c] = 0; k--;
        discarded &= ~(1 << c); played &= ~(1 << c);
      }
    };
    draw(5);
    while (true) {
      const a = chooser({ hand, discarded, played, k });
      if (!a) return pts;
      if (a.kind === 'play') {
        const c = COMBOS[a.combo];
        pts += c.pts; hand &= ~c.mask; played |= c.mask;
        for (const id of c.cards) W[id] = truth.p;
        if (k === 0) return pts;
        draw(3);
      } else {
        hand &= ~(1 << a.card); discarded |= 1 << a.card;
        W[a.card] = truth.d;
        draw(1);
      }
    }
  }

  const heuristicChooser = (model = DEFAULT_MODEL, p = DEFAULT_PARAMS) => (pos) => {
    const W = makeWeights(pos.hand, pos.discarded, pos.played, model);
    const a = policy(pos.hand, W, pos.k, p);
    if (a === -1000) return null;
    return a >= 0 ? { kind: 'play', combo: a } : { kind: 'discard', card: -1 - a };
  };

  root.RuneRow = {
    NUMBERS, COLOURS, CARDS, TOTAL_DEAL, ALL, COMBOS, DEFAULT_MODEL, DEFAULT_PARAMS,
    cardId, colourOf, numberOf, cardsOf, popcount, makeRng,
    createAnalysis, drawChances, bestMoveSync, legalActions, playGame, heuristicChooser,
  };
})(typeof module !== 'undefined' ? module.exports : window);
