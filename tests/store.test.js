'use strict';
/* Store layer: one interface, two backends. The in-memory suite runs everywhere;
   the sqlite suite runs whenever node:sqlite can be loaded (Node >= 23.4 without
   a flag) and exercises the real file: restart hand-back, player profiles, and
   the win/loss/draw + streak bookkeeping. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../scripts/store.js');

const canSqlite = (() => { try { require('node:sqlite'); return true; } catch { return false; } })();

function roomRecord(code, extra = {}) {
  return {
    code, size: 7, phase: 'playing', restarts: 0, recorded: false,
    moves: [3, 10], clock: { remaining: 60000 }, snapshotState: { size: 7, cells: [] },
    resigned: null, createdAt: 111, lastSeen: 222,
    seats: { 1: { token: 'tok-a', name: '小明', id: 'aaaaaaaa-1111-2222-3333-444444444444' }, 2: { token: 'tok-b', name: '小红', id: 'bbbbbbbb-1111-2222-3333-444444444444' } },
    ...extra,
  };
}

function suite(label, open) {
  test(label + ' backend: room records round-trip, ended rooms stay out', () => {
    const store = open();
    store.saveRoom(roomRecord('ABC23'));
    store.saveRoom(roomRecord('ZZZ99', { phase: 'ended', recorded: true, resigned: 2 }));
    const loaded = store.loadRooms();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].code, 'ABC23');
    assert.equal(loaded[0].size, 7);
    assert.equal(loaded[0].moves[1], 10);
    assert.equal(loaded[0].clock.remaining, 60000);
    assert.equal(loaded[0].snapshotState.size, 7);
    assert.equal(loaded[0].seats[1].id, 'aaaaaaaa-1111-2222-3333-444444444444');
    assert.equal(loaded[0].seats[2].name, '小红');
    assert.equal(loaded[0].recorded, false);
    store.deleteRoom('ABC23');
    assert.equal(store.loadRooms().length, 0);
    store.close();
  });

  test(label + ' backend: saveRoom overwrites the same code', () => {
    const store = open();
    store.saveRoom(roomRecord('ABC23', { moves: [1] }));
    store.saveRoom(roomRecord('ABC23', { moves: [1, 2, 3], phase: 'ended', recorded: true }));
    const loaded = store.loadRooms();
    assert.equal(loaded.length, 0); // ended → filtered
    store.deleteRoom('ABC23');
    store.close();
  });

  test(label + ' backend: recordResult drives win/loss/draw and streaks', () => {
    const store = open();
    const A = 'aaaaaaaa-1111-2222-3333-444444444444', B = 'bbbbbbbb-1111-2222-3333-444444444444';
    store.upsertPlayer(A, '小明');
    store.upsertPlayer(B, '小红');
    const seats = { 1: { id: A, name: '小明' }, 2: { id: B, name: '小红' } };
    store.recordResult({ code: 'ABC23', size: 7, winner: 1, reason: 'capture', points: [12, 4], seats, finishedAt: 1000 });
    store.recordResult({ code: 'DEF45', size: 7, winner: 1, reason: 'resign', points: null, seats, finishedAt: 2000 });
    store.recordResult({ code: 'GHI67', size: 7, winner: 2, reason: 'time', points: [5, 9], seats, finishedAt: 3000 });
    store.recordResult({ code: 'JKL89', size: 7, winner: 0, reason: 'time', points: [7, 7], seats, finishedAt: 4000 });
    const a = store.playerStats(A), b = store.playerStats(B);
    assert.equal(a.wins, 2);
    assert.equal(a.losses, 1);
    assert.equal(a.draws, 1);
    assert.equal(a.games, 4);
    assert.equal(a.bestStreak, 2);
    assert.equal(a.streak, 0, 'a draw resets the streak');
    assert.equal(a.name, '小明');
    assert.equal(b.wins, 1);
    assert.equal(b.losses, 2);
    assert.equal(b.draws, 1);
    assert.equal(b.streak, 0, 'draw resets the streak on both sides');
    assert.equal(b.bestStreak, 1);
    store.close();
  });

  test(label + ' backend: a loss streak goes negative and best streak is kept', () => {
    const store = open();
    const A = 'cccccccc-1111-2222-3333-444444444444', B = 'dddddddd-1111-2222-3333-444444444444';
    const seats = { 1: { id: A, name: '' }, 2: { id: B, name: '' } };
    store.recordResult({ winner: 2, seats, finishedAt: 1 });
    store.recordResult({ winner: 2, seats, finishedAt: 2 });
    store.recordResult({ winner: 1, seats, finishedAt: 3 });
    const a = store.playerStats(A);
    assert.equal(a.streak, 1, 'first win after two losses');
    assert.equal(a.bestStreak, 1);
    const b = store.playerStats(B);
    assert.equal(b.streak, -1, 'a loss after two wins starts a fresh negative streak');
    assert.equal(b.bestStreak, 2);
    store.close();
  });

  test(label + ' backend: results without player ids count no stats but do not crash', () => {
    const store = open();
    store.recordResult({ code: 'NOID', size: 7, winner: 1, reason: 'resign', points: null, seats: { 1: {}, 2: {} }, finishedAt: 1 });
    assert.equal(store.playerStats('nobody-0000-1111-2222-3333-444444444444'), null);
    store.close();
  });

  test(label + ' backend: upsertPlayer keeps the latest non-empty name', () => {
    const store = open();
    const A = 'eeeeeeee-1111-2222-3333-444444444444';
    store.upsertPlayer(A, '小明');
    store.upsertPlayer(A, '');
    store.upsertPlayer(A, '新的名字');
    assert.equal(store.playerStats(A).name, '新的名字');
    store.close();
  });

  test(label + ' backend: summary counts rooms, players, games', () => {
    const store = open();
    const A = 'ffffffff-1111-2222-3333-444444444444', B = '99999999-1111-2222-3333-444444444444';
    store.saveRoom(roomRecord('AAA11'));
    store.upsertPlayer(A, '甲');
    store.upsertPlayer(B, '乙');
    store.recordResult({ winner: 1, seats: { 1: { id: A, name: '甲' }, 2: { id: B, name: '乙' } }, finishedAt: 1 });
    const counts = store.summary();
    assert.equal(counts.rooms, 1);
    assert.equal(counts.players, 2);
    assert.equal(counts.games, 1);
    store.close();
  });
}

suite('memory', () => createStore({ file: null }));

test('sqlite backend is selected when node:sqlite is available', { skip: !canSqlite && 'node:sqlite not available' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-chess-store-'));
  const file = path.join(dir, 'game.db');
  const store = createStore({ file });
  assert.equal(store.mode, 'sqlite');
  store.saveRoom(roomRecord('SQL11'));
  assert.equal(store.loadRooms().length, 1);
  store.close();
  const reopened = createStore({ file }); // same file, second process style
  assert.equal(reopened.loadRooms().length, 1, 'data survives a close/reopen');
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

if (canSqlite) {
  suite('sqlite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-chess-store-'));
    const store = createStore({ file: path.join(dir, 'game.db') });
    const inner = store.close.bind(store);
    store.close = () => { inner(); fs.rmSync(dir, { recursive: true, force: true }); };
    return store;
  });
}

test('an unwritable file location falls back to memory instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-chess-store-'));
  const store = createStore({ file: dir }); // the path IS a directory: open must fail
  assert.equal(store.mode, 'memory');
  store.saveRoom(roomRecord('FBK11'));
  assert.equal(store.loadRooms().length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an explicit null sqlite module falls back to memory', () => {
  const store = createStore({ file: 'whatever.db', sqlite: null });
  assert.equal(store.mode, 'memory');
  store.close();
});

test(':memory: spec means the in-memory backend', () => {
  const store = createStore({ file: ':memory:' });
  assert.equal(store.mode, 'memory');
  store.close();
});
