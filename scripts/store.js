'use strict';
/* Persistence for online play: player profiles (win/loss/draw + streaks) and
   the live room log that lets a restarted server hand in-progress games back.
   One interface, two interchangeable backends:
   - sqlite:  the built-in node:sqlite module (zero third-party dependencies;
              usable without a flag on Node >= 23.4, experimental on 22.5+)
              writing a single file to disk.
   - memory:  plain Maps, for older runtimes, tests, or read-only disks —
              rooms then live only as long as the process does.
   Both are synchronous. The sqlite backend swallows its own runtime errors
   (logged to stderr once per method) so a failing disk can never take the
   room relay down; loadRooms() always returns an array. */

const fs = require('node:fs');
const path = require('node:path');

const clone = value => JSON.parse(JSON.stringify(value));

function loadSqlite() {
  try { return require('node:sqlite'); } catch { return null; }
}

function createStore(options = {}) {
  const file = options.file;
  if (!file || file === ':memory:') return createMemoryStore();
  const sqlite = 'sqlite' in options ? options.sqlite : loadSqlite();
  if (!sqlite) {
    console.error('store: node:sqlite unavailable → rooms stay in memory (no restart recovery)');
    return createMemoryStore();
  }
  try {
    return guard(createSqliteStore({ file: String(file), sqlite }));
  } catch (error) {
    console.error('store: cannot open ' + file + ' (' + ((error && error.message) || error) + ') → rooms stay in memory');
    return createMemoryStore();
  }
}

function createMemoryStore() {
  const rooms = new Map();   // code -> room record
  const players = new Map(); // id -> profile
  const games = [];
  const touch = (id, name) => {
    if (!id) return null;
    let player = players.get(id);
    if (!player) {
      player = { id, name: '', wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0, games: 0, updatedAt: 0 };
      players.set(id, player);
    }
    if (name) player.name = String(name).slice(0, 12);
    player.updatedAt = Date.now();
    return player;
  };
  const apply = (id, outcome) => {
    const player = touch(id, '');
    if (!player) return;
    player.games++;
    if (outcome === 'win') { player.wins++; player.streak = player.streak > 0 ? player.streak + 1 : 1; if (player.streak > player.bestStreak) player.bestStreak = player.streak; }
    else if (outcome === 'loss') { player.losses++; player.streak = player.streak < 0 ? player.streak - 1 : -1; }
    else { player.draws++; player.streak = 0; }
  };
  return {
    mode: 'memory',
    saveRoom(record) { rooms.set(record.code, clone(record)); },
    loadRooms() { return [...rooms.values()].filter(room => room.phase !== 'ended').map(clone); },
    deleteRoom(code) { rooms.delete(code); },
    upsertPlayer(id, name) { touch(id, name); },
    recordResult({ code, size, winner, reason, points, seats, finishedAt }) {
      games.push({ code, size, winner, reason: reason || '', points: points || null, seats: clone(seats || {}), finishedAt: finishedAt ?? Date.now() });
      const outcomes = winner === 1 ? ['win', 'loss'] : winner === 2 ? ['loss', 'win'] : ['draw', 'draw'];
      apply(seats?.[1]?.id, outcomes[0]);
      apply(seats?.[2]?.id, outcomes[1]);
    },
    playerStats(id) { return players.has(id) ? clone(players.get(id)) : null; },
    summary: () => ({ rooms: rooms.size, players: players.size, games: games.length }),
    close() {},
  };
}

function createSqliteStore({ file, sqlite }) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      draws INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      best_streak INTEGER NOT NULL DEFAULT 0,
      games INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      phase TEXT NOT NULL,
      restarts INTEGER NOT NULL DEFAULT 0,
      recorded INTEGER NOT NULL DEFAULT 0,
      moves TEXT NOT NULL DEFAULT '[]',
      clock TEXT,
      snapshot_state TEXT,
      resigned INTEGER,
      seat1 TEXT NOT NULL DEFAULT '{}',
      seat2 TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 0,
      last_seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      size INTEGER,
      winner INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      points TEXT,
      seat1 TEXT NOT NULL DEFAULT '{}',
      seat2 TEXT NOT NULL DEFAULT '{}',
      finished_at INTEGER NOT NULL DEFAULT 0
    );
  `);
  const stmt = {
    putRoom: db.prepare(`INSERT OR REPLACE INTO rooms
      (code, size, phase, restarts, recorded, moves, clock, snapshot_state, resigned, seat1, seat2, created_at, last_seen)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    activeRooms: db.prepare(`SELECT * FROM rooms WHERE phase != 'ended'`),
    dropRoom: db.prepare(`DELETE FROM rooms WHERE code = ?`),
    addGame: db.prepare(`INSERT INTO games (code, size, winner, reason, points, seat1, seat2, finished_at) VALUES (?,?,?,?,?,?,?,?)`),
    findPlayer: db.prepare(`SELECT * FROM players WHERE id = ?`),
    putPlayer: db.prepare(`INSERT INTO players (id, name, wins, losses, draws, streak, best_streak, games, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, wins = excluded.wins, losses = excluded.losses, draws = excluded.draws,
        streak = excluded.streak, best_streak = excluded.best_streak, games = excluded.games, updated_at = excluded.updated_at`),
    touchPlayer: db.prepare(`INSERT INTO players (id, name, updated_at) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE players.name END,
        updated_at = excluded.updated_at`),
    count: table => db.prepare(`SELECT COUNT(*) AS n FROM ` + table).get().n,
  };
  const json = value => value == null ? null : JSON.stringify(value);
  const rowToRoom = row => ({
    code: row.code, size: row.size, phase: row.phase, restarts: row.restarts, recorded: !!row.recorded,
    moves: JSON.parse(row.moves || '[]'),
    clock: row.clock ? JSON.parse(row.clock) : null,
    snapshotState: row.snapshot_state ? JSON.parse(row.snapshot_state) : null,
    resigned: row.resigned ?? null,
    seats: { 1: JSON.parse(row.seat1 || '{}'), 2: JSON.parse(row.seat2 || '{}') },
    createdAt: row.created_at, lastSeen: row.last_seen,
  });
  const rowToStats = row => row ? {
    id: row.id, name: row.name, wins: row.wins, losses: row.losses, draws: row.draws,
    streak: row.streak, bestStreak: row.best_streak, games: row.games, updatedAt: row.updated_at,
  } : null;
  const applyOutcome = (id, name, outcome) => {
    if (!id) return;
    const current = stmt.findPlayer.get(id) || {};
    const next = { wins: current.wins || 0, losses: current.losses || 0, draws: current.draws || 0, streak: current.streak || 0, best_streak: current.best_streak || 0, games: current.games || 0 };
    next.games++;
    if (outcome === 'win') { next.wins++; next.streak = next.streak > 0 ? next.streak + 1 : 1; if (next.streak > next.best_streak) next.best_streak = next.streak; }
    else if (outcome === 'loss') { next.losses++; next.streak = next.streak < 0 ? next.streak - 1 : -1; }
    else { next.draws++; next.streak = 0; }
    stmt.putPlayer.run(id, String(name || current.name || '').slice(0, 12), next.wins, next.losses, next.draws, next.streak, next.best_streak, next.games, Date.now());
  };
  return {
    mode: 'sqlite',
    saveRoom(record) {
      stmt.putRoom.run(
        record.code, record.size, record.phase, record.restarts || 0, record.recorded ? 1 : 0,
        json(record.moves || []), json(record.clock || null), json(record.snapshotState || null),
        record.resigned ?? null,
        json(record.seats?.[1] || {}), json(record.seats?.[2] || {}),
        record.createdAt || 0, record.lastSeen || 0,
      );
    },
    loadRooms() { return stmt.activeRooms.all().map(rowToRoom); },
    deleteRoom(code) { stmt.dropRoom.run(code); },
    upsertPlayer(id, name) { if (id) stmt.touchPlayer.run(id, String(name || '').slice(0, 12), Date.now()); },
    recordResult({ code, size, winner, reason, points, seats, finishedAt }) {
      const a = seats?.[1] || {}, b = seats?.[2] || {};
      db.exec('BEGIN');
      try {
        stmt.addGame.run(code ?? null, size ?? null, winner, String(reason || ''), json(points || null), json(a), json(b), finishedAt ?? Date.now());
        const outcomes = winner === 1 ? ['win', 'loss'] : winner === 2 ? ['loss', 'win'] : ['draw', 'draw'];
        applyOutcome(a.id, a.name, outcomes[0]);
        applyOutcome(b.id, b.name, outcomes[1]);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    playerStats(id) { return id ? rowToStats(stmt.findPlayer.get(id)) : null; },
    summary: () => ({ rooms: stmt.count('rooms'), players: stmt.count('players'), games: stmt.count('games') }),
    close() { db.close(); },
  };
}

/* Best-effort wrapper: a backend that starts healthy but fails at runtime
   (disk full, file deleted, …) degrades to no-ops instead of crashing relay
   connections. Each method logs its first failure only. */
function guard(store) {
  const warned = new Set();
  const wrapped = { mode: store.mode };
  for (const key of Object.keys(store)) {
    if (key === 'mode' || typeof store[key] !== 'function') continue;
    wrapped[key] = (...args) => {
      try { return store[key](...args); } catch (error) {
        if (!warned.has(key)) {
          warned.add(key);
          console.error('store: ' + key + ' failed (' + ((error && error.message) || error) + '), continuing without it');
        }
        return undefined;
      }
    };
  }
  return wrapped;
}

module.exports = { createStore };
