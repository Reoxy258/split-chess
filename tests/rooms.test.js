'use strict';
/* Room hub regression: create/join, relays, compact log, reconnection, TTL, guards. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomHub, clampName } = require('../scripts/rooms.js');

/* Fake transport: records outbound JSON and can be closed at will. */
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
function wire(hub, conn) { hub.attach(conn); return conn; }
function send(conn, obj) { conn.onmessage(JSON.stringify(obj)); }

test('clampName strips control characters and clamps length', () => {
  assert.equal(clampName('  小\u0000明\n '), '小明');
  assert.equal(clampName('一二三四五六七八九十一二三四五'), '一二三四五六七八九十一二');
  assert.equal(clampName(null), '');
});

test('create issues a room code and host token; join fills seat 2 and notifies the host', () => {
  const hub = createRoomHub();
  const host = wire(hub, makeConn());
  send(host, { t: 'create', name: '小明', size: 7 });
  const room = last(host);
  assert.equal(room.t, 'room');
  assert.equal(room.role, 1);
  assert.equal(room.size, 7);
  assert.equal(room.phase, 'waiting');
  assert.match(room.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
  assert.ok(room.token.length >= 16);

  const guest = wire(hub, makeConn());
  send(guest, { t: 'join', code: room.code.toLowerCase(), name: '小红' });
  const joined = last(guest);
  assert.equal(joined.t, 'room');
  assert.equal(joined.role, 2);
  assert.equal(joined.phase, 'playing');
  assert.equal(joined.names[0], '小明');
  assert.equal(joined.names[1], '小红');
  assert.equal(last(host).t, 'peer');
  assert.equal(last(host).role, 2);
  assert.equal(last(host).name, '小红');
  assert.equal(hub.stats().rooms, 1);
});

test('moves are relayed with the mover role and appended to the log', () => {
  const hub = createRoomHub();
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  send(guest, { t: 'join', code });
  drain(host); drain(guest);

  send(host, { t: 'move', index: 0 });
  assert.deepEqual(last(guest), { t: 'move', role: 1, index: 0 });
  send(guest, { t: 'move', index: 6 });
  assert.deepEqual(last(host), { t: 'move', role: 2, index: 6 });
  assert.deepEqual(hub.roomView(code).moves, [0, 6]);
  assert.equal(last(host).t, 'move'); // relay only; no echo to the mover
});

test('host clock snapshots are relayed and compact the log', () => {
  const hub = createRoomHub();
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  send(guest, { t: 'join', code });
  drain(host); drain(guest);

  send(host, { t: 'move', index: 3 });
  const clock = { remaining: 200000, turnRemaining: 15000, overtime: 0, started: true, paused: false };
  send(host, { t: 'clock', clock });
  assert.deepEqual(last(guest), { t: 'clock', role: 1, clock, state: null });
  assert.equal(hub.roomView(code).clock.remaining, 200000);

  // A snapshot carrying full state resets the trailing move log.
  const state = { size: 5, cells: Array.from({ length: 25 }, () => ({ owner: 0, count: 0 })), turn: 1, moves: [1, 1], winner: 0, ply: 2, lastMove: 3 };
  send(host, { t: 'clock', clock, events: ['turn'], state });
  const view = hub.roomView(code);
  assert.deepEqual(view.moves, []);
  assert.equal(view.snapshotState.ply, 2);
  send(host, { t: 'move', index: 7 });
  assert.deepEqual(hub.roomView(code).moves, [7]);
});

test('guest cannot broadcast clock; malformed clocks are rejected', () => {
  const hub = createRoomHub();
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  send(guest, { t: 'join', code });
  drain(guest);

  send(guest, { t: 'clock', clock: { remaining: 1, turnRemaining: 1, overtime: 0, started: true, paused: false } });
  assert.equal(last(guest).code, 'forbidden');
  send(host, { t: 'clock', clock: { remaining: -5, turnRemaining: 1, overtime: 0, started: true, paused: false } });
  assert.equal(last(host).code, 'badmsg');
  send(host, { t: 'clock', clock: { remaining: 1, turnRemaining: 1, overtime: 0, started: true, paused: false }, state: { size: 3 } });
  assert.equal(last(host).code, 'badmsg');
  assert.equal(hub.roomView(code).clock, null);
});

test('join errors: unknown room, full room', () => {
  const hub = createRoomHub();
  const stranger = wire(hub, makeConn());
  send(stranger, { t: 'join', code: 'ZZZZZ' });
  assert.equal(last(stranger).code, 'notfound');

  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  send(guest, { t: 'join', code });
  const third = wire(hub, makeConn());
  send(third, { t: 'join', code });
  assert.equal(last(third).code, 'full');
});

test('create errors: bad size, room limit, double create', () => {
  const hub = createRoomHub({ maxRooms: 1 });
  const host = wire(hub, makeConn());
  send(host, { t: 'create', size: 4 });
  assert.equal(last(host).code, 'badsize');
  send(host, { t: 'create', size: 11 });
  assert.equal(last(host).code, 'badsize');
  send(host, { t: 'create', size: 7 });
  assert.equal(last(host).t, 'room');
  send(host, { t: 'create', size: 7 });
  assert.equal(last(host).code, 'forbidden');

  const other = wire(hub, makeConn());
  send(other, { t: 'create', size: 7 });
  assert.equal(last(other).code, 'limit');
});

test('bad payloads answer badmsg without touching the room', () => {
  const hub = createRoomHub();
  const host = wire(hub, makeConn());
  host.onmessage('not json');
  assert.equal(last(host).code, 'badmsg');
  host.onmessage('{}');
  assert.equal(last(host).code, 'badmsg');
  send(host, { t: 'move', index: 'x' });
  assert.equal(last(host).code, 'forbidden');
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  const guest = wire(hub, makeConn());
  send(guest, { t: 'join', code });
  send(guest, { t: 'wat' });
  assert.equal(last(guest).code, 'badmsg');
  send(guest, { t: 'move', index: 25 });
  assert.equal(last(guest).code, 'badmsg');
});

test('resign ends the room and notifies both seats; the log records it', () => {
  const hub = createRoomHub();
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  send(guest, { t: 'join', code });
  drain(host); drain(guest);

  send(guest, { t: 'resign' });
  assert.deepEqual(last(host), { t: 'resigned', role: 2 });
  assert.deepEqual(last(guest), { t: 'resigned', role: 2 });
  assert.equal(hub.roomView(code).phase, 'ended');
  assert.equal(hub.roomView(code).resigned, 2);
  send(host, { t: 'move', index: 0 });
  assert.equal(last(host).code, 'ended');
});

test('disconnect keeps the room joinable for reconnection; peer is notified', () => {
  const hub = createRoomHub({ now: () => 1000 });
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  const guestToken = (send(guest, { t: 'join', code }), last(guest).token);
  send(host, { t: 'move', index: 2 });
  drain(host);

  hub.detach(guest); // network drop
  assert.equal(last(host).t, 'peer-left');
  assert.equal(last(host).reason, 'drop');
  assert.equal(hub.roomView(code).phase, 'playing'); // still resumable

  const back = wire(hub, makeConn());
  send(back, { t: 'join', code, token: guestToken, name: '小红' });
  const resumed = last(back);
  assert.equal(resumed.t, 'room');
  assert.equal(resumed.role, 2);
  assert.equal(resumed.resume.size, 5);
  assert.deepEqual(resumed.resume.moves, [2]);
  assert.equal(last(host).t, 'peer');
});

test('stranger can take a vacant seat by room code while the game is live', () => {
  const hub = createRoomHub({ now: () => 1000 });
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  send(guest, { t: 'join', code });
  send(host, { t: 'move', index: 2 });
  hub.detach(guest);

  const stranger = wire(hub, makeConn());
  send(stranger, { t: 'join', code, name: '路人' });
  assert.equal(last(stranger).role, 2);
  assert.deepEqual(last(stranger).resume.moves, [2]);
});

test('restart resets the game state and relays to both seats', () => {
  const hub = createRoomHub();
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  send(guest, { t: 'join', code });
  send(host, { t: 'move', index: 2 });
  send(guest, { t: 'resign' });
  drain(host); drain(guest);

  send(host, { t: 'restart', size: 6 });
  assert.deepEqual(last(guest), { t: 'restart', size: 6 });
  assert.deepEqual(last(host), { t: 'restart', size: 6 });
  const view = hub.roomView(code);
  assert.equal(view.phase, 'playing');
  assert.equal(view.size, 6);
  assert.deepEqual(view.moves, []);
  assert.equal(view.clock, null);
  assert.equal(view.resigned, null);
  assert.equal(view.restarts, 1);
  send(host, { t: 'restart', size: 12 });
  assert.equal(last(host).code, 'badsize');
});

test('sync answers with the compact resume payload', () => {
  const hub = createRoomHub();
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 7 });
  const code = last(host).code;
  send(guest, { t: 'join', code });
  send(host, { t: 'move', index: 10 });
  send(guest, { t: 'move', index: 12 });
  drain(guest);

  send(guest, { t: 'sync' });
  const resume = last(guest);
  assert.equal(resume.t, 'resume');
  assert.equal(resume.size, 7);
  assert.deepEqual(resume.moves, [10, 12]);
  assert.equal(resume.phase, 'playing');
});

test('leave marks the room ended for the remaining player', () => {
  const hub = createRoomHub();
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  send(guest, { t: 'join', code });
  drain(host);

  send(guest, { t: 'leave' });
  assert.equal(guest.closed, true);
  assert.equal(last(host).t, 'peer-left');
  assert.equal(last(host).reason, 'left');
  assert.equal(hub.roomView(code).phase, 'ended');
});

test('sweep removes stale and empty rooms but keeps live ones', () => {
  let clock = 1000;
  const hub = createRoomHub({ now: () => clock });
  const host = wire(hub, makeConn()), guest = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  send(guest, { t: 'join', code });

  hub.detach(host);
  hub.detach(guest);
  clock += 60 * 1000; // both vacant: empty TTL (90s) not yet reached
  hub.sweep();
  assert.ok(hub.roomView(code));

  clock += 40 * 1000; // past empty TTL
  hub.sweep();
  assert.equal(hub.roomView(code), null);
  assert.equal(hub.stats().rooms, 0);
});

test('sweep drops rooms idle past the full TTL even while connected', () => {
  let clock = 1000;
  const hub = createRoomHub({ now: () => clock, roomTtlMs: 1000 });
  const host = wire(hub, makeConn());
  send(host, { t: 'create', size: 5 });
  const code = last(host).code;
  clock += 2000;
  hub.sweep();
  assert.equal(hub.roomView(code), null);
});

test('ping answers pong with the round-trip marker', () => {
  const hub = createRoomHub();
  const conn = wire(hub, makeConn());
  send(conn, { t: 'ping', n: 7 });
  assert.deepEqual(last(conn), { t: 'pong', n: 7 });
});
