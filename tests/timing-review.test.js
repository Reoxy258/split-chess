'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');
const clone = x => JSON.parse(JSON.stringify(x));
function started(size = 7, patch = {}) { return { ...E.newClock(size), started: true, ...patch }; }
function board(size = 7, entries = [], patch = {}) {
  const s = E.newGame({ size });
  for (const [i, owner, count] of entries) s.cells[i] = { owner, count };
  return { ...s, ...patch };
}
function freezeState(s) { s.cells.forEach(Object.freeze); Object.freeze(s.cells); Object.freeze(s.moves); return Object.freeze(s); }
function check(s, c, elapsed) {
  const oldS = clone(s), oldC = clone(c), r = E.advanceClock(s, c, elapsed);
  assert.deepEqual(s, oldS); assert.deepEqual(c, oldC);
  assert.ok(E.validateState(r.state)); assert.ok(E.validateClock(r.clock, s.size));
  return r;
}

test('all selectable sizes have independent exact match and step budgets, default is seven', () => {
  assert.equal(E.BOARD_SIZE, 7); assert.equal(E.newGame().cells.length, 49);
  for (const [size, minutes, seconds] of [[5, 3, 15], [6, 4, 18], [7, 5, 20], [8, 6, 22], [9, 8, 25], [10, 10, 30]]) {
    const controls = E.timeControl(size);
    assert.deepEqual(controls, { match: minutes * 60000, turn: seconds * 1000 });
    const c = E.newClock(size);
    assert.deepEqual(c, { remaining: controls.match, turnRemaining: controls.turn, overtime: 0, started: false, paused: false });
    assert.ok(E.validateClock(c, size));
    controls.match = 0; assert.equal(E.newClock(size).remaining, minutes * 60000);
    c.turnRemaining = 0; assert.equal(E.newClock(size).turnRemaining, seconds * 1000);
  }
  assert.deepEqual(E.newClock(), E.newClock(7));
  for (const size of [2, 4, 11, 7.5, NaN]) assert.throws(() => E.timeControl(size));
});

test('not-started, explicitly paused and completed games consume no time or turns', () => {
  const s = E.newGame();
  for (const c of [E.newClock(), started(7, { paused: true })]) {
    const r = check(s, c, 900000);
    assert.deepEqual(r.clock, c); assert.deepEqual(r.state, s); assert.deepEqual(r.events, []);
  }
  const won = board(7, [[0, 1, 1]], { winner: 1 });
  const c = started(), r = check(won, c, 900000);
  assert.deepEqual(r.state, won); assert.deepEqual(r.clock, c); assert.deepEqual(r.events, []);
});

test('ordinary elapsed and fractional milliseconds decrement both clocks exactly without mutation', () => {
  const s = freezeState(E.newGame()), c = Object.freeze(started());
  const r = check(s, c, 1234.5);
  assert.equal(r.clock.remaining, 298765.5); assert.equal(r.clock.turnRemaining, 18765.5);
  assert.deepEqual(r.state, s); assert.deepEqual(r.events, []); assert.notEqual(r.clock, c);
  assert.deepEqual(check(s, c, 0).clock, c);
});

test('a step deadline passes once, records a skipped ply and does not create an actual move', () => {
  for (let size = 5; size <= 10; size++) {
    const s = board(size, [], { lastMove: size * size - 1 }), c = started(size);
    const almost = check(s, c, c.turnRemaining - 1);
    assert.deepEqual(almost.events, []); assert.equal(almost.state.turn, 1); assert.equal(almost.clock.turnRemaining, 1);
    const r = check(almost.state, almost.clock, 1);
    assert.deepEqual(r.events, ['turn']); assert.equal(r.state.turn, 2);
    assert.equal(r.state.ply, 1); assert.equal(r.state.skipped, 1);
    assert.deepEqual(r.state.moves, [0, 0]); assert.equal(r.state.lastMove, -1);
    assert.deepEqual(r.state.cells, s.cells);
    assert.equal(r.clock.turnRemaining, E.timeControl(size).turn);
    assert.equal(r.clock.remaining, E.timeControl(size).match - E.timeControl(size).turn);
  }
});

test('one elapsed batch handles multiple skipped turns and consumes the trailing remainder', () => {
  const r = check(E.newGame(), started(), 65000);
  assert.deepEqual(r.events, ['turn', 'turn', 'turn']);
  assert.equal(r.state.turn, 2); assert.equal(r.state.ply, 3); assert.equal(r.state.skipped, 3);
  assert.deepEqual(r.state.moves, [0, 0]); assert.equal(r.state.winner, 0);
  assert.equal(r.clock.remaining, 235000); assert.equal(r.clock.turnRemaining, 15000);
});

test('total expiry compares point sums rather than owned cells and allows either player to win', () => {
  for (const leader of [1, 2]) {
    const s = board(7, [[0, leader, 3], [1, 3 - leader, 1], [2, 3 - leader, 1]], { moves: [1, 1], ply: 2 });
    const r = check(s, started(7, { remaining: 1000, turnRemaining: 5000 }), 5000);
    assert.deepEqual(r.events, ['time']); assert.equal(r.state.winner, leader);
    assert.equal(r.state.resultReason, 'time'); assert.equal(r.state.ply, 2);
    assert.equal(r.clock.remaining, 0); assert.equal(r.clock.turnRemaining, 4000);
    assert.deepEqual(E.legalMoves(r.state), []); assert.equal(E.chooseMove(r.state), null);
    assert.throws(() => E.applyMove(r.state, 3));
    assert.deepEqual(check(r.state, r.clock, 100000).events, []);
  }
});

test('simultaneous unequal-score total and turn expiry awards time win before any pass', () => {
  const s = board(7, [[0, 1, 2], [1, 2, 1]], { moves: [1, 1], ply: 2 });
  const r = check(s, started(7, { remaining: 1000, turnRemaining: 1000 }), 1000);
  assert.deepEqual(r.events, ['time']); assert.equal(r.state.winner, 1);
  assert.equal(r.state.turn, 1); assert.equal(r.state.ply, 2); assert.equal(r.state.skipped, undefined);
  assert.equal(r.clock.remaining, 0); assert.equal(r.clock.turnRemaining, 0);
});

test('tied point sums grant sixty seconds even with unequal occupied-cell counts', () => {
  const s = board(7, [[0, 1, 3], [1, 2, 1], [2, 2, 1], [3, 2, 1]], { moves: [1, 1], ply: 2 });
  const r = check(s, started(7, { remaining: 1, turnRemaining: 10001 }), 1);
  assert.deepEqual(r.events, ['overtime']); assert.equal(r.state.winner, 0);
  assert.equal(r.clock.remaining, 60000); assert.equal(r.clock.overtime, 1);
  assert.equal(r.clock.turnRemaining, 10000); assert.equal(r.state.turn, 1);
});

test('simultaneous tied total and step expiry grants overtime first then passes the expired turn', () => {
  const r = check(E.newGame(), started(7, { remaining: 1000, turnRemaining: 1000 }), 1000);
  assert.deepEqual(r.events, ['overtime', 'turn']); assert.equal(r.clock.overtime, 1);
  assert.equal(r.clock.remaining, 60000); assert.equal(r.clock.turnRemaining, 20000);
  assert.equal(r.state.turn, 2); assert.equal(r.state.skipped, 1); assert.equal(r.state.winner, 0);
});

test('ties can extend repeatedly, including all boundaries and leftover time in one batch', () => {
  const r = check(E.newGame(), started(), 427000);
  assert.equal(r.events.filter(e => e === 'overtime').length, 3);
  assert.equal(r.events.filter(e => e === 'turn').length, 21);
  assert.equal(r.clock.overtime, 3); assert.equal(r.clock.remaining, 53000);
  assert.equal(r.clock.turnRemaining, 13000); assert.equal(r.state.skipped, 21);
  assert.equal(r.state.ply, 21); assert.deepEqual(r.state.moves, [0, 0]); assert.equal(r.state.winner, 0);
});

test('timeout passes cannot satisfy both-players-placed victory guard; subsequent moves stay valid', () => {
  const initial = E.newGame();
  const r = check(initial, started(), 20000);
  const orange = E.applyMove(r.state, 48).state;
  assert.equal(orange.turn, 1); assert.deepEqual(orange.moves, [0, 1]);
  assert.equal(orange.skipped, 1); assert.equal(orange.ply, 2); assert.equal(orange.winner, 0);
  assert.ok(E.validateState(orange));
  const blue = E.applyMove(orange, 0).state;
  assert.deepEqual(blue.moves, [1, 1]); assert.equal(blue.ply, 3); assert.equal(blue.skipped, 1);
  assert.equal(blue.winner, 0); assert.ok(E.validateState(blue));
});

test('skip metadata survives real chain capture and point-based victory still settles normally', () => {
  const s = board(7, [[24, 1, 3], [25, 2, 3]], { turn: 2, moves: [1, 1], skipped: 2, ply: 4 });
  const skipped = check(s, started(), 20000).state;
  assert.equal(skipped.turn, 1); assert.equal(skipped.skipped, 3);
  const r = E.applyMove(skipped, 24, { trace: true });
  assert.equal(r.state.winner, 1); assert.equal(r.state.skipped, 3);
  assert.deepEqual(r.state.moves, [2, 1]); assert.equal(r.state.ply, 6);
  assert.ok(E.validateState(r.state)); assert.ok(r.splits >= 2);
});

test('invalid timer input is rejected and legacy states without skipped remain valid', () => {
  const s = E.newGame(), c = started(); assert.ok(E.validateState(s));
  for (const elapsed of [-1, NaN, Infinity, -Infinity, '1', undefined]) assert.throws(() => E.advanceClock(s, c, elapsed));
  for (const patch of [{ remaining: -1 }, { remaining: Infinity }, { remaining: 300001 },
    { turnRemaining: 20001 }, { turnRemaining: -1 }, { overtime: -1 }, { overtime: 0.5 }, { started: 1 }, { paused: 'false' }]) {
    const bad = { ...c, ...patch }; assert.equal(E.validateClock(bad, 7), false); assert.throws(() => E.advanceClock(s, bad, 1));
  }
  for (const skipped of [-1, 0.5, NaN]) assert.equal(E.validateState({ ...s, skipped }), false);
  assert.equal(E.validateState({ ...s, skipped: 1 }), false);
  assert.ok(E.validateState({ ...s, skipped: 1, ply: 1 }));
});

test('batching elapsed time matches a separate millisecond countdown oracle across all sizes', () => {
  let comparisons = 0;
  for (let size = 5; size <= 10; size++) {
    for (const unequal of [false, true]) {
      let expectedState = board(size, unequal ? [[0, 2, 1]] : []), actualState = clone(expectedState);
      let expectedClock = started(size), actualClock = clone(expectedClock), randomSeed = size * 97 + Number(unequal);
      for (let iteration = 0; iteration < 16; iteration++) {
        randomSeed = (Math.imul(randomSeed, 1664525) + 1013904223) >>> 0;
        const elapsed = 1 + randomSeed % 70000, expectedEvents = [];
        // Oracle advances one real millisecond; does not copy production's next-boundary loop.
        for (let ms = 0; ms < elapsed && !expectedState.winner; ms++) {
          expectedClock.remaining--; expectedClock.turnRemaining--;
          if (!expectedClock.remaining) {
            if (unequal) { expectedState.winner = 2; expectedState.resultReason = 'time'; expectedEvents.push('time'); break; }
            expectedClock.remaining = 60000; expectedClock.overtime++; expectedEvents.push('overtime');
          }
          if (!expectedClock.turnRemaining) {
            expectedState.turn = 3 - expectedState.turn; expectedState.ply++;
            expectedState.skipped = (expectedState.skipped || 0) + 1; expectedState.lastMove = -1;
            expectedClock.turnRemaining = E.timeControl(size).turn; expectedEvents.push('turn');
          }
        }
        const actual = check(actualState, actualClock, elapsed);
        assert.deepEqual(actual.state, expectedState); assert.deepEqual(actual.clock, expectedClock);
        assert.deepEqual(actual.events, expectedEvents);
        actualState = actual.state; actualClock = actual.clock; comparisons++;
      }
    }
  }
  assert.equal(comparisons, 192);
});
