'use strict';
/* Room hub persistence: the hub writes through to a store, a second hub over
   the same store hands rooms back after a "restart" (TTL respected), game
   results settle player stats exactly once, and sweeps clean the store. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomHub } = require('../scripts/rooms.js');
const { createStore } = require('../scripts/store.js');

const HOST_ID = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
const GUEST_ID = 'ffff1111-bbbb-cccc-dddd-eeeeeeeeeeee';
const TTL = 10 * 60 * 1000;

function makeConn() {
  const conn = {
    sent: [], closed: false,
    send(text) { if (this.closed) throw new Error('closed'); this.sent.push(text); },
    close() { this.closed = true; },
    onmessage: null, onclose: null,
  };
  return conn;
}
const last = conn => conn.sent.length ? JSON.parse(conn.sent[conn.sent.length - 1]) : null;
const drain = conn => { const out = conn.sent.map(JSON.parse); conn.sent = []; return out; };
const wire = (hub, conn) => { hub.attach(conn); return conn; };
const send = (conn, obj) => conn.onmessage(JSON.stringify(obj));

function match(hub) { // host + guest in a playing room, ids attached
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 7, name: '小明', id: HOST_ID });
  const code = last(host).code;
  send(guest, { t: 'join', code, name: '小红', id: GUEST_ID });
  const guestToken = last(guest).token; // captured before the drain clears it
  drain(host); drain(guest);
  return { host, guest, code, guestToken };
}
const cells = (filled = {}) => Array.from({ length: 49 }, (_, i) => filled[i] || { owner: 0, count: 0 });
const clock = extra => ({ remaining: 300000, turnRemaining: 60000, overtime: 0, started: true, paused: false, ...extra });

test('a second hub over the same store restores live rooms and their seats', () => {
  const store = createStore({ file: null });
  const hub1 = createRoomHub({ store });
  const { host, guest, code, guestToken } = match(hub1);
  send(host, { t: 'move', index: 0 });
  send(guest, { t: 'move', index: 6 });
  send(host, { t: 'clock', clock: clock(), state: { size: 7, cells: cells({ 0: { owner: 1, count: 1 }, 6: { owner: 2, count: 1 } }) } });
  send(host, { t: 'move', index: 12 }); // trailing move after the snapshot
  host.close(); guest.close(); // both drop; the log lives in the store now

  const hub2 = createRoomHub({ store }); // server "restart"
  assert.equal(hub2.stats().restored, 1);
  const view = hub2.roomView(code);
  assert.equal(view.phase, 'playing');
  assert.deepEqual(view.moves, [12], 'log is compacted to trailing moves');
  assert.equal(view.clock.remaining, 300000);
  assert.equal(view.names[0], '小明');
  assert.equal(view.names[1], '小红');

  // the returning guest reclaims seat 2 by token and receives the resume log
  const guest2 = wire(hub2, makeConn());
  send(guest2, { t: 'join', code, token: guestToken, name: '小红', id: GUEST_ID });
  const joined = last(guest2);
  assert.equal(joined.t, 'room');
  assert.equal(joined.role, 2);
  assert.equal(joined.resume.moves[0], 12);
  assert.equal(joined.resume.state.cells[0].owner, 1);
  assert.equal(joined.stats[1].id, GUEST_ID);
  assert.equal(joined.stats[0].name, '小明');
});

test('stale rooms are dropped (not restored) and deleted from the store', () => {
  const store = createStore({ file: null });
  const t0 = 1000000;
  const hub1 = createRoomHub({ store, now: () => t0 });
  const { code } = match(hub1);
  const hub2 = createRoomHub({ store, now: () => t0 + TTL + 1 });
  assert.equal(hub2.stats().restored, 0);
  assert.equal(hub2.roomView(code), null);
  assert.equal(store.loadRooms().length, 0, 'stale room is removed from the store');
});

test('resign settles the result on both profiles and broadcasts stats', () => {
  const store = createStore({ file: null });
  const hub = createRoomHub({ store });
  const { host, guest, code } = match(hub);
  send(guest, { t: 'resign' });
  const hostGot = drain(host), guestGot = drain(guest);
  assert.ok(hostGot.some(m => m.t === 'resigned' && m.role === 2));
  assert.ok(guestGot.some(m => m.t === 'resigned' && m.role === 2));
  const result = hostGot.find(m => m.t === 'result');
  assert.ok(result, 'host receives the settled result');
  assert.equal(result.winner, 1);
  assert.equal(result.reason, 'resign');
  assert.equal(result.stats[0].id, HOST_ID);
  assert.equal(result.stats[1].id, GUEST_ID);
  assert.ok(guestGot.some(m => m.t === 'result' && m.winner === 1));
  const hostStats = store.playerStats(HOST_ID), guestStats = store.playerStats(GUEST_ID);
  assert.equal(hostStats.wins, 1);
  assert.equal(hostStats.games, 1);
  assert.equal(guestStats.losses, 1);
  assert.equal(hub.roomView(code).phase, 'ended');
  // a late host report (e.g. the resign echo reaching the hub after the settle)
  // is expected and stays silent — it must not clobber the client's end screen
  send(host, { t: 'result', winner: 1, reason: 'capture' });
  assert.equal(host.sent.length, 0, 'no reply, no double counting');
  assert.equal(store.playerStats(HOST_ID).games, 1);
});

test('the host reports natural endings; guests cannot', () => {
  const store = createStore({ file: null });
  const hub = createRoomHub({ store });
  const { host, guest } = match(hub);
  send(host, { t: 'move', index: 0 });
  send(guest, { t: 'result', winner: 2, reason: 'time' });
  assert.equal(last(guest).code, 'forbidden');
  send(host, { t: 'result', winner: 2, reason: 'time', points: [10, 14] });
  const result = drain(guest).find(m => m.t === 'result');
  assert.ok(result);
  assert.equal(result.winner, 2);
  assert.deepEqual(result.points, [10, 14]);
  assert.equal(result.stats[1].wins, 1);
  assert.equal(result.stats[0].losses, 1);
  // repeated reports after the game ended are swallowed, not re-counted
  drain(host);
  send(host, { t: 'result', winner: 2, reason: 'time' });
  assert.equal(host.sent.length, 0, 'late report gets no reply');
  assert.equal(store.playerStats(HOST_ID).games, 1);
});

test('malformed result reports are rejected without settling', () => {
  const store = createStore({ file: null });
  const hub = createRoomHub({ store });
  const { host, code } = match(hub);
  send(host, { t: 'result', winner: 3 });
  assert.equal(last(host).code, 'badmsg');
  send(host, { t: 'result', winner: '1' });
  assert.equal(last(host).code, 'badmsg');
  send(host, { t: 'result', winner: 1, points: [1, 2, 3] });
  assert.equal(last(host).code, 'badmsg');
  assert.equal(store.playerStats(HOST_ID).games, 0, 'nothing was recorded');
  assert.equal(store.playerStats(GUEST_ID).games, 0);
  assert.equal(hub.roomView(code).phase, 'playing', 'room still live');
});

test('a rematch re-arms the room and the next result is counted again', () => {
  const store = createStore({ file: null });
  const hub = createRoomHub({ store });
  const { host, guest } = match(hub);
  send(host, { t: 'result', winner: 1, reason: 'capture' });
  drain(host); drain(guest);
  send(host, { t: 'restart', size: 7 });
  assert.ok(drain(guest).some(m => m.t === 'restart'));
  send(host, { t: 'result', winner: 2, reason: 'resign' });
  const a = store.playerStats(HOST_ID), b = store.playerStats(GUEST_ID);
  assert.equal(a.games, 2);
  assert.equal(a.wins, 1);
  assert.equal(a.losses, 1);
  assert.equal(b.wins, 1);
  assert.equal(b.streak, 1);
});

test('room replies carry seat stats and reject malformed player ids', () => {
  const store = createStore({ file: null });
  const hub = createRoomHub({ store });
  const host = wire(hub, makeConn());
  send(host, { t: 'create', size: 7, name: '小明', id: 'short' });
  const room = last(host);
  assert.equal(room.stats[0], null, 'invalid id → no profile');
  const guest = wire(hub, makeConn());
  send(guest, { t: 'join', code: room.code, name: '小红', id: GUEST_ID });
  const peer = drain(host).find(m => m.t === 'peer');
  assert.equal(peer.stats.id, GUEST_ID);
  assert.equal(peer.stats.games, 0, 'profile exists with zero games');
  assert.equal(last(guest).stats[1].id, GUEST_ID);
});

test('sweeping an abandoned room removes it from the store; leaving is not scored', () => {
  const store = createStore({ file: null });
  let t = 1000000;
  const hub = createRoomHub({ store, now: () => t });
  const { host, guest, code } = match(hub);
  send(host, { t: 'move', index: 0 });
  host.close(); hub.detach(host, 'left');
  assert.equal(hub.roomView(code).phase, 'ended', 'abandoned on leave');
  assert.equal(store.playerStats(HOST_ID).games, 0, 'leaving mid-game is not a scored result');
  guest.close(); hub.detach(guest, 'drop');
  t += 91 * 1000; // beyond the empty-room TTL
  hub.sweep();
  assert.equal(store.loadRooms().length, 0);
  assert.equal(hub.stats().rooms, 0);
});
