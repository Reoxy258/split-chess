'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const E = require('../engine.js');
const clone = x => JSON.parse(JSON.stringify(x));
const index10 = i => (Math.floor(i / 6) + 2) * 10 + i % 6 + 2;
const sum = s => s.cells.reduce((n, c) => n + c.count, 0);
function randomGenerator(seed) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
}
function frozen(s) {
  s.cells.forEach(Object.freeze); Object.freeze(s.cells); Object.freeze(s.moves); return Object.freeze(s);
}
function oldMatch() {
  let s = E.newGame({ size: 6 });
  for (const i of [0, 35, 0, 35, 0, 35, 14]) s = E.applyMove(s, i).state;
  return s;
}

test('recommended board has 49 independent cells and 49 legal opening moves', () => {
  assert.equal(E.BOARD_SIZE, 7); const s = E.newGame();
  assert.equal(s.size, 7); assert.equal(s.cells.length, 49);
  assert.equal(new Set(s.cells).size, 49); assert.ok(E.validateState(s));
  assert.equal(E.legalMoves(s).length, 49);
  const after = E.applyMove(s, 48).state;
  assert.deepEqual(after.cells[48], { owner: 1, count: 1 });
  assert.deepEqual(s.cells[48], { owner: 0, count: 0 });
});

test('10x10 four edges and corners have correct neighbors without row wrap', () => {
  const cases = [[0, [1, 10]], [9, [8, 19]], [90, [80, 91]], [99, [89, 98]],
    [4, [3, 5, 14]], [95, [85, 94, 96]], [40, [30, 41, 50]], [49, [39, 48, 59]],
    [44, [34, 43, 45, 54]]];
  for (const [i, expected] of cases) {
    assert.deepEqual(E.neighbors(i, 10).sort((a, b) => a - b), expected);
    const s = E.newGame({ size: 10 }); s.cells[i] = { owner: 1, count: 3 };
    const r = E.applyMove(s, i);
    assert.equal(r.lost, 4 - expected.length); assert.equal(r.splits, 1);
    assert.deepEqual(r.state.cells.flatMap((c, j) => c.count ? [j] : []), expected);
    assert.equal(sum(r.state), expected.length);
  }
});

test('6 to 10 expansion adds exactly two empty rows and columns on every side', () => {
  const input = frozen(oldMatch()), before = clone(input), output = E.expandState(input, 10);
  assert.ok(E.validateState(output)); assert.equal(output.size, 10);
  assert.equal(output.lastMove, 44);
  for (const k of ['turn', 'ply', 'winner']) assert.equal(output[k], input[k]);
  assert.deepEqual(output.moves, input.moves); assert.notEqual(output.moves, input.moves);
  assert.deepEqual(E.totals(output), E.totals(input));
  assert.deepEqual(input, before);
  for (let i = 0; i < 36; i++) {
    assert.deepEqual(output.cells[index10(i)], input.cells[i]);
    assert.notEqual(output.cells[index10(i)], input.cells[i]);
  }
  for (let i = 0; i < 100; i++) {
    const row = Math.floor(i / 10), col = i % 10;
    if (row < 2 || row > 7 || col < 2 || col > 7) assert.deepEqual(output.cells[i], { owner: 0, count: 0 });
  }
  output.cells[22].count = 1;
  assert.deepEqual(input.cells[0], { owner: 1, count: 3 });
});

test('empty, same-size and intermediate expansions preserve sentinel and allocate independent state', () => {
  const old = E.newGame({ size: 6 });
  assert.equal(E.expandState(old, 10).lastMove, -1);
  const current = frozen(E.newGame({ size: 10 })), same = E.expandState(current, 10);
  assert.deepEqual(same, current); assert.notEqual(same, current);
  assert.notEqual(same.cells, current.cells); assert.notEqual(same.moves, current.moves);
  const direct = E.expandState(oldMatch(), 10);
  const viaEight = E.expandState(E.expandState(oldMatch(), 8), 10);
  assert.deepEqual(viaEight, direct);
});

test('finished-match metadata and winner survive expansion without reopening play', () => {
  const s = E.newGame({ size: 6 });
  s.cells[14] = { owner: 1, count: 3 }; s.cells[15] = { owner: 2, count: 3 };
  s.moves = [1, 1]; s.ply = 2;
  const won = E.applyMove(s, 14).state;
  assert.equal(won.winner, 1);
  const expanded = E.expandState(won, 10);
  assert.equal(expanded.winner, 1); assert.equal(expanded.turn, won.turn);
  assert.equal(expanded.ply, won.ply); assert.deepEqual(expanded.moves, won.moves);
  assert.equal(expanded.lastMove, index10(won.lastMove));
  assert.deepEqual(E.legalMoves(expanded), []); assert.equal(E.chooseMove(expanded), null);
  assert.throws(() => E.applyMove(expanded, 0));
});

test('invalid, shrinking and off-center expansion requests are rejected without mutation', () => {
  const s = oldMatch(), before = clone(s);
  for (const size of [2, 4, 5, 7, 9, 11, 12, 10.5, NaN, null, '10']) assert.throws(() => E.expandState(s, size));
  for (const input of [null, {}, { ...s, cells: [] }, { ...s, cells: s.cells.map((c, i) => i ? c : { owner: 1, count: 4 }) }]) assert.throws(() => E.expandState(input, 10));
  assert.deepEqual(s, before);
});

// Minimal DOM drives actual app restoration and undo, not a duplicate migration helper.
function restoreApp(saved) {
  const key = 'split-chess.save.v1', elements = new Map();
  const store = new Map([[key, JSON.stringify(saved)], ['split-chess.learned.v1', '1']]);
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.dataset = {}; this.style = { setProperty() {} }; this.classList = { toggle() {}, add() {} }; }
    append(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    setAttribute(k, v) { this[k] = v; }
    addEventListener(k, v) { this.listeners[k] = v; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() {}
    scrollTo() {}
  }
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = vm.createContext({ SplitChess: E,
    document: { getElementById: get, createElement: () => new Element(), createElementNS: () => new Element(), querySelectorAll: () => [], addEventListener() {}, body: new Element() },
    localStorage: { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
    matchMedia: () => ({ matches: false }), performance: { now: () => 0 }, setInterval() {}, setTimeout() {}, window: { addEventListener() {} }, location: { protocol: 'file:' } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), context);
  return { get, saved: () => JSON.parse(store.get(key)) };
}

test('actual app preserves legacy 6x6 cells and history, and can still start a different size', () => {
  const initial = E.newGame({ size: 6 });
  const first = E.applyMove(initial, 14).state, second = E.applyMove(first, 15).state;
  const oldSave = { version: 1, state: second, history: [initial, first], mode: 'local', quick: true };
  const before = clone(oldSave), app = restoreApp(oldSave);
  assert.equal(app.get('board').children.length, 36);
  assert.deepEqual(app.saved().state, second);
  assert.deepEqual(app.saved().history, [initial, first]);
  assert.equal(app.saved().version, 2); assert.equal(app.saved().clock.remaining, 240000);
  app.get('undo-button').onclick(); assert.deepEqual(app.saved().state, first);
  assert.deepEqual(oldSave, before);
  app.get('board-size').value = '8'; app.get('board-size').onchange();
  assert.equal(app.get('board-size').value, '6');
  app.get('confirm-ok').onclick();
  assert.equal(app.saved().state.size, 8); assert.equal(app.get('board').children.length, 64);
  assert.equal(app.saved().clock.remaining, 360000); assert.deepEqual(app.saved().history, []);
});

test('10x10 chain keeps four-point threshold, captures, remainder and trace consistency', () => {
  const s = E.newGame({ size: 10 }); s.moves = [1, 1]; s.ply = 2;
  for (const [i, owner] of [[44, 1], [34, 1], [45, 2], [35, 2]]) s.cells[i] = { owner, count: 3 };
  s.cells[99] = { owner: 2, count: 1 };
  const r = E.applyMove(s, 44, { trace: true });
  assert.ok(r.frames.some(f => f.cells[35].count === 5));
  assert.deepEqual(r.state.cells[35], { owner: 1, count: 1 });
  assert.deepEqual(r.state.cells[44], { owner: 1, count: 2 });
  assert.equal(r.splits, 4); assert.equal(r.lost, 0); assert.equal(r.state.winner, 0);
  assert.equal(sum(r.state), sum(s) + 1);
  assert.ok(E.validateState(r.state));
  assert.deepEqual(E.applyMove(s, 44).state, r.state);
});

test('10x10 AI stays legal, immutable and responsive on opening, midgame and dense states', t => {
  const random = randomGenerator(0x10e7a2c), positions = [E.newGame({ size: 10 })];
  let s = E.newGame({ size: 10 });
  for (let i = 0; i < 180; i++) {
    if (s.winner) s = E.newGame({ size: 10 });
    const legal = E.legalMoves(s);
    s = E.applyMove(s, legal[Math.floor(random() * legal.length)]).state;
    if (i % 9 === 0 && !s.winner) positions.push(s);
  }
  for (let k = 0; k < 8; k++) {
    const dense = E.newGame({ size: 10 }); dense.moves = [1, 1]; dense.ply = 2;
    dense.cells.forEach(c => { c.count = k % 2 ? 3 : 1 + Math.floor(random() * 3); c.owner = 1 + Math.floor(random() * 2); });
    positions.push(dense);
  }
  const times = [];
  for (const position of positions) {
    const before = clone(position), start = performance.now(), move = E.chooseMove(position);
    times.push(performance.now() - start);
    assert.ok(E.legalMoves(position).includes(move)); assert.deepEqual(position, before);
    const result = E.applyMove(position, move);
    assert.ok(E.validateState(result.state));
    assert.equal(sum(result.state), sum(position) + 1 - result.lost);
  }
  times.sort((a, b) => a - b);
  const max = times.at(-1), median = times[Math.floor(times.length / 2)];
  t.diagnostic(`${positions.length} 10x10 AI decisions: median=${median.toFixed(2)}ms, max=${max.toFixed(2)}ms (Node host, not a phone benchmark)`);
  assert.ok(max < 5000, 'single AI decision should settle within a generous 5-second host budget');
});
