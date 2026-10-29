/* Online transport for 分裂棋: server URL resolution, a reconnecting WebSocket
   session, and deterministic replay of the server move log. UMD like engine.js. */
(function (root) {
  'use strict';
  const SERVER_KEY = 'split-chess.server.v1', NAME_KEY = 'split-chess.name.v1';
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };

  function normalizeUrl(raw) {
    if (raw == null) return null;
    let url = String(raw).trim();
    if (!url) return null;
    if (!/^wss?:\/\//i.test(url)) {
      // Bare host (optionally "host:port"): pick the scheme that matches the page
      // so plain-HTTP self-hosted servers keep working from an HTTP page.
      const scheme = root.location && root.location.protocol === 'https:' ? 'wss://' : 'ws://';
      url = scheme + url.replace(/^\w+:/, '').replace(/^\/+/, '');
    }
    if (root.location && root.location.protocol === 'https:' && /^ws:\/\//i.test(url)) url = 'wss://' + url.slice(5);
    if (/^wss?:\/\/[^\/?#]+\/?$/i.test(url)) url = url.replace(/\/?$/, '/ws'); // the relay always lives at /ws
    return url;
  }

  function defaultServerUrl() {
    const loc = root.location;
    if (!loc) return null;
    try {
      const explicit = normalizeUrl(new URLSearchParams(loc.search).get('server'));
      if (explicit) return explicit;
    } catch { /* search unavailable */ }
    const configured = normalizeUrl(root.document?.querySelector?.('meta[name="split-chess-server"]')?.content);
    if (configured) return configured;
    if (loc.protocol === 'file:' || !loc.host) return null;
    if (/\.github\.io$/i.test(loc.hostname)) return null; // static Pages host: a relay address is required
    return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws';
  }

  function invitation() {
    try {
      const params = new URLSearchParams(root.location.search);
      const code = (params.get('room') || '').trim().toUpperCase();
      return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/.test(code)
        ? { code, server: normalizeUrl(params.get('server')) } : null;
    } catch { return null; }
  }

  function inviteUrl(code, server) {
    try {
      const url = new URL(root.location.href);
      if (!/^https?:$/.test(url.protocol)) return null;
      url.search = ''; url.hash = '';
      url.searchParams.set('room', code);
      // Include the actual relay so invitations work on static and custom hosts,
      // irrespective of the recipient's previously remembered server.
      if (server) url.searchParams.set('server', server);
      return url.href;
    } catch { return null; }
  }

  function engine() {
    if (root.SplitChess) return root.SplitChess;
    if (typeof require === 'function') return require('./engine.js');
    return null;
  }

  /* Rebuild a board from the hub's compact log: latest authoritative state (if any)
     plus trailing moves, then an optional resignation. Stops at a corrupt tail. */
  function replay(resume) {
    const E = engine();
    if (!E || !resume || !Number.isInteger(resume.size)) return null;
    let state = resume.state && E.validateState(resume.state) ? E.copy(resume.state) : E.newGame({ size: resume.size });
    for (const index of Array.isArray(resume.moves) ? resume.moves : []) {
      try { state = E.applyMove(state, index).state; } catch { break; }
    }
    if (resume.resigned && !state.winner) state = { ...E.copy(state), winner: 3 - resume.resigned, resultReason: 'resign' };
    return state;
  }

  class Session {
    constructor({ url, onEvent }) {
      this.url = url; this.onEvent = onEvent;
      this.ws = null; this.open = false;
      this.role = 0; this.token = null; this.room = null;
      this.pending = null;  // intent re-sent after every reconnect
      this.active = false;  // inside a room: reconnects are automatic
      this.backoff = 500; this.reconnectTimer = null;
      this.heartbeat = null; this.pings = 0; this.lastInbound = 0;
      this.initialTimeout = null;
    }
    emit(type, data) { try { this.onEvent?.(type, data); } catch { /* listener errors must not break the transport */ } }
    connect() {
      if (this.ws) return;
      this.emit('state', this.room ? 'reconnecting' : 'connecting');
      let ws;
      try { ws = new root.WebSocket(this.url); } catch { this.scheduleReconnect(); return; }
      this.ws = ws;
      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.open = true; this.backoff = 500; this.lastInbound = Date.now();
        this.emit('state', 'online');
        this.startHeartbeat();
        if (this.pending) this.rawSend(this.pending);
      };
      ws.onmessage = event => { if (this.ws === ws) this.dispatch(event.data); };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.open = false; this.ws = null; this.stopHeartbeat();
        this.emit('state', this.active ? 'reconnecting' : 'offline');
        this.scheduleReconnect();
      };
      ws.onerror = () => { try { ws.close(); } catch { /* closing */ } };
    }
    scheduleReconnect() {
      if (this.reconnectTimer || !this.active) return;
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, 8000);
    }
    startHeartbeat() {
      this.stopHeartbeat();
      this.heartbeat = setInterval(() => {
        if (!this.open) return;
        if (Date.now() - this.lastInbound > 45000) { try { this.ws.close(); } catch { /* dead link */ } return; }
        this.pings++;
        this.rawSend({ t: 'ping', n: this.pings });
      }, 20000);
    }
    stopHeartbeat() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } }
    rawSend(obj) {
      if (!this.ws || !this.open) return false;
      try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
    }
    isOpen() { return !!(this.ws && this.open); }
    waitForRoom() {
      this.initialTimeout = setTimeout(() => {
        if (!this.active || this.room) return;
        this.giveUp();
        this.emit('error', { code: 'unavailable' });
      }, 90000);
    }
    create({ size, name }) {
      this.pending = { t: 'create', size, name: name ?? '' };
      this.active = true;
      this.connect();
      this.waitForRoom();
    }
    join({ code, name, token }) {
      this.pending = { t: 'join', code: String(code || '').trim().toUpperCase(), name: name ?? '' };
      if (token) this.pending.token = token;
      this.active = true;
      this.connect();
      this.waitForRoom();
    }
    sendMove(index) { return this.rawSend({ t: 'move', index }); }
    sendClock(payload) { return this.rawSend({ t: 'clock', ...payload }); }
    sendStart() { return this.rawSend({ t: 'start' }); }
    resign() { return this.rawSend({ t: 'resign' }); }
    rematch() { return this.rawSend({ t: 'rematch' }); }
    rematchOk() { return this.rawSend({ t: 'rematch-ok' }); }
    restart(size) { return this.rawSend({ t: 'restart', size }); }
    sync() { return this.rawSend({ t: 'sync' }); }
    leave() {
      clearTimeout(this.initialTimeout);
      this.rawSend({ t: 'leave' });
      this.active = false; this.pending = null; this.role = 0; this.token = null; this.room = null;
      this.stopHeartbeat();
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      try { this.ws?.close(); } catch { /* closing */ }
      this.ws = null; this.open = false;
      this.emit('state', 'offline');
    }
    /* Stop retrying without notifying the room (join rejected, room gone). */
    giveUp() {
      clearTimeout(this.initialTimeout);
      this.active = false; this.pending = null;
      this.stopHeartbeat();
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      try { this.ws?.close(); } catch { /* closing */ }
      this.ws = null; this.open = false;
      this.emit('state', 'offline');
    }
    dispatch(raw) {
      this.lastInbound = Date.now();
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'room') {
        clearTimeout(this.initialTimeout);
        this.active = true; this.role = msg.role; this.token = msg.token; this.room = msg.code;
        this.pending = { t: 'join', code: msg.code, token: msg.token, name: this.pending?.name ?? '' };
      }
      this.emit(msg.t, msg);
    }
  }

  const api = {
    Session, replay, normalizeUrl, defaultServerUrl, invitation, inviteUrl,
    seatToken: (code, server) => {
      try { return root.sessionStorage.getItem('split-chess.seat:' + server + ':' + code); } catch { return null; }
    },
    rememberSeat: (code, server, token) => {
      try { root.sessionStorage.setItem('split-chess.seat:' + server + ':' + code, token); } catch { /* storage unavailable */ }
    },
    rememberedServer: () => read(SERVER_KEY),
    rememberServer: url => write(SERVER_KEY, String(url ?? '').trim()),
    rememberedName: () => read(NAME_KEY) || '',
    rememberName: name => write(NAME_KEY, String(name ?? '').slice(0, 12)),
    clampName: raw => String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12),
  };
  root.SplitChessNet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

