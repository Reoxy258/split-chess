'use strict';
/* Two full app.js instances in separate VMs, wired through the real room hub
   with fake WebSockets. Covers room setup, lockstep moves, clock authority,
   resignation, rematch, desync recovery, reconnection and v3 save restore. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../engine.js');
const { createRoomHub } = require('../scripts/rooms.js');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const netSource = fs.readFileSync(path.join(__dirname, '..', 'net.js'), 'utf8');
const Net = require('../net.js');
const SAVE = 'split-chess.save.v1';

test('invitation joins automatically, overrides a stale server, and contains no seat token', async () => {
  const hub = createRoomHub();
  const host = fixture({ hub });
  host.get('mode-online').click();
  host.get('room-create').click();
  await host.tick();
  const link = host.get('room-invite-link').value;
  assert.ok(link);
  assert.equal(new URL(link).searchParams.get('room'), host.save().online.code);
  assert.ok(!link.includes(host.save().online.token));
  const guest = fixture({ hub, href: link, rememberedServer: 'old.example.com',
    rawSave: host.store.get(SAVE) }); // same-browser tabs share localStorage
  await guest.tick();
  assert.equal(guest.save().online.role, 2, 'invite does not steal the host identity');
  assert.equal(guest.sockets[0].url, host.sockets[0].url);
  assert.equal(guest.get('room-dialog').open, false);
  const saved = guest.store.get(SAVE);
  guest.sockets[0].close();
  const reload = fixture({ hub, href: link, rawSave: saved, seatStore: guest.seatStore });
  await reload.tick();
  assert.equal(reload.save().online.role, 2);
  assert.equal(reload.save().online.token, guest.save().online.token);
  host.sockets[0].close();
  const hostReload = fixture({ hub, rawSave: guest.store.get(SAVE), seatStore: host.seatStore });
  await hostReload.tick();
  assert.equal(hostReload.save().online.role, 1, 'host tab keeps its own save when another tab writes localStorage');
});

test('Pages uses the maintained default server and expired invitations stay actionable', async () => {
  const hub = createRoomHub();
  const page = fixture({ hub, href: 'https://example.github.io/split-chess/',
    configuredServer: 'wss://relay.example.com/ws' });
  page.get('mode-online').click();
  page.get('room-create').click();
  await page.tick();
  assert.equal(page.sockets[0].url, 'wss://relay.example.com/ws');
  const invalid = fixture({ hub, href: 'https://example.github.io/split-chess/?room=ZZZZZ&server=relay.example.com' });
  await invalid.tick();
  assert.match(invalid.get('room-status').textContent, /过期/);
  assert.equal(invalid.get('room-create').disabled, false);
});

test('malformed invite does not connect and a slow initial connection can be retried', async () => {
  const hub = createRoomHub();
  const invalid = fixture({ hub, href: 'http://127.0.0.1:4173/?room=invalid' });
  assert.equal(invalid.sockets.length, 0);
  const page = fixture({ hub });
  page.get('mode-online').click();
  page.get('room-create').click();
  page.sockets[0].readyState = 2; // simulate stalled handshake
  await page.tick();
  await page.tick(); // 90s deadline
  assert.equal(page.get('room-create').disabled, false);
  assert.match(page.get('room-status').textContent, /连接/);
});

test('normalizeUrl completes bare addresses with scheme and /ws path', () => {
  // Node has no page location: bare hosts resolve over plain ws://.
  assert.equal(Net.normalizeUrl('split-chess.onrender.com'), 'ws://split-chess.onrender.com/ws');
  assert.equal(Net.normalizeUrl(' 127.0.0.1:4174 '), 'ws://127.0.0.1:4174/ws');
  assert.equal(Net.normalizeUrl('ws://127.0.0.1:4174'), 'ws://127.0.0.1:4174/ws');
  assert.equal(Net.normalizeUrl('ws://127.0.0.1:4174/ws'), 'ws://127.0.0.1:4174/ws'); // path preserved
  assert.equal(Net.normalizeUrl('https://split-chess.onrender.com'), 'ws://split-chess.onrender.com/ws'); // prefix stripped
  assert.equal(Net.normalizeUrl(''), null);
  assert.equal(Net.normalizeUrl(null), null);
  assert.equal(Net.normalizeUrl('   '), null);
});

test('normalizeUrl upgrades to wss on https pages', () => {
  const ctx = { location: { protocol: 'https:' } };
  vm.createContext(ctx);
  vm.runInContext(netSource, ctx);
  const NetHttps = ctx.SplitChessNet;
  assert.ok(NetHttps, 'net.js attaches to the vm global');
  assert.equal(NetHttps.normalizeUrl('split-chess.onrender.com'), 'wss://split-chess.onrender.com/ws');
  assert.equal(NetHttps.normalizeUrl('ws://insecure.example.com'), 'wss://insecure.example.com/ws'); // ws upgraded on https
  assert.equal(NetHttps.normalizeUrl('wss://secure.example.com/ws'), 'wss://secure.example.com/ws');
});

const WS_CLASS = `
globalThis.WebSocket = class {
  constructor(url) {
    this.url = url; this.readyState = 0;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    __sockets.push(this);
    const self = this;
    this.__conn = {
      send(text) { self.onmessage && self.onmessage({ data: text }); },
      close() { self.__forceClose(); },
    };
    __hub.attach(this.__conn);
    setTimeout(() => { if (self.readyState === 0) { self.readyState = 1; self.onopen && self.onopen(); } }, 0);
  }
  send(text) { if (this.readyState !== 1) throw new Error('WebSocket is closed'); __hub.receive(this.__conn, text); }
  close() { this.__forceClose(); }
  __forceClose() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    __hub.detach(this.__conn);
    this.onclose && this.onclose();
  }
};
`;

function fixture({ rawSave, hub, href = 'http://127.0.0.1:4173/', rememberedServer, configuredServer, seatStore = new Map() }) {
  const ids = new Map(), timers = [], events = {}, store = new Map(), sockets = [];
  const intervals = [], documentEvents = {};
  let now = 0;
  let timerId = 0;
  store.set(SAVE, rawSave === undefined ? JSON.stringify({ version: 2, state: E.newGame(), mode: 'local', quick: false, history: [], clock: E.newClock(7) }) : rawSave);
  store.set('split-chess.learned.v1', '1');
  if (rememberedServer) store.set('split-chess.server.v1', rememberedServer);
  class El {
    constructor() {
      this.children = []; this.listeners = {}; this.dataset = {}; this.style = { setProperty(key, value) { this[key] = value; } };
      this.classList = { toggle() {}, add() {} };
    }
    append(...v) { this.children.push(...v); }
    replaceChildren() { this.children = []; }
    setAttribute(k, v) { this[k] = v; }
    addEventListener(k, v) { this.listeners[k] = v; }
    scrollIntoView() {}
    scrollTo(options) { this.scrollLeft = options.left || 0; this.scrollTop = options.top || 0; }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    animate() {}
    click() { if (!this.disabled) (this.onclick || this.listeners.click)?.(); }
  }
  const get = id => { if (!ids.has(id)) ids.set(id, new El()); return ids.get(id); };
  const doc = { hidden: false, addEventListener: (key, fn) => documentEvents[key] = fn, getElementById: get, createElement: () => new El(), createElementNS: () => new El(), querySelectorAll: () => [], body: new El() };
  const sandbox = {
    SplitChess: E,
    document: doc,
    performance: { now: () => now },
    setInterval: fn => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn, delay) => { const id = ++timerId; timers.push({ fn, delay, id }); return id; },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
    sessionStorage: { getItem: k => seatStore.get(k) ?? null, setItem: (k, v) => seatStore.set(k, v) },
    location: new URL(href),
    URL,
    URLSearchParams,
    __hub: hub,
    __sockets: sockets,
    addEventListener: (k, v) => { events[k] = v; },
    console: { log() {}, error() {} },
  };
  sandbox.window = sandbox;
  doc.querySelector = () => configuredServer ? { content: configuredServer } : null;
  const context = vm.createContext(sandbox);
  vm.runInContext(netSource, context);
  vm.runInContext(WS_CLASS, context);
  vm.runInContext(appSource, context);
  async function tick() {
    const timer = timers.shift();
    if (timer) timer.fn();
    for (let j = 0; j < 20; j++) await Promise.resolve();
  }
  async function settle(rounds = 80) {
    for (let i = 0; i < rounds; i++) { await tick(); }
  }
  return {
    get, sockets, store, seatStore, tick, settle,
    advance(ms) { now += ms; intervals.forEach(fn => fn()); },
    save: () => JSON.parse(store.get(SAVE)),
    cell: i => get('board').children[i],
    state: () => save2state(store),
  };
  function save2state(st) { return JSON.parse(st.get(SAVE)).state; }
}

/* Create a room on the host side and join from the guest side. */
async function matchUp() {
  const hub = createRoomHub();
  const host = fixture({ hub }), guest = fixture({ hub });
  host.get('mode-online').click();
  host.get('net-name').value = '小明';
  host.get('room-create').click();
  await host.tick(); // socket opens, create is answered with a waiting room
  const code = host.save().online.code;
  assert.ok(host.get('room-dialog').open, 'host stays in the waiting view');
  assert.equal(host.save().mode, 'online');

  guest.get('mode-online').click();
  guest.get('net-name').value = '小红';
  guest.get('room-code').value = code;
  guest.get('room-join').click();
  await guest.tick(); // guest joins, host is notified of the peer
  await host.tick();
  assert.equal(guest.get('room-dialog').open, false);
  assert.equal(host.get('room-dialog').open, false);
  assert.equal(host.save().online.peerName, '小红');
  assert.equal(guest.save().online.peerName, '小明');
  assert.equal(host.save().online.role, 1);
  assert.equal(guest.save().online.role, 2);
  return { hub, host, guest, code };
}

/* Play the first legal move for whoever holds the turn; settle both sides. */
async function autoMove({ host, guest }) {
  const state = host.save().state;
  if (state.winner) return false;
  const index = E.legalMoves(state)[0];
  const side = state.turn === 1 ? host : guest;
  side.cell(index).click();
  await host.settle(); await guest.settle();
  host.advance(1000); guest.advance(1000);
  await host.settle(4); await guest.settle(4);
  return true;
}

test('host creates a room and the guest joins; both boards start empty and in sync', async () => {
  const { host, guest } = await matchUp();
  assert.equal(host.save().state.ply, 0);
  assert.deepEqual(guest.save().state.cells, host.save().state.cells);
  assert.equal(guest.save().state.size, host.save().state.size);
  assert.match(host.get('status').textContent, /已就位|房间已就绪/);
  assert.equal(host.get('mode-label').textContent, '在线对战');
  assert.equal(host.get('name-2').textContent, '小红 · 橙方');
  assert.equal(guest.get('name-1').textContent, '小明 · 蓝方');
  assert.equal(host.get('resign-button').hidden, false);
  assert.equal(host.get('leave-room-button').hidden, false);
  assert.equal(host.get('restart-button').hidden, true);
  assert.equal(host.get('undo-button').disabled, true); // online play has no undo
  assert.equal(host.get('board-size').disabled, true); // size locked during a room
});

test('lockstep: moves made on one side replay identically on the other', async () => {
  const { host, guest } = await matchUp();
  let ply = 0;
  while (ply < 16 && !host.save().state.winner) {
    const before = host.save().state.ply;
    assert.ok(await autoMove({ host, guest }), 'move ' + (ply + 1) + ' should be playable');
    assert.equal(host.save().state.ply, before + 1, 'ply advances on the host');
    assert.deepEqual(guest.save().state, host.save().state, 'sides stay identical after move ' + (before + 1));
    ply++;
  }
  // Naive play may legitimately clear a side within 16 plies; either way both sides agree.
  assert.equal(guest.save().state.winner, host.save().state.winner);
  assert.equal(host.save().online.code, guest.save().online.code);
});

test('clock skip events from the host authority reach the guest state', async () => {
  const { host, guest } = await matchUp();
  // Host moves: the clock starts and it becomes the guest's turn (20s limit on 7x7).
  assert.ok(await autoMove({ host, guest }));
  assert.equal(host.save().state.turn, 2);
  // Nobody moves; the host authority passes 21 seconds and skips the guest's turn.
  host.advance(21000);
  await host.settle(2); await guest.settle(2);
  const hostState = host.save().state, guestState = guest.save().state;
  assert.equal(hostState.turn, 1, 'turn skipped back to blue');
  assert.equal(hostState.ply, 2, 'skip counts as a ply');
  assert.deepEqual(guestState, hostState, 'guest follows the authoritative skip');
  assert.ok(guestState.skipped >= 1 || hostState.skipped >= 1);
});

test('resignation ends the match on both sides; rematch restarts it', async () => {
  const { host, guest } = await matchUp();
  assert.ok(await autoMove({ host, guest }));
  assert.ok(await autoMove({ host, guest }));

  guest.get('resign-button').click();
  assert.ok(guest.get('confirm-dialog').open);
  guest.get('confirm-ok').click();
  await guest.settle(2); await host.settle(2);
  assert.equal(host.save().state.winner, 1, 'host wins by resignation');
  assert.equal(host.save().state.resultReason, 'resign');
  assert.deepEqual(guest.save().state, host.save().state);

  // Winner asks for a rematch; the opponent confirms; both restart in sync.
  host.get('coach-action').click();
  assert.ok(guest.get('confirm-dialog').open, 'guest sees the rematch request');
  guest.get('confirm-ok').click();
  await host.settle(2); await guest.settle(2);
  assert.equal(host.save().state.ply, 0, 'fresh board after rematch');
  assert.equal(host.save().state.winner, 0);
  assert.deepEqual(guest.save().state, host.save().state);
  assert.match(host.get('status').textContent, /新的一局开始/);
});

test('an illegal inbound move triggers a log resync instead of corrupting the board', async () => {
  const { host, guest } = await matchUp();
  assert.ok(await autoMove({ host, guest }));
  const expected = host.save().state;

  // Inject a bogus relay (index far out of range) straight into the guest socket.
  guest.sockets[0].onmessage({ data: JSON.stringify({ t: 'move', role: 1, index: 9999 }) });
  await guest.settle(4);
  assert.deepEqual(guest.save().state, expected, 'board unchanged after garbage');
  assert.match(guest.get('status').textContent, /同步/);

  // A desynced guest also heals through the same path.
  guest.sockets[0].onmessage({ data: JSON.stringify({ t: 'move', role: 1, index: 5 }) });
  await guest.settle(4);
  assert.deepEqual(guest.save().state, expected);
});

test('a dropped guest auto-reconnects and resumes from the room log', async () => {
  const { host, guest } = await matchUp();
  assert.ok(await autoMove({ host, guest }));
  assert.ok(await autoMove({ host, guest }));

  guest.sockets[0].close(); // network drop
  await host.settle(2);
  assert.match(host.get('status').textContent, /掉线/);

  // Session reconnect timer fires, opens a new socket, rejoins with the token.
  await guest.tick();
  assert.equal(guest.sockets.length, 2, 'a replacement socket was created');
  await guest.tick(); // open + rejoin, hub answers with a resume payload
  await guest.settle(8); await host.settle(4);
  assert.deepEqual(guest.save().state, host.save().state, 'resumed board matches');
  assert.match(host.get('status').textContent, /已就位|房间已就绪|轮到你/);
  assert.equal(host.save().online.peerGone ?? false, false);
});

test('a v3 online save reconnects automatically on load', async () => {
  const hub = createRoomHub();
  const host = fixture({ hub }), first = fixture({ hub });
  host.get('mode-online').click();
  host.get('room-create').click();
  await host.tick();
  const code = host.save().online.code;
  first.get('mode-online').click();
  first.get('room-code').value = code;
  first.get('room-join').click();
  await first.tick(); await host.tick();
  assert.ok(await autoMove({ host, guest: first }));
  assert.ok(await autoMove({ host, guest: first }));

  const saved = first.store.get(SAVE); // what a reload would restore
  first.sockets[0].close(); // the old page goes away
  await host.settle(2);

  const reloaded = fixture({ rawSave: saved, hub });
  await reloaded.tick(); // boot: auto rejoin with the stored token
  await reloaded.tick(); // open + resume
  await reloaded.settle(8);
  assert.equal(reloaded.save().mode, 'online');
  assert.equal(reloaded.save().online.role, 2);
  assert.deepEqual(reloaded.save().state, host.save().state, 'reload restores the exact board');
});

