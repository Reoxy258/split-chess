'use strict';
/* Static game files + online room relay on one port.
   Local dev:  npm start            → http://127.0.0.1:4173/  (rooms at /ws)
   Self-host:  HOST=0.0.0.0 PORT=80 npm scripts/serve.js → serve players over LAN/WAN.
   Persistence: SPLIT_CHESS_DB selects the SQLite file (default data/split-chess.sqlite,
   created on demand; ':memory:' disables the file) → rooms survive restarts and
   player win/loss records are kept. Without node:sqlite the server still runs,
   rooms just stay in memory. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { acceptUpgrade } = require('./ws.js');
const { createRoomHub } = require('./rooms.js');
const { createStore } = require('./store.js');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const dbSpec = process.env.SPLIT_CHESS_DB ?? path.join(root, 'data', 'split-chess.sqlite');
const store = createStore({ file: dbSpec && dbSpec !== ':memory:' ? dbSpec : null });
const hub = createRoomHub({ store });
const reply = (res, status, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  if (pathname === '/healthz') return reply(res, 200, { ok: true, ...hub.stats(), store: store.mode });
  if (pathname.startsWith('/api/stats/')) {
    const id = pathname.slice('/api/stats/'.length);
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return reply(res, 400, { error: 'bad id' });
    const stats = store.playerStats(id);
    if (!stats) return reply(res, 404, { error: 'unknown player' });
    return reply(res, 200, stats);
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const ws = acceptUpgrade(req, socket, { path: '/ws' });
  if (!ws) return;
  ws.startKeepalive(20000);
  const wrapper = { send: text => ws.send(text), close: () => ws.close(), onmessage: null, onclose: null };
  ws.onmessage = text => wrapper.onmessage?.(text);
  ws.onclose = () => wrapper.onclose?.();
  hub.attach(wrapper);
});

const sweeper = setInterval(() => hub.sweep(), 30000);
sweeper.unref();
server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? '127.0.0.1' : host;
  const persisted = store.mode === 'sqlite' ? ' · storage: sqlite (' + dbSpec + ')' : ' · storage: in-memory (no restart recovery)';
  const restored = hub.stats().restored ? ' · restored ' + hub.stats().restored + ' room(s)' : '';
  console.log('Serving http://' + shown + ':' + port + ' (bind ' + host + ') · online rooms at /ws' + persisted + restored);
});
