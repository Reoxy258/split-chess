'use strict';
/* Static game files + online room relay on one port.
   Local dev:  npm start            → http://127.0.0.1:4173/  (rooms at /ws)
   Self-host:  HOST=0.0.0.0 PORT=80 npm scripts/serve.js → serve players over LAN/WAN. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { acceptUpgrade } = require('./ws.js');
const { createRoomHub } = require('./rooms.js');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const hub = createRoomHub();

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: hub.stats().rooms }));
    return;
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
  console.log('Serving http://' + shown + ':' + port + ' (bind ' + host + ') · online rooms at /ws');
});
