'use strict';
/* Minimal RFC 6455 WebSocket *client* for tests: frames are masked (required),
   server frames arrive unmasked. Uses raw TCP sockets. */
const net = require('node:net');
const crypto = require('node:crypto');

const OP_TEXT = 1, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;

function maskFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  const key = crypto.randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i & 3];
  return Buffer.concat([header, key, masked]);
}

function connect(port, { path = '/ws', host = '127.0.0.1', version = '13', omitKey = false, skipUpgrade = false } = {}) {
  const socket = net.connect(port, host);
  const client = {
    socket, messages: [], closed: false, onopen: null, onmessage: null, onclose: null, onerror: null,
    handshake: null, closeCode: null,
  };
  let buffer = Buffer.alloc(0);
  socket.on('connect', () => {
    if (skipUpgrade) return;
    const headers = [
      'GET ' + path + ' HTTP/1.1', 'Host: ' + host + ':' + port,
      'Upgrade: websocket', 'Connection: Upgrade',
      'Sec-WebSocket-Version: ' + version,
    ];
    if (!omitKey) headers.push('Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==');
    socket.write(headers.join('\r\n') + '\r\n\r\n');
  });
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (client.handshake === null) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.handshake = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 4);
      client.onopen?.(client);
    }
    for (;;) {
      if (buffer.length < 2) return;
      const b0 = buffer[0], b1 = buffer[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + len) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + len));
      buffer = buffer.subarray(offset + len);
      if (opcode === OP_TEXT) { const text = payload.toString('utf8'); if (client.onmessage) client.onmessage(text, client); else client.messages.push(text); }
      else if (opcode === OP_PING) socket.write(maskFrame(OP_PONG, Buffer.alloc(0))); // pong reply
      else if (opcode === OP_CLOSE) { client.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null; socket.destroy(); client.closed = true; client.onclose?.(client); }
    }
  });
  socket.on('error', error => { client.closed = true; client.onerror?.(error); });
  socket.on('close', () => { if (!client.closed) { client.closed = true; client.onclose?.(client); } });
  client.send = text => socket.write(maskFrame(OP_TEXT, Buffer.from(String(text), 'utf8')));
  client.sendRaw = buffer => socket.write(maskFrame(OP_TEXT, buffer));
  client.close = () => socket.destroy();
  return client;
}

module.exports = { connect, maskFrame };
