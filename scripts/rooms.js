'use strict';
/* Room hub: relay + move log for two-seat online matches. Transport-agnostic.
   The host seat (role 1, blue) is the game authority: it owns the clock and
   broadcasts snapshots; this hub only validates shapes, relays, and keeps a
   compact log (latest authoritative state + trailing moves) for reconnection. */
const crypto = require('node:crypto');

const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L confusables
const DEFAULTS = {
  codeLength: 5,
  maxRooms: 500,
  maxMessageBytes: 16 * 1024,
  maxMoves: 2000,
  roomTtlMs: 10 * 60 * 1000,
  emptyTtlMs: 90 * 1000,
  now: Date.now,
  randomBytes: crypto.randomBytes,
};

function clampName(raw) {
  return String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
}
function isIndex(index, size) {
  return Number.isInteger(index) && index >= 0 && index < size * size;
}
function validClockShape(clock) {
  return !!clock && [clock.remaining, clock.turnRemaining, clock.overtime].every(n => Number.isFinite(n) && n >= 0) &&
    Number.isSafeInteger(clock.overtime) && typeof clock.started === 'boolean' && typeof clock.paused === 'boolean';
}
function validStateShape(state) {
  return !!state && Number.isInteger(state.size) && state.size >= 2 && state.size <= 10 &&
    Array.isArray(state.cells) && state.cells.length === state.size * state.size;
}

function createRoomHub(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const rooms = new Map();
  const conns = new Map(); // conn -> { room, seat }
  const send = (conn, payload) => { try { conn.send(JSON.stringify(payload)); return true; } catch { return false; } };
  const otherSeat = seat => seat === 1 ? 2 : 1;

  function newCode() {
    for (let attempt = 0; attempt < 64; attempt++) {
      const bytes = cfg.randomBytes(cfg.codeLength);
      let code = '';
      for (let i = 0; i < cfg.codeLength; i++) code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
      if (!rooms.has(code)) return code;
    }
    throw new Error('Ran out of room codes');
  }
  function makeToken() { return cfg.randomBytes(12).toString('hex'); }

  function snapshot(room) {
    return { t: 'resume', size: room.size, state: room.snapshotState, moves: [...room.moves], clock: room.clock, phase: room.phase, resigned: room.resigned, restarts: room.restarts, names: [room.seats[1].name, room.seats[2].name] };
  }
  function roomInfo(room, role, token) {
    const payload = { t: 'room', code: room.code, role, token, size: room.size, phase: room.phase, names: [room.seats[1].name, room.seats[2].name], connected: [!!room.seats[1].conn, !!room.seats[2].conn], restarts: room.restarts };
    if (room.phase !== 'waiting') payload.resume = snapshot(room);
    return payload;
  }
  function notifyPeer(room, seat, event) {
    const peer = room.seats[otherSeat(seat)];
    if (peer.conn) send(peer.conn, event);
  }
  function touch(room) { room.lastSeen = cfg.now(); }

  function attach(conn) {
    conn.__closed = false;
    conn.onmessage = text => receive(conn, text);
    conn.onclose = () => detach(conn, 'drop');
  }
  function detach(conn, reason) {
    if (conn.__closed) return;
    conn.__closed = true;
    const entry = conns.get(conn);
    if (!entry) return;
    conns.delete(conn);
    const room = entry.room, seat = entry.seat;
    room.seats[seat].conn = null;
    touch(room);
    notifyPeer(room, seat, { t: 'peer-left', role: seat, reason: reason === 'left' ? 'left' : 'drop' });
    if (reason === 'left') { room.phase = 'ended'; room.seats[seat].token = null; }
  }

  function receive(conn, text) {
    if (typeof text !== 'string' || text.length > cfg.maxMessageBytes) { send(conn, { t: 'error', code: 'badmsg' }); return; }
    let msg;
    try { msg = JSON.parse(text); } catch { send(conn, { t: 'error', code: 'badmsg' }); return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') { send(conn, { t: 'error', code: 'badmsg' }); return; }
    const entry = conns.get(conn);
    if (msg.t === 'create') return handleCreate(conn, msg);
    if (msg.t === 'join') return handleJoin(conn, msg);
    if (msg.t === 'ping') { if (entry) touch(entry.room); return send(conn, { t: 'pong', n: msg.n ?? 0 }); }
    if (!entry) return send(conn, { t: 'error', code: 'forbidden' });
    const room = entry.room, seat = entry.seat;
    touch(room);
    switch (msg.t) {
      case 'move': {
        if (room.phase !== 'playing') return send(conn, { t: 'error', code: room.phase === 'ended' ? 'ended' : 'idle' });
        if (!isIndex(msg.index, room.size)) return send(conn, { t: 'error', code: 'badmsg' });
        if (room.moves.length >= cfg.maxMoves) return send(conn, { t: 'error', code: 'limit' });
        room.moves.push(msg.index);
        notifyPeer(room, seat, { t: 'move', role: seat, index: msg.index });
        return;
      }
      case 'clock': {
        if (seat !== 1) return send(conn, { t: 'error', code: 'forbidden' });
        if (!validClockShape(msg.clock)) return send(conn, { t: 'error', code: 'badmsg' });
        if (msg.state && !validStateShape(msg.state)) return send(conn, { t: 'error', code: 'badmsg' });
        room.clock = { ...msg.clock };
        if (msg.state) { room.snapshotState = msg.state; room.moves = []; }
        notifyPeer(room, seat, { t: 'clock', role: 1, clock: room.clock, events: msg.events, state: msg.state ?? null });
        return;
      }
      case 'start': return notifyPeer(room, seat, { t: 'start', role: seat });
      case 'resign': {
        if (room.phase === 'ended') return send(conn, { t: 'error', code: 'ended' });
        room.resigned = seat;
        room.phase = 'ended';
        [1, 2].forEach(s => room.seats[s].conn && send(room.seats[s].conn, { t: 'resigned', role: seat }));
        return;
      }
      case 'rematch': return notifyPeer(room, seat, { t: 'rematch-req', role: seat });
      case 'rematch-ok': return notifyPeer(room, seat, { t: 'rematch-ack', role: seat });
      case 'restart': {
        if (!Number.isInteger(msg.size) || msg.size < 5 || msg.size > 10) return send(conn, { t: 'error', code: 'badsize' });
        room.size = msg.size; room.phase = 'playing'; room.moves = []; room.clock = null;
        room.snapshotState = null; room.resigned = null; room.restarts++;
        [1, 2].forEach(s => room.seats[s].conn && send(room.seats[s].conn, { t: 'restart', size: room.size }));
        return;
      }
      case 'sync': return send(conn, snapshot(room));
      case 'leave': { detach(conn, 'left'); try { conn.close(); } catch { /* already gone */ } return; }
      default: return send(conn, { t: 'error', code: 'badmsg' });
    }
  }

  function handleCreate(conn, msg) {
    if (conns.has(conn)) return send(conn, { t: 'error', code: 'forbidden' });
    const size = msg.size;
    if (!Number.isInteger(size) || size < 5 || size > 10) return send(conn, { t: 'error', code: 'badsize' });
    if (rooms.size >= cfg.maxRooms) return send(conn, { t: 'error', code: 'limit' });
    const code = newCode();
    const room = {
      code, size, phase: 'waiting', restarts: 0, createdAt: cfg.now(), lastSeen: cfg.now(),
      moves: [], clock: null, snapshotState: null, resigned: null,
      seats: { 1: { conn: null, token: makeToken(), name: clampName(msg.name) || '蓝方' }, 2: { conn: null, token: makeToken(), name: '' } },
    };
    rooms.set(code, room);
    room.seats[1].conn = conn;
    conns.set(conn, { room, seat: 1 });
    send(conn, roomInfo(room, 1, room.seats[1].token));
  }

  function handleJoin(conn, msg) {
    if (conns.has(conn)) return send(conn, { t: 'error', code: 'forbidden' });
    const code = String(msg.code ?? '').toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(conn, { t: 'error', code: 'notfound' });
    touch(room);
    const token = typeof msg.token === 'string' ? msg.token : null;
    let seat = 0;
    if (token) { // token holders reclaim their own seat when it is vacant
      for (const s of [1, 2]) if (room.seats[s].token === token && !room.seats[s].conn) { seat = s; break; }
    }
    if (token && !seat) return send(conn, { t: 'error', code: 'forbidden' });
    // A public invitation can only claim the never-used guest seat.
    // Disconnected players keep their seats, protected by their private token.
    if (!seat && room.phase === 'waiting' && !room.seats[2].name) seat = 2;
    if (!seat) return send(conn, { t: 'error', code: 'full' });
    const resumeSeat = room.seats[seat];
    resumeSeat.conn = conn;
    resumeSeat.name = clampName(msg.name) || resumeSeat.name || (seat === 2 ? '橙方' : '蓝方');
    conns.set(conn, { room, seat });
    if (room.phase === 'waiting' && room.seats[1].conn && room.seats[2].conn) room.phase = 'playing';
    send(conn, roomInfo(room, seat, resumeSeat.token));
    notifyPeer(room, seat, { t: 'peer', role: seat, name: resumeSeat.name });
  }

  function sweep() {
    const time = cfg.now();
    for (const [code, room] of rooms) {
      const vacant = !room.seats[1].conn && !room.seats[2].conn;
      if (time - room.lastSeen > cfg.roomTtlMs || (vacant && time - room.lastSeen > cfg.emptyTtlMs)) rooms.delete(code);
    }
    return rooms.size;
  }

  function roomView(code) {
    const room = rooms.get(String(code).toUpperCase());
    if (!room) return null;
    return {
      code: room.code, size: room.size, phase: room.phase, restarts: room.restarts,
      moves: [...room.moves], clock: room.clock, resigned: room.resigned,
      names: [room.seats[1].name, room.seats[2].name],
      snapshotState: room.snapshotState,
      seats: { 1: { connected: !!room.seats[1].conn, name: room.seats[1].name }, 2: { connected: !!room.seats[2].conn, name: room.seats[2].name } },
    };
  }

  return { attach, receive, detach, sweep, roomView, stats: () => ({ rooms: rooms.size }) };
}

module.exports = { createRoomHub, clampName, CODE_CHARS };

