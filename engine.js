/* Deterministic rules shared by browser, worker, and tests. */
(function (root) {
  'use strict';
  const copy = s => ({ ...s, cells: s.cells.map(c => ({ ...c })), moves: [...s.moves] });
  function newGame({ size = 6 } = {}) {
    if (!Number.isInteger(size) || size < 2 || size > 10) throw new Error('Invalid board size');
    return { size, cells: Array.from({ length: size * size }, () => ({ owner: 0, count: 0 })), turn: 1, moves: [0, 0], winner: 0, ply: 0, lastMove: -1 };
  }
  function validateState(s) {
    return !!s && Number.isInteger(s.size) && s.size >= 2 && s.size <= 10 &&
      Array.isArray(s.cells) && s.cells.length === s.size * s.size &&
      s.cells.every(c => c && Number.isInteger(c.count) && c.count >= 0 && c.count <= 3 && [0, 1, 2].includes(c.owner) && ((c.count === 0) === (c.owner === 0))) &&
      [1, 2].includes(s.turn) && [0, 1, 2].includes(s.winner) && Array.isArray(s.moves) && s.moves.length === 2 &&
      s.moves.every(n => Number.isSafeInteger(n) && n >= 0) && Number.isSafeInteger(s.ply) && s.ply >= 0 &&
      s.moves[0] + s.moves[1] === s.ply && Number.isInteger(s.lastMove) && s.lastMove >= -1 && s.lastMove < s.cells.length;
  }
  function neighbors(i, n) {
    const out = [];
    if (i >= n) out.push(i - n);
    if (i % n < n - 1) out.push(i + 1);
    if (i < n * (n - 1)) out.push(i + n);
    if (i % n > 0) out.push(i - 1);
    return out;
  }
  function legalMoves(s) {
    if (s.winner) return [];
    return s.cells.flatMap((c, i) => c.owner === 0 || c.owner === s.turn ? [i] : []);
  }
  function totals(s) {
    const points = [0, 0], tiles = [0, 0];
    for (const c of s.cells) if (c.owner) { points[c.owner - 1] += c.count; tiles[c.owner - 1]++; }
    return { points, tiles };
  }
  function applyMove(input, index, { trace = false } = {}) {
    if (!Number.isInteger(index) || index < 0 || index >= input.cells.length || input.winner || (input.cells[index].owner && input.cells[index].owner !== input.turn)) throw new Error('Illegal move');
    const s = copy(input), player = s.turn, frames = [];
    let splits = 0, captured = 0, lost = 0, waves = 0;
    s.cells[index].owner = player;
    s.cells[index].count++;
    const frame = (active = [], transfers = [], captures = []) => { if (trace) frames.push({ cells: s.cells.map(c => ({ ...c })), active, transfers, captures }); };
    frame();
    for (;;) {
      const active = s.cells.flatMap((c, i) => c.count >= 4 ? [i] : []);
      if (!active.length) break;
      if (++waves > 20000) throw new Error('Unstable board');
      const transfers = [], arrivals = new Map(), captures = [];
      for (const i of active) {
        s.cells[i].count -= 4;
        if (!s.cells[i].count) s.cells[i].owner = 0;
        const targets = neighbors(i, s.size);
        splits++;
        lost += 4 - targets.length;
        for (const to of targets) { transfers.push({ from: i, to }); arrivals.set(to, (arrivals.get(to) || 0) + 1); }
      }
      for (const [i, amount] of arrivals) {
        if (s.cells[i].owner && s.cells[i].owner !== player) { captured++; captures.push(i); }
        s.cells[i].count += amount;
        s.cells[i].owner = player;
      }
      frame(active, transfers, captures);
    }
    s.moves[player - 1]++;
    s.ply++;
    s.lastMove = index;
    const { points } = totals(s);
    if (s.moves.every(n => n > 0) && points[2 - player] === 0) s.winner = player;
    s.turn = 3 - player;
    return { state: s, frames, splits, captured, lost, waves };
  }
  function evaluate(s, player) {
    if (s.winner) return s.winner === player ? 100000 - s.ply : -100000 + s.ply;
    let value = 0;
    for (let i = 0; i < s.cells.length; i++) {
      const c = s.cells[i];
      if (!c.owner) continue;
      const sign = c.owner === player ? 1 : -1;
      const ns = neighbors(i, s.size);
      value += sign * (10 + c.count * 5 + (c.count === 3 ? 9 : 0) + ns.length * 1.1);
      for (const j of ns) {
        const other = s.cells[j];
        if (other.owner && other.owner !== c.owner && other.count === 3) value -= sign * (c.count * 4 + 4);
      }
    }
    return value;
  }
  function chooseMove(s) {
    const legal = legalMoves(s);
    if (!legal.length) return null;
    const player = s.turn;
    const ranked = legal.map(index => {
      const result = applyMove(s, index);
      const row = Math.floor(index / s.size), col = index % s.size, center = (s.size - 1) / 2;
      return { index, result, score: evaluate(result.state, player) - (Math.abs(row - center) + Math.abs(col - center)) * 0.07 };
    }).sort((a, b) => b.score - a.score);
    if (ranked[0].result.state.winner === player) return ranked[0].index;
    let best = ranked[0].index, bestScore = -Infinity;
    for (const move of ranked.slice(0, 12)) {
      let worst = Infinity;
      for (const reply of legalMoves(move.result.state)) worst = Math.min(worst, evaluate(applyMove(move.result.state, reply).state, player));
      const score = worst + move.score * 0.05;
      if (score > bestScore) { bestScore = score; best = move.index; }
    }
    return best;
  }
  const api = { newGame, validateState, neighbors, legalMoves, totals, applyMove, chooseMove, copy };
  root.SplitChess = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
