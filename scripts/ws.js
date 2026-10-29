'use strict';
/* Minimal RFC 6455 WebSocket server transport. No dependencies, text frames only.
   Client→server frames must be masked (RFC requires it); server→client frames are not.
   Fragmentation is not expected from browsers and is rejected with a protocol error. */
const crypto = require('node:crypto');
const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_TEXT = 1, OP_CLOSE = 8, OP_PING = 9, OP_PONG = 10;
const MAX_PAYLOAD = 1 << 16; // 64 KiB is far above any room message.

function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + MAGIC).digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/* Accept an HTTP upgrade request or reject it on the socket. Returns a connection or null. */
function acceptUpgrade(req, socket, { path = '/ws' } = {}) {
  let ok = req.method === 'GET';
  if (ok) {
    try { ok = new URL(req.url, 'http://localhost').pathname === path; } catch { ok = false; }
  }
  const headers = req.headers;
  const key = headers['sec-websocket-key'];
  const version = headers['sec-websocket-version'];
  const wantsUpgrade = String(headers.upgrade || '').toLowerCase() === 'websocket';
  const connectionUpgrade = String(headers.connection || '').toLowerCase().includes('upgrade');
  if (!ok || !wantsUpgrade || !connectionUpgrade) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return null;
  }
  if (version !== '13') {
    socket.write('HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n'); socket.destroy(); return null;
  }
  if (!key) { socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); socket.destroy(); return null; }
  socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + acceptKey(key) + '\r\n\r\n');
  socket.setNoDelay(true);
  return new WsConnection(socket);
}

class WsConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.onmessage = null; // (text) => void
    this.onclose = null;   // () => void
    this.closed = false;
    this.lastPong = Date.now();
    this.keepalive = null;
    socket.on('data', chunk => { if (!this.closed) this.receive(chunk); });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  receive(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const fin = !!(b0 & 0x80), rsv = b0 & 0x70, opcode = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.protocolError(1009);
        len = Number(big); offset = 10;
      }
      if (len > MAX_PAYLOAD) return this.protocolError(1009);
      if (!masked) return this.protocolError(1002); // Clients must mask.
      if (rsv) return this.protocolError(1002);     // No negotiated extensions.
      if (offset + 4 + len > this.buffer.length) return;
      const maskKey = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + len)); // private copy
      this.buffer = this.buffer.subarray(offset + 4 + len);
      if (!fin && opcode !== OP_TEXT) return this.protocolError(1002); // fragmentation unsupported
      if (!fin) return this.protocolError(1002);
      for (let i = 0; i < len; i++) payload[i] ^= maskKey[i & 3];
      if (opcode === OP_TEXT) { this.onmessage?.(payload.toString('utf8')); continue; }
      if (opcode === OP_PING) { if (len > 125) return this.protocolError(1002); this.rawSend(OP_PONG, payload); continue; }
      if (opcode === OP_PONG) { this.lastPong = Date.now(); continue; }
      if (opcode === OP_CLOSE) {
        this.rawSend(OP_CLOSE, payload.subarray(0, Math.min(2, len)));
        this.shutdown();
        return;
      }
      if (opcode === 2) return this.protocolError(1003); // binary unsupported
      return this.protocolError(1002);
    }
  }
  protocolError(code) {
    const body = Buffer.alloc(2); body.writeUInt16BE(code, 0);
    try { this.socket.write(encodeFrame(OP_CLOSE, body)); } catch { /* closing */ }
    this.shutdown();
  }
  /* Graceful close: flush pending writes, force-destroy after a short grace. */
  shutdown() {
    try { this.socket.end(); } catch { /* already gone */ }
    const killer = setTimeout(() => { try { this.socket.destroy(); } catch { /* already gone */ } }, 1000);
    killer.unref?.();
  }
  rawSend(opcode, payload) { if (!this.closed) try { this.socket.write(encodeFrame(opcode, payload)); } catch { this.finish(); } }
  send(text) { this.rawSend(OP_TEXT, Buffer.from(String(text), 'utf8')); }
  sendPing() { this.rawSend(OP_PING, Buffer.alloc(0)); }
  /* Periodic liveness: drop the connection when two intervals (plus grace) pass without any pong. */
  startKeepalive(intervalMs = 20000) {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      if (Date.now() - this.lastPong > intervalMs * 2 + 1000) { this.socket.destroy(); this.finish(); return; }
      this.sendPing();
    }, intervalMs);
    this.keepalive.unref?.();
  }
  stopKeepalive() { if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; } }
  close() { this.rawSend(OP_CLOSE, Buffer.alloc(0)); this.shutdown(); }
  finish() {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepalive();
    this.buffer = Buffer.alloc(0);
    this.socket.destroy(); // guards against leaking sockets after graceful end or errors
    this.onclose?.();
  }
}

module.exports = { acceptUpgrade, acceptKey, encodeFrame, WsConnection, MAX_PAYLOAD, MAGIC };
