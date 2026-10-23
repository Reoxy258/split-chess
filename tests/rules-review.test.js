'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../engine.js');

// Independent serial sandpile oracle: process one overflowing cell at a time.
// Production settles simultaneous waves. Both must reach the same stable board.
function reference(input, index) {
  const s = JSON.parse(JSON.stringify(input));
  const actor = s.turn;
  s.cells[index] = { owner: actor, count: s.cells[index].count + 1 };
  const pending = [index];
  let cursor = 0, lost = 0, splits = 0;
  while (cursor < pending.length) {
    const i = pending[cursor++];
    if (s.cells[i].count < 4) continue;
    s.cells[i].count -= 4;
    s.cells[i].owner = s.cells[i].count ? actor : 0;
    splits++;
    const x = i % s.size, y = Math.floor(i / s.size);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= s.size || ny >= s.size) { lost++; continue; }
      const j = ny * s.size + nx;
      s.cells[j].count++;
      s.cells[j].owner = actor;
      if (s.cells[j].count >= 4) pending.push(j);
    }
    if (s.cells[i].count >= 4) pending.push(i);
    assert.ok(cursor < 2000000, 'serial oracle must terminate');
  }
  s.moves[actor - 1]++;
  s.ply++;
  s.lastMove = index;
  if (s.moves.every(n => n > 0) && !s.cells.some(c => c.owner === 3 - actor)) s.winner = actor;
  s.turn = 3 - actor;
  return { state: s, lost, splits };
}
function fixture(entries, turn = 1, size = 6) {
  const s = engine.newGame({ size });
  s.turn = turn; s.moves = [1, 1]; s.ply = 2;
  for (const [i, owner, count] of entries) s.cells[i] = { owner, count };
  return s;
}
function points(s) { return s.cells.reduce((n, c) => n + c.count, 0); }
function rng(seed) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
}
function compare(s, i, trace = false) {
  const before = JSON.stringify(s);
  const actual = engine.applyMove(s, i, { trace });
  const expected = reference(s, i);
  assert.deepEqual(actual.state, expected.state);
  assert.equal(actual.lost, expected.lost);
  assert.equal(actual.splits, expected.splits);
  assert.equal(points(actual.state), points(s) + 1 - actual.lost);
  assert.ok(engine.validateState(actual.state));
  assert.equal(JSON.stringify(s), before, 'input state must remain unchanged');
  return actual;
}

test('new 6x6 game is empty and first placement cannot win', () => {
  const s = engine.newGame();
  assert.equal(s.size, 6); assert.equal(s.cells.length, 36);
  assert.ok(s.cells.every(c => c.owner === 0 && c.count === 0));
  assert.deepEqual(s.moves, [0, 0]); assert.equal(s.turn, 1);
  assert.equal(engine.legalMoves(s).length, 36);
  const a = compare(s, 14);
  assert.equal(a.state.winner, 0); assert.equal(a.state.turn, 2);
  assert.deepEqual(a.state.moves, [1, 0]); assert.equal(a.state.ply, 1);
  assert.equal(a.state.lastMove, 14);
  assert.notEqual(a.state.cells, s.cells); assert.notEqual(a.state.cells[0], s.cells[0]);
});

test('own/empty placement accepted; enemy, malformed and terminal placements rejected', () => {
  const s = fixture([[14, 1, 1], [15, 2, 1]]);
  assert.ok(engine.legalMoves(s).includes(14));
  assert.ok(!engine.legalMoves(s).includes(15));
  compare(s, 14); compare(s, 0);
  for (const i of [-1, 36, 1.2, NaN, Infinity, '1', null, undefined, 15]) {
    const before = JSON.stringify(s);
    assert.throws(() => engine.applyMove(s, i)); assert.equal(JSON.stringify(s), before);
  }
  s.winner = 1;
  assert.deepEqual(engine.legalMoves(s), []); assert.equal(engine.chooseMove(s), null);
  assert.throws(() => engine.applyMove(s, 14));
});

test('center split has precisely four orthogonal arrivals', () => {
  const a = compare(fixture([[14, 1, 3], [35, 2, 1]]), 14, true);
  assert.deepEqual(a.state.cells[14], { owner: 0, count: 0 });
  for (const i of [8, 13, 15, 20]) assert.deepEqual(a.state.cells[i], { owner: 1, count: 1 });
  assert.equal(a.splits, 1); assert.equal(a.lost, 0); assert.equal(a.waves, 1);
  for (const i of [7, 9, 19, 21]) assert.equal(a.state.cells[i].count, 0);
});

test('fixed threshold 4 loses one point at edge and two at corner', () => {
  const edge = compare(fixture([[2, 1, 3], [35, 2, 1]]), 2);
  const corner = compare(fixture([[0, 1, 3], [35, 2, 1]]), 0);
  assert.equal(edge.lost, 1); assert.equal(edge.splits, 1);
  assert.equal(corner.lost, 2); assert.equal(corner.splits, 1);
  assert.deepEqual(corner.state.cells[1], { owner: 1, count: 1 });
  assert.deepEqual(corner.state.cells[6], { owner: 1, count: 1 });
});

test('enemy capture retains points and enemy three chains with actor ownership', () => {
  const capture = compare(fixture([[14, 1, 3], [15, 2, 2], [35, 2, 1]]), 14);
  assert.deepEqual(capture.state.cells[15], { owner: 1, count: 3 });
  assert.equal(capture.captured, 1); assert.equal(capture.state.winner, 0);
  const chain = compare(fixture([[14, 1, 3], [15, 2, 3], [16, 2, 2]]), 14, true);
  assert.equal(chain.splits, 2); assert.equal(chain.state.winner, 1);
  assert.deepEqual(chain.state.cells[16], { owner: 1, count: 3 });
  assert.ok(chain.state.cells.every(c => c.owner !== 2));
  assert.deepEqual(chain.state.moves, [2, 1]); assert.equal(chain.state.ply, 3);
});

test('same-wave arrivals create five, preserve remainder, and do not erase returning points', () => {
  const s = fixture([[14, 1, 3], [8, 1, 3], [15, 2, 3], [9, 2, 3], [35, 2, 1]]);
  const a = compare(s, 14, true);
  assert.ok(a.frames.some(f => f.cells[9].count === 5));
  assert.deepEqual(a.state.cells[9], { owner: 1, count: 1 });
  assert.deepEqual(a.state.cells[14], { owner: 1, count: 2 });
  assert.deepEqual(a.state.cells[8], { owner: 1, count: 1 });
  assert.deepEqual(a.state.cells[15], { owner: 1, count: 1 });
  assert.deepEqual(engine.applyMove(s, 14, { trace: false }).state, a.state);
  assert.equal(engine.applyMove(s, 14, { trace: false }).frames.length, 0);
});

test('side two captures and wins symmetrically after full cascade', () => {
  const a = compare(fixture([[14, 2, 3], [15, 1, 3], [16, 1, 2]], 2), 14, true);
  assert.equal(a.state.winner, 2); assert.equal(a.state.turn, 1);
  assert.deepEqual(a.state.moves, [1, 2]); assert.deepEqual(engine.legalMoves(a.state), []);
  assert.ok(a.frames.length >= 3);
  assert.deepEqual(a.frames.at(-1).cells, a.state.cells);
});

test('validateState rejects structurally broken stable boards', () => {
  const s = engine.newGame(); assert.ok(engine.validateState(s));
  for (const edit of [x => x.cells.pop(), x => x.cells[0] = { owner: 1, count: 0 },
    x => x.cells[0] = { owner: 0, count: 1 }, x => x.cells[0] = { owner: 1, count: 4 },
    x => x.turn = 3, x => x.moves = [1, 0], x => x.lastMove = 36]) {
    const bad = JSON.parse(JSON.stringify(s)); edit(bad); assert.equal(engine.validateState(bad), false);
  }
});

test('4000 seeded reachable random moves agree with independent serial oracle', () => {
  const random = rng(0x51c7cafe);
  let s = engine.newGame(), verified = 0, games = 1;
  while (verified < 4000) {
    if (s.winner) { s = engine.newGame(); games++; }
    const legal = engine.legalMoves(s);
    assert.ok(legal.length > 0);
    s = compare(s, legal[Math.floor(random() * legal.length)], verified % 97 === 0).state;
    verified++;
  }
  assert.ok(games > 1, 'random coverage must include completed games');
});

test('120 dense boards of size 2..10 stabilize and agree with independent oracle', () => {
  const random = rng(0x7a3b411);
  for (let k = 0; k < 120; k++) {
    const n = 2 + k % 9;
    const s = fixture([], 1 + k % 2, n);
    for (const c of s.cells) {
      c.count = k % 3 === 0 ? 3 : Math.floor(random() * 4);
      c.owner = c.count ? 1 + Math.floor(random() * 2) : 0;
    }
    const index = Math.floor(random() * s.cells.length);
    s.cells[index].owner = s.turn; s.cells[index].count = 3;
    compare(s, index, k % 17 === 0);
  }
});

test('AI returns legal moves without mutation across 80 evolving positions', () => {
  const random = rng(0x445511);
  let s = engine.newGame();
  for (let k = 0; k < 80; k++) {
    if (s.winner) s = engine.newGame();
    const before = JSON.stringify(s), move = engine.chooseMove(s);
    assert.ok(engine.legalMoves(s).includes(move)); assert.equal(JSON.stringify(s), before);
    s = compare(s, move).state;
    if (s.winner) continue;
    // Vary opponents so the AI is exercised beyond a single repeated game.
    const legal = engine.legalMoves(s);
    s = compare(s, legal[Math.floor(random() * legal.length)]).state;
  }
});
