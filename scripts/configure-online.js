'use strict';
// Used by Pages CI. Set the repository variable SPLIT_CHESS_SERVER once.
const fs = require('node:fs');
const path = require('node:path');
const raw = (process.env.SPLIT_CHESS_SERVER || '').trim();
if (raw) {
  const url = new URL(raw);
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('SPLIT_CHESS_SERVER must be an HTTPS or WSS server URL without credentials, query or fragment');
  }
  url.protocol = 'wss:';
  if (url.pathname === '/') url.pathname = '/ws';
  const file = path.resolve(__dirname, '../index.html');
  const escaped = url.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const html = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, html.replace(/<meta name="split-chess-server" content="[^"]*">/, '<meta name="split-chess-server" content="' + escaped + '">'));
}
