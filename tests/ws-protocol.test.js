'use strict';
/* WebSocket frame protocol and handshake regression over real TCP sockets. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { acceptUpgrade, acceptKey, encodeFrame } = require('../scripts/ws.js');
const { connect, maskFrame } = require('./helpers/ws-client.cjs');

const OP_TEXT = 1;

async function startServer(t, { onMessage } = {}) {
  const server = http.createServer((req, res) => res.writeHead(200).end('ok'));
  const conns = [];
  server.on('upgrade', (req, socket) => {
    const ws = acceptUpgrade(req, socket, { path: '/ws' });
    if (!ws) return;
    conns.push(ws);
    ws.onmessage = text => { onMessage ? onMessage(ws, text) : ws.send('echo:' + text); };
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { conns.forEach(c => { try { c.socket.destroy(); } catch {} }); return new Promise(r => server.close(r)); });
  return { server, port: server.address().port, conns };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function opened(client) {
  if (client.handshake !== null) return client;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no handshake')), 2000);
    client.onopen = () => { clearTimeout(timer); resolve(); };
    client.onclose = () => { clearTimeout(timer); reject(new Error('socket closed before handshake')); };
  });
  return client;
}
async function nextMessage(client, timeout = 2000) {
  if (client.messages.length) return client.messages.shift();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no message')), timeout);
    const prev = client.onmessage;
    client.onmessage = (text, c) => { clearTimeout(timer); client.onmessage = prev; prev?.(text, c); resolve(text); };
  });
}
async function closed(client) {
  if (client.closed) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close')), 3000);
    client.onclose = () => { clearTimeout(timer); resolve(); };
  });
}

test('acceptKey matches the RFC 6455 example vector', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('handshake upgrades and echoes a text frame', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port);
  t.after(() => client.close());
  await opened(client);
  assert.match(client.handshake, /^HTTP\/1\.1 101/);
  assert.match(client.handshake, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  client.send('你好，分裂棋');
  assert.equal(await nextMessage(client), 'echo:你好，分裂棋');
});

test('upgrade to another path is rejected with 400', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port, { path: '/elsewhere' });
  await closed(client);
  assert.match(client.handshake, /^HTTP\/1\.1 400/);
  assert.equal(srv.conns.length, 0);
});

test('wrong websocket version is rejected with 426', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port, { version: '12' });
  await closed(client);
  assert.match(client.handshake, /^HTTP\/1\.1 426/);
});

test('missing Sec-WebSocket-Key is rejected with 400', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port, { omitKey: true });
  await closed(client);
  assert.match(client.handshake, /^HTTP\/1\.1 400/);
});

test('oversize payload is closed with 1009', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port);
  t.after(() => client.close());
  await opened(client);
  client.socket.write(maskFrame(OP_TEXT, Buffer.alloc(70000, 0x61)));
  await closed(client);
  assert.equal(client.closeCode, 1009);
});

test('unmasked client frame is closed with 1002', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port);
  t.after(() => client.close());
  await opened(client);
  client.socket.write(encodeFrame(OP_TEXT, Buffer.from('bad'))); // server-style, no mask
  await closed(client);
  assert.equal(client.closeCode, 1002);
});

test('binary frame is closed with 1003', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port);
  t.after(() => client.close());
  await opened(client);
  client.socket.write(maskFrame(2, Buffer.from([1, 2, 3])));
  await closed(client);
  assert.equal(client.closeCode, 1003);
});

test('fragmented frame is closed with 1002', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port);
  t.after(() => client.close());
  await opened(client);
  const key = Buffer.from([1, 2, 3, 4]);
  const payload = Buffer.from('x'); payload[0] ^= key[0];
  client.socket.write(Buffer.concat([Buffer.from([0x01, 0x81]), key, payload])); // FIN=0
  await closed(client);
  assert.equal(client.closeCode, 1002);
});

test('large text uses extended length and round-trips', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port);
  t.after(() => client.close());
  await opened(client);
  const big = 'b'.repeat(60000);
  client.send(big);
  const reply = await nextMessage(client, 3000);
  assert.equal(reply.length, 60005);
});

test('two frames in one TCP segment both arrive', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port);
  t.after(() => client.close());
  await opened(client);
  client.socket.write(Buffer.concat([maskFrame(OP_TEXT, Buffer.from('one')), maskFrame(OP_TEXT, Buffer.from('two'))]));
  assert.equal(await nextMessage(client), 'echo:one');
  assert.equal(await nextMessage(client), 'echo:two');
});

test('server close finishes the client with a close frame', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port);
  t.after(() => client.close());
  await opened(client);
  srv.conns[0].close();
  await closed(client);
  await wait(30);
  assert.equal(srv.conns[0].closed, true);
});

test('keepalive pings keep a responsive connection alive', async t => {
  const srv = await startServer(t);
  const client = connect(srv.port);
  t.after(() => client.close());
  await opened(client);
  srv.conns[0].startKeepalive(20);
  await wait(150);
  assert.equal(srv.conns[0].closed, false);
  srv.conns[0].stopKeepalive();
});

test('keepalive drops a silent connection', async t => {
  const srv = await startServer(t);
  // Raw socket that completes the handshake but never replies to pings.
  const socket = net.connect(srv.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise(resolve => socket.on('connect', resolve));
  socket.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  await wait(60);
  assert.equal(srv.conns.length, 1);
  srv.conns[0].startKeepalive(20);
  await new Promise(resolve => { srv.conns[0].onclose = resolve; setTimeout(resolve, 2500); });
  assert.equal(srv.conns[0].closed, true);
});
