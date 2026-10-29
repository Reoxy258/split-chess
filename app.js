/* UI lifecycle. Only completed, stable turns are persisted. */
(() => {
  'use strict';
  const E = SplitChess, $ = id => document.getElementById(id);
  const Net = typeof SplitChessNet !== 'undefined' ? SplitChessNet : null;
  const invitation = Net?.invitation();
  let SIZE = E.BOARD_SIZE, TRAINING_CELL = 0;
  const KEY = 'split-chess.save.v1', SEEN = 'split-chess.learned.v1';
  const read = key => {
    try { if (key === KEY && sessionStorage.getItem(key)) return sessionStorage.getItem(key); } catch { /* unavailable */ }
    try { return localStorage.getItem(key); } catch { return null; }
  };
  const write = (key, value) => {
    // Each tab keeps its own seat even when another tab shares localStorage.
    let saved = false;
    try { if (key === KEY) { sessionStorage.setItem(key, value); saved = true; } } catch { /* unavailable */ }
    try { localStorage.setItem(key, value); return true; } catch { return saved; }
  };
  let state = E.newGame(), mode = 'ai', history = [], busy = false, thinking = false, epoch = 0, worker = null;
  let quick = matchMedia('(prefers-reduced-motion: reduce)').matches, tutorial = -1, tutorialDone = false, beforeTutorial = null, pending = null;
  // 在线对战：session 传输会话；online 房间信息；inbound 远端事件队列；guestClockAt 计时快照时刻。
  let session = null, online = null, inbound = [], guestClockAt = -1, netState = 'offline', rematchAsked = false, clockBeats = 0, myName = '';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const buttons = [];
  let restored = false, clock = E.newClock(), lastTick = performance.now(), lastSave = lastTick;
  try {
    const saved = JSON.parse(read(KEY));
    if (saved && [1, 2, 3].includes(saved.version) && saved.state?.size >= 5 && saved.state.size <= 10 && E.validateState(saved.state) && ['ai', 'local', 'online'].includes(saved.mode)) {
      state = E.copy(saved.state);
      clock = saved.version >= 2 && E.validateClock(saved.clock, state.size) ? { ...saved.clock, paused: saved.clock.started } : E.newClock(state.size); mode = saved.mode; quick = typeof saved.quick === 'boolean' ? saved.quick : quick;
      history = Array.isArray(saved.history) ? saved.history.filter(s => E.validateState(s) && s.size === state.size).map(E.copy).slice(-60) : [];
      if (mode === 'online') history = [];
      if (saved.version === 3 && saved.mode === 'online' && saved.online && typeof saved.online.code === 'string' && saved.online.code.length >= 4 && [1, 2].includes(saved.online.role)) {
        online = { role: saved.online.role, code: saved.online.code.toUpperCase(), token: saved.online.token || null, peerName: saved.online.peerName || '', server: saved.online.server || null, peerGone: true };
      } else if (mode === 'online') mode = 'local';
      restored = true;
    }
  } catch { /* Unavailable or damaged storage starts a fresh match. */ }
  function persist() {
    if (tutorial >= 0) return;
    if (mode === 'online') {
      // 房间还没建立时不落盘：保留玩家此前的单机存档。
      if (!session && !online) return;
      const ok = write(KEY, JSON.stringify({
        version: 3, state, mode, quick, clock, history: [],
        online: { server: session?.url || online?.server || null, code: online?.code || session?.room || null, token: session?.token || online?.token || null, role: online?.role || session?.role || 0, peerName: online?.peerName || '' }
      }));
      $('save-note').textContent = ok ? '在线对局已保存 · 重开页面可重连' : '当前浏览器无法保存';
      return;
    }
    const ok = write(KEY, JSON.stringify({ version: 2, state, mode, quick, clock, history: history.slice(-60) }));
    $('save-note').textContent = ok ? '棋局已自动保存' : '当前浏览器无法保存';
  }

  function clockBlocked() {
    return busy || tutorial >= 0 || document.hidden || ['welcome-dialog', 'rules-dialog', 'confirm-dialog'].some(id => $(id).open);
  }
  function renderClock(view = clock) {
    const format = value => { const seconds = Math.ceil(value / 1000); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
    $('match-time').textContent = format(view.remaining);
    $('turn-time').textContent = Math.ceil(view.turnRemaining / 1000) + '秒';
    $('turn-time-label').textContent = (state.turn === 1 ? '蓝方' : '橙方') + '本手';
    $('clock-phase').textContent = view.overtime ? '加时第 ' + view.overtime + ' 轮' : '整局剩余';
    $('clock-bar').classList.toggle('urgent', view.started && !state.winner && !view.paused && view.turnRemaining <= 5000);
    $('clock-note').textContent = tutorial >= 0 ? '教程不计时' : state.winner ? '对局结束' : !clock.started ? '首次落子或点击开始计时' : clock.paused
      ? (mode === 'online' && online?.role === 2 ? '房主已暂停 · 等待恢复' : '已暂停 · 点击继续对局')
      : busy ? '连锁结算中 · 计时暂停'
      : (mode === 'online' && online?.role === 2 ? '对方计时权威在房主 · 同分加时1分钟' : '到时比点数，同分加时1分钟');
    $('clock-button').textContent = !clock.started ? '开始计时' : clock.paused ? '继续对局' : '暂停';
    $('clock-button').disabled = busy || tutorial >= 0 || !!state.winner || (mode === 'online' && online?.role === 2 && clock.started);
    const limits = E.timeControl(SIZE);
    $('time-plan').textContent = '整局 ' + limits.match / 60000 + ' 分钟 · 每手 ' + limits.turn / 1000 + ' 秒；超时跳过本回合。';
  }
  /* 访客本地插值：两次房主快照之间平滑倒数，不做任何权威判定。 */
  function displayedClock(now = performance.now()) {
    if (mode !== 'online' || online?.role !== 2 || guestClockAt < 0 || !clock.started || clock.paused) return clock;
    const drift = Math.max(0, now - guestClockAt);
    return { ...clock, remaining: Math.max(0, clock.remaining - drift), turnRemaining: Math.max(0, clock.turnRemaining - drift) };
  }
  function syncClock() {
    const now = performance.now(), elapsed = Math.max(0, now - lastTick); lastTick = now;
    if (mode === 'online' && online?.role === 2) { renderClock(displayedClock(now)); drainRemote(); return; } // 计时权威在房主
    if (!clockBlocked()) {
      const result = E.advanceClock(state, clock, elapsed);
      const stateChanged = result.state !== state;
      state = result.state; clock = result.clock;
      if (result.events.length) {
        cancelAsync(); paint(); resetCoach(); normalStatus();
        if (result.events.includes('overtime') && !state.winner) status('双方点数相同，加时一分钟 · 第 ' + clock.overtime + ' 轮加时');
        else if (result.events.includes('turn') && !state.winner) status((state.turn === 1 ? '橙方' : '蓝方') + '超时，跳过本回合 · 轮到' + (state.turn === 1 ? '蓝方' : '橙方'));
        persist(); scheduleAI();
      }
      if (mode === 'online' && session?.isOpen()) {
        if (result.events.length) session.sendClock({ clock: { ...clock }, events: result.events, ...(stateChanged ? { state: { ...state, cells: state.cells.map(c => ({ ...c })) } } : {}) });
        else if (clock.started && !clock.paused && !state.winner && ++clockBeats >= 10) { clockBeats = 0; session.sendClock({ clock: { ...clock } }); }
      }
    }
    renderClock();
    if (!busy && tutorial < 0 && clock.started && now - lastSave >= 1000) { lastSave = now; persist(); }
    drainRemote(); // 双端：每 200ms 兜底处理排队中的远端事件
  }
  function pauseMatch() {
    if (mode === 'online' && online?.role === 2) { if (thinking) cancelAsync(); persist(); return; } // 访客无计时权
    syncClock();
    if (clock.started && !state.winner) clock.paused = true;
    if (thinking) cancelAsync();
    lastTick = performance.now(); paint(); persist();
    if (mode === 'online' && session?.isOpen()) session.sendClock({ clock: { ...clock } }); // 让访客同步看到暂停
  }
  function cancelAsync() {
    epoch++;
    worker?.terminate(); worker = null; thinking = false; busy = false;
    $('flights').replaceChildren();
  }
  function buildBoard() {
    SIZE = state.size;
    const center = Math.floor((SIZE - 1) / 2); TRAINING_CELL = center * SIZE + center;
    buttons.length = 0; $('board').replaceChildren();
    $('board').style.setProperty('--size', SIZE);
    $('board-surface').style.minWidth = (SIZE * 46) + 'px';
    $('board').setAttribute('aria-label', SIZE + '行' + SIZE + '列棋盘');
    $('flights').setAttribute('viewBox', '0 0 ' + SIZE * 100 + ' ' + SIZE * 100);
    $('board-size').value = String(SIZE);
    $('size-label').textContent = SIZE + ' × ' + SIZE;
    $('board-pan-note').textContent = '↔ 左右滑动棋盘，查看完整的 ' + SIZE + ' × ' + SIZE + ' 棋局';
    for (let i = 0; i < SIZE * SIZE; i++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cell'; b.dataset.index = i;
      b.addEventListener('click', () => onCell(i));
      // Arrow keys complement native button Enter/Space activation.
      b.addEventListener('keydown', event => {
        const offsets = { ArrowUp: -SIZE, ArrowDown: SIZE, ArrowLeft: -1, ArrowRight: 1 };
        if (!(event.key in offsets)) return;
        event.preventDefault();
        let next = i + offsets[event.key];
        if (next >= 0 && next < SIZE * SIZE && (Math.abs(offsets[event.key]) === SIZE || Math.floor(next / SIZE) === Math.floor(i / SIZE))) buttons[next].focus();
      });
      buttons.push(b); $('board').append(b);
    }
    updatePanHint();
  }
  function updatePanHint() {
    const wrap = $('board-wrap');
    $('board-pan-note').hidden = wrap.scrollWidth <= wrap.clientWidth + 1;
  }
  function revealCell(index, center = false) {
    const wrap = $('board-wrap');
    if (wrap.scrollWidth <= wrap.clientWidth) return;
    const width = wrap.scrollWidth / SIZE, left = (index % SIZE) * width;
    if (center || left < wrap.scrollLeft || left + width > wrap.scrollLeft + wrap.clientWidth) {
      wrap.scrollTo({ left: Math.max(0, Math.min(wrap.scrollWidth - wrap.clientWidth, left - (wrap.clientWidth - width) / 2)), behavior: 'smooth' });
    }
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updatePanHint).observe($('board-wrap'));
  buildBoard();
  /* 棋子渲染（v1.2.0 · chess-crash 同款）：圆形棋子 + 白色数字点数；
     蓝方天蓝 / 橙方琥珀由 .owner- 决定，三点将裂格变赤红并呼吸脉冲（.cell.critical）。 */
  function pips(count) {
    if (!count) return '';
    return '<span class="stone" aria-hidden="true">' + count + '</span>';
  }
  function paint(cells = state.cells, fx = {}) {
    const onlineLocked = mode === 'online' && (!session?.isOpen() || !online || online.peerGone || state.turn !== online.role);
    const locked = busy || thinking || state.winner || (tutorial < 0 && clock.paused) || (tutorial >= 0 && tutorialDone) || onlineLocked;
    $('board').classList.toggle('locked', busy || thinking);
    $('board').setAttribute('aria-busy', String(busy || thinking));
    cells.forEach((c, i) => {
      const b = buttons[i], enemy = c.owner && c.owner !== state.turn;
      b.className = 'cell owner-' + c.owner + (c.count === 3 ? ' critical' : '') +
        (i === state.lastMove && tutorial < 0 ? ' last' : '') +
        (locked || enemy ? ' blocked' : '') +
        (tutorial >= 0 && !tutorialDone && i === TRAINING_CELL ? ' target' : '') +
        (fx.active?.includes(i) ? ' burst' : '') + (fx.captures?.includes(i) ? ' captured' : '');
      b.innerHTML = pips(c.count);
      b.disabled = !!locked;
      b.setAttribute('aria-label', '第' + (Math.floor(i / SIZE) + 1) + '行第' + (i % SIZE + 1) + '列，' + (c.owner ? (c.owner === 1 ? '蓝方圆子' : '橙方圆子') + c.count + '点' : '空格'));
    });
    const sums = E.totals({ cells });
    [1, 2].forEach(p => {
      $('tiles-' + p).textContent = sums.tiles[p - 1];
      $('points-' + p).textContent = sums.points[p - 1];
      $('player-' + p).classList.toggle('active', !state.winner && state.turn === p);
    });
    $('status-dot').style.background = state.turn === 1 ? 'var(--blue)' : 'var(--orange)';
    $('name-1').textContent = mode === 'ai' ? '你 · 蓝方' : mode === 'online' ? (online?.role === 1 ? '你' + (myName ? '（' + myName + '）' : '') + ' · 蓝方' : (online?.peerName || '对方') + ' · 蓝方') : '蓝方';
    $('name-2').textContent = mode === 'ai' ? '电脑 · 橙方' : mode === 'online' ? (online?.role === 2 ? '你' + (myName ? '（' + myName + '）' : '') + ' · 橙方' : (online?.peerName || '对方') + ' · 橙方') : '橙方';
    $('mode-label').textContent = tutorial >= 0 ? '互动教程' : mode === 'ai' ? '人机对战' : mode === 'online' ? '在线对战' : '同机双人';
    $('move-number').textContent = tutorial >= 0 ? '第 ' + (tutorial + 1) + ' / 4 课' : '第 ' + (state.ply + (state.winner ? 0 : 1)) + ' 手';
    $('mode-ai').classList.toggle('selected', mode === 'ai');
    $('mode-local').classList.toggle('selected', mode === 'local');
    $('mode-online').classList.toggle('selected', mode === 'online');
    $('mode-ai').setAttribute('aria-pressed', String(mode === 'ai'));
    $('mode-local').setAttribute('aria-pressed', String(mode === 'local'));
    $('mode-online').setAttribute('aria-pressed', String(mode === 'online'));
    $('mode-description').textContent = mode === 'ai' ? '你执蓝方先手，电脑执橙方。' : mode === 'online'
      ? (online ? '房间 ' + online.code + ' · ' + (online.role === 1 ? '你执蓝方先行' : '对方执蓝方，你执橙方') : '创建或加入房间，与好友连线对局。')
      : '两人共用屏幕，蓝方先手，轮流落子。';
    const netLine = $('net-line');
    if (mode === 'online') {
      netLine.hidden = false;
      const labels = { connecting: '连接服务器中…', online: '已连接' + (online ? ' · 房间 ' + online.code : ''), reconnecting: '连接断开 · 自动重连中…', offline: '未连接' + (online ? ' · 房间 ' + online.code : '') };
      netLine.textContent = session ? (labels[netState] || '') : (online ? '离线 · 房间 ' + online.code : '等待创建房间');
      netLine.className = 'net-line' + (netState === 'online' ? '' : netState === 'offline' || netState === 'connecting' ? ' down' : ' warn');
    } else netLine.hidden = true;
    $('undo-button').disabled = !history.length || busy || tutorial >= 0 || state.resultReason === 'time' || mode === 'online';
    $('motion-button').textContent = '连锁动画：' + (quick ? '快速' : '标准');
    $('motion-button').setAttribute('aria-pressed', String(quick));
    $('exit-tutorial').hidden = tutorial < 0;
    $('board-size').disabled = tutorial >= 0 || mode === 'online';
    $('restart-button').hidden = mode === 'online';
    $('resign-button').hidden = !(mode === 'online' && session && online && !online.peerGone && !state.winner);
    $('leave-room-button').hidden = mode !== 'online';
    $('invite-button').hidden = mode !== 'online' || !online;
    document.body.classList.toggle('tutorial', tutorial >= 0);
    document.body.classList.toggle('result', !!state.winner && tutorial < 0);
    renderClock();
  }
  function status(text) { $('status').textContent = text; }
  function normalStatus() {
    if (state.winner) status((mode === 'ai' ? state.winner === 1 ? '你赢了！' : '电脑赢下了这一局。' : mode === 'online' ? (state.winner === online?.role ? '你赢了！' : '对方赢下了这一局。') : (state.winner === 1 ? '蓝方' : '橙方') + '获胜！') + (state.resultReason === 'time' ? ' 时间到，点数 ' + E.totals(state).points.join(' : ') : state.resultReason === 'resign' ? (mode === 'online' ? (state.winner === online?.role ? ' · 对方认输' : ' · 你认输了') : ' · 一方认输') : ' 对方棋子已全部清空'));
    else if (clock.paused && tutorial < 0) status('棋局已暂停 · 点击继续对局恢复计时');
    else if (mode === 'online' && tutorial < 0) {
      if (!session?.isOpen()) status('连接中断 · 正在自动重连');
      else if (online?.peerGone) status(online.peerName ? '对方掉线了 · 等待重连或离开房间' : '等待好友加入 · 点击「邀请好友」发送链接');
      else if (state.ply === 0 && online?.role === 1) status('房间已就绪 · 点一个空格，放下你的第一颗棋子');
      else if (state.turn === online?.role) status('轮到你了 · 点空格或己方格，增加一点');
      else status('等待对方落子…');
    }
    else if (thinking) status('电脑正在思考下一步…');
    else if (state.ply === 0) status('点一个空格，放下你的第一颗棋子');
    else status((mode === 'ai' ? state.turn === 1 ? '轮到你了' : '轮到电脑了' : '轮到' + (state.turn === 1 ? '蓝方' : '橙方')) + ' · 点空格或己方格，增加一点');
  }
  function resetCoach() {
    $('coach-kicker').textContent = state.winner ? '这一局，落幕了' : '一看就会 · FOUR TO SPLIT';
    $('coach-title').textContent = state.winner ? (mode === 'ai' && state.winner === 1 ? '漂亮的连锁！' : '再来一次翻盘？') : '三点蓄力，四点出击';
    $('coach-copy').textContent = state.winner ? '每一手都能改变局势。重新开局，试试不同的布局。' : '虚线框标出三点格。再加一点，就会向四方分裂，也能夺走对方的棋子。';
    $('coach-action').textContent = state.winner ? '再来一局 →' : '动手学会 · 互动教程 →';
  }
  function flight(frame, player, duration) {
    const svg = $('flights');
    svg.replaceChildren(); svg.classList.toggle('orange-flight', player === 2);
    if (quick || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (const transfer of frame.transfers || []) {
      const fromX = (transfer.from % SIZE) * 100 + 50, fromY = Math.floor(transfer.from / SIZE) * 100 + 50;
      const toX = (transfer.to % SIZE) * 100 + 50, toY = Math.floor(transfer.to / SIZE) * 100 + 50;
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('r', '6'); dot.setAttribute('cx', String(fromX)); dot.setAttribute('cy', String(fromY)); dot.setAttribute('class', 'flying-dot');
      svg.append(dot);
      dot.animate([{ transform: 'translate(0px,0px)', opacity: 1 }, { transform: 'translate(' + (toX - fromX) + 'px,' + (toY - fromY) + 'px)', opacity: .15 }], { duration, easing: 'ease-out', fill: 'forwards' });
    }
  }
  async function play(index, { remote = false } = {}) {
    const expectedEpoch = epoch, expectedTurn = state.turn;
    if (tutorial < 0) { syncClock(); if (clock.paused || state.winner || epoch !== expectedEpoch || state.turn !== expectedTurn) return; clock.started = true; }
    if (mode === 'online' && tutorial < 0 && !remote) {
      if (!session?.isOpen() || !online || online.peerGone || state.turn !== online.role) return; // 没轮到你或链路不可用
      if (!session.sendMove(index)) return; // 链路刚断：这一手不落
    }
    const id = epoch, player = state.turn;
    let result;
    try { result = E.applyMove(state, index, { trace: true }); } catch { return; }
    const previous = E.copy(state);
    revealCell(index);
    busy = true; thinking = false; paint();
    const duration = quick ? 65 : 300;
    for (let n = 0; n < result.frames.length; n++) {
      if (id !== epoch) return;
      const frame = result.frames[n];
      if (n > 0) {
        status('连锁扩散 · 第 ' + n + ' 波');
        flight(frame, player, duration);
        await sleep(duration * .65);
        if (id !== epoch) return;
      } else status(result.splits ? '四点蓄满，准备分裂…' : '落子完成');
      paint(frame.cells, frame);
      await sleep(n === 0 ? (quick ? 70 : 180) : duration * .4);
      if (id !== epoch) return;
    }
    $('flights').replaceChildren();
    if (tutorial < 0) history = [...history, previous].slice(-60);
    state = result.state; busy = false;
    if (tutorial < 0) clock.turnRemaining = E.timeControl(state.size).turn;
    lastTick = performance.now();
    if (tutorial >= 0) {
      state.turn = 1;
      tutorialDone = true;
      paint();
      status(['落子成功！你为这个格子加了一点。', '四点分裂成四个方向，原格清空。', '敌格变蓝，原来的两点加上一点，成为三点。', '一处引爆，连续分裂。你已经学会了！'][tutorial]);
      $('coach-action').disabled = false;
      $('coach-action').textContent = tutorial === 3 ? '学会了，回到对局 →' : '下一步 →';
      return;
    }
    persist(); paint(); normalStatus(); resetCoach();
    if (result.splits && !state.winner) {
      status('本手分裂 ' + result.splits + ' 次' + (result.captured ? '，夺取 ' + result.captured + ' 格' : '') + ' · ' + (mode === 'ai' && state.turn === 1 ? '轮到你了' : mode === 'ai' ? '轮到电脑' : mode === 'online' ? (state.turn === online?.role ? '轮到你了' : '等待对方落子…') : (state.turn === 1 ? '蓝方' : '橙方') + '落子'));
    }
    scheduleAI();
    if (mode === 'online') drainRemote(); // 本手演出结束，继续处理排队的远端事件
  }
  function onCell(i) {
    const expectedTurn = state.turn, expectedEpoch = epoch;
    if (tutorial < 0) { syncClock(); if (clock.paused || state.turn !== expectedTurn || epoch !== expectedEpoch) return; }
    if (busy || thinking || state.winner || (tutorial >= 0 && tutorialDone)) return;
    if (tutorial >= 0 && i !== TRAINING_CELL) { status('点蓝色描边的格子，试试这一课的动作'); return; }
    if (mode === 'ai' && state.turn === 2 && tutorial < 0) return;
    if (mode === 'online' && tutorial < 0) {
      if (!session?.isOpen() || !online) { status('连接中断 · 正在自动重连，稍候再落子'); return; }
      if (online.peerGone) { status('对方已离开 · 可离开房间另开一局'); return; }
      if (state.turn !== online.role) { status('还没轮到你 · 等待对方落子'); return; }
    }
    if (state.cells[i].owner && state.cells[i].owner !== state.turn) {
      buttons[i].classList.add('wrong');
      status('敌格要靠分裂夺取，请点空格或自己的棋子');
      return;
    }
    void play(i);
  }
  function scheduleAI() {
    if (clock.paused || clockBlocked() || mode !== 'ai' || state.turn !== 2 || state.winner || tutorial >= 0 || busy || thinking) return;
    const id = epoch;
    thinking = true; paint(); normalStatus();
    setTimeout(() => {
      if (id !== epoch || !thinking) return;
      let settled = false;
      const finish = index => {
        if (settled || id !== epoch) return;
        settled = true; worker?.terminate(); worker = null;
        const legal = E.legalMoves(state);
        if (!legal.includes(index)) index = legal[0];
        thinking = false;
        if (index !== undefined) void play(index);
        else { paint(); normalStatus(); }
      };
      const fallback = () => { if (!settled && id === epoch) finish(E.chooseMove(state)); };
      try {
        if (location.protocol === 'file:' || typeof Worker === 'undefined') { fallback(); return; }
        worker = new Worker('ai-worker.js?v=1.3.0');
        worker.onmessage = event => event.data.error ? fallback() : finish(event.data.index);
        worker.onerror = event => { event.preventDefault(); fallback(); };
        worker.postMessage(state);
        setTimeout(fallback, 3000);
      } catch { fallback(); }
    }, 420);
  }
  const lessons = [
    ['01 / 04 · 落子', '给棋盘加一点', '点蓝框里的空格，放下你的第一点。每回合只能增加一点。'],
    ['02 / 04 · 分裂', '第四点，向四方出发', '这里已经有三点。再点一次，看它向上下左右各送出一点。'],
    ['03 / 04 · 吞噬', '把对手变成自己的力量', '点蓝色三点格引爆。扩散会把右侧橙色两点格，变成蓝色三点格。'],
    ['04 / 04 · 连锁', '让一次落子，走得更远', '点蓝色三点格。橙色三点格收到一点后，也会继续分裂！']
  ];
  function loadLesson(n) {
    cancelAsync(); tutorial = n; tutorialDone = false;
    state = E.newGame({ size: SIZE });
    if (n >= 1) state.cells[TRAINING_CELL] = { owner: 1, count: 3 };
    if (n === 2) state.cells[TRAINING_CELL + 1] = { owner: 2, count: 2 };
    if (n === 3) { state.cells[TRAINING_CELL + 1] = { owner: 2, count: 3 }; state.cells[TRAINING_CELL + SIZE + 1] = { owner: 2, count: 3 }; }
    $('coach-kicker').textContent = lessons[n][0];
    $('coach-title').textContent = lessons[n][1];
    $('coach-copy').textContent = lessons[n][2];
    $('coach-action').textContent = '请先点棋盘中的蓝框格';
    $('coach-action').disabled = true;
    $('save-note').textContent = '教程不会覆盖你的棋局';
    paint(); revealCell(TRAINING_CELL, true); status('跟着蓝框试一下 · ' + lessons[n][1]);
  }
  function startTutorial() {
    if (tutorial >= 0) return;
    syncClock();
    cancelAsync();
    if (clock.started) clock.paused = true;
    beforeTutorial = { state: E.copy(state), mode, clock: { ...clock }, history: history.map(E.copy) };
    loadLesson(0);
    $('coach').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function exitTutorial() {
    cancelAsync(); tutorial = -1; tutorialDone = false;
    state = beforeTutorial?.state || E.newGame(); mode = beforeTutorial?.mode || mode; history = beforeTutorial?.history || [];
    clock = beforeTutorial?.clock || E.newClock(state.size);
    beforeTutorial = null; lastTick = performance.now(); buildBoard(); write(SEEN, '1');
    $('coach-action').disabled = false;
    paint(); persist(); resetCoach(); normalStatus(); scheduleAI();
  }
  function startNew(nextMode = mode, size = SIZE) {
    cancelAsync();
    if (tutorial >= 0) { tutorial = -1; beforeTutorial = null; tutorialDone = false; }
    state = E.newGame({ size }); clock = E.newClock(size); lastTick = performance.now(); history = []; mode = nextMode;
    buildBoard();
    $('coach-action').disabled = false;
    paint(); persist(); resetCoach(); normalStatus();
  }
  function askNew(nextMode, size = SIZE) {
    if (!state.ply && !clock.started && !busy && tutorial < 0 && !session) {
      startNew(nextMode, size);
      if (nextMode === 'online') openRoomDialog();
      return;
    }
    pauseMatch();
    pending = () => { if (session) teardownOnline(); startNew(nextMode, size); if (nextMode === 'online') openRoomDialog(); };
    $('confirm-title').textContent = size !== SIZE ? '切换为 ' + size + ' × ' + size + ' 新棋局？' : tutorial >= 0 ? '退出教程，开始新棋局？' : nextMode !== mode ? '切换模式，开始新棋局？' : '重新开始这一局？';
    $('confirm-copy').textContent = tutorial >= 0 ? '选择保留当前棋局，可以留在教程中。' : session ? '将离开当前在线房间' + (nextMode !== 'online' ? '，对方会收到离开通知。' : '，重新创建或加入房间。') : '当前棋局会被替换。选择保留可留下当前进度，计时保持暂停。';
    $('confirm-dialog').showModal();
  }

  /* ---- 在线对战：会话事件、远端事件队列、房间面板 ---- */
  function closeRoomDialog() { if ($('room-dialog').open) $('room-dialog').close(); }
  function roomDialogNote(text, { error = false } = {}) {
    const el = $('room-status');
    el.hidden = false;
    el.className = 'room-status' + (error ? ' error' : '');
    el.textContent = text;
  }
  function showRoomWaiting() {
    $('room-actions').hidden = true;
    const el = $('room-status');
    el.hidden = false;
    el.className = 'room-status';
    el.textContent = '';
    const label = document.createElement('span');
    label.textContent = '房间码';
    const code = document.createElement('b');
    code.className = 'code';
    code.textContent = online.code;
    const link = Net.inviteUrl(online.code, session?.url || online.server);
    $('room-invite').hidden = !link;
    $('room-invite-link').value = link || '';
    $('room-copy-note').textContent = '';
    $('room-copy-link').onclick = () => copyText(link, '邀请链接');
    const actions = document.createElement('span');
    const copy = document.createElement('button');
    copy.className = 'outline';
    copy.textContent = '复制房间码';
    copy.onclick = () => copyText(online.code);
    actions.append(copy);
    const hint = document.createElement('span');
    hint.textContent = '等待好友加入… 发送下方邀请链接，好友点开即可加入。';
    el.append(label, code, actions, hint);
  }
  function copyText(text, label = '房间码') {
    const note = $('room-copy-note');
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => { note.textContent = label + '已复制，发给好友即可'; }, () => { note.textContent = '复制失败，请长按或选中下方链接手动复制；房间码：' + online.code; });
        return;
      }
    } catch { /* 剪贴板不可用：提示手动记录 */ }
    note.textContent = '请选中邀请链接手动复制，或发送房间码：' + online.code;
  }
  function openRoomDialog() {
    if (!Net) { status('此构建不支持在线对战'); return; }
    $('net-name').value = Net.rememberedName();
    $('net-server').value = invitation?.server || Net.rememberedServer() || '';
    $('net-advanced').open = false;
    $('room-invite').hidden = true;
    $('room-actions').hidden = false;
    $('room-code').value = '';
    $('room-status').hidden = true;
    $('room-create').disabled = false;
    $('room-join').disabled = false;
    $('room-dialog').showModal();
    if (session && online) {
      $('room-create').disabled = true; $('room-join').disabled = true;
      showRoomWaiting();
    }
  }
  function startOnlineSession(url, intent) {
    teardownOnline();
    session = new Net.Session({ url, onEvent: netEvent });
    intent(session);
  }
  function teardownOnline() {
    if (session) { session.leave(); session = null; }
    online = null; netState = 'offline'; inbound = []; guestClockAt = -1; rematchAsked = false; clockBeats = 0;
  }
  function leaveToMenu() {
    teardownOnline();
    startNew('ai', SIZE);
    status('已离开房间 · 回到单机人机模式');
  }
  function requestRematch() {
    if (!session?.isOpen() || !online || online.peerGone) { status('对方不在线 · 可离开房间另开一局'); return; }
    if (rematchAsked) { status('已邀请对方再来一局 · 等待确认…'); return; }
    rematchAsked = true;
    session.rematch();
    status('已邀请对方再来一局 · 等待对方确认…');
  }
  function reconcile(resume) {
    if (!Net || !resume) return;
    cancelAsync();
    inbound = [];
    const next = Net.replay(resume);
    if (!next) { status('对局数据异常 · 正在重新同步'); session?.sync(); return; }
    state = next; mode = 'online'; history = [];
    clock = resume.clock && E.validateClock(resume.clock, state.size) ? { ...resume.clock } : E.newClock(state.size);
    guestClockAt = performance.now();
    buildBoard();
    $('coach-action').disabled = false;
    paint(); resetCoach(); normalStatus(); persist();
  }
  let draining = false;
  function queueInbound(item) {
    // 纯时钟快照可合并（只留最新）；带 state/events 的权威事件保序处理。
    if (item.type === 'clock' && !item.data?.state && !item.data?.events) {
      const i = inbound.findIndex(x => x.type === 'clock' && !x.data?.state && !x.data?.events);
      if (i >= 0) inbound.splice(i, 1);
    }
    inbound.push(item);
    drainRemote();
  }
  function drainRemote() {
    if (draining || busy || thinking || tutorial >= 0) return;
    draining = true;
    try {
      for (let guard = 0; inbound.length && guard < 64; guard++) {
        const item = inbound.shift();
        if (item.type === 'move') {
          if (state.winner || !E.legalMoves(state).includes(item.index)) { session?.sync(); status('对局同步中…'); return; }
          void play(item.index, { remote: true });
          if (busy) return; // 连锁动画进行中，结束后继续出队
        } else if (item.type === 'clock') applyRemoteClock(item.data);
        else if (item.type === 'resign') applyResign(item.role);
      }
    } finally { draining = false; }
  }
  function applyRemoteClock(data) {
    if (data.state && E.validateState(data.state) && data.state.size === state.size) state = E.copy(data.state);
    if (data.clock && E.validateClock(data.clock, state.size)) { clock = { ...data.clock }; guestClockAt = performance.now(); }
    if (Array.isArray(data.events) && data.events.length) {
      if (data.events.includes('overtime') && !state.winner) status('双方点数相同，加时一分钟 · 第 ' + clock.overtime + ' 轮加时');
      else if (data.events.includes('turn') && !state.winner) status((state.turn === online?.role ? '你' : '对方') + '超时，跳过本回合 · 轮到' + (state.turn === online?.role ? '你' : '对方'));
    }
    resetCoach(); paint(); normalStatus(); persist();
  }
  function applyResign(role) {
    if (state.winner) return;
    cancelAsync();
    state = { ...E.copy(state), winner: 3 - role, resultReason: 'resign' };
    inbound = [];
    paint(); resetCoach(); normalStatus(); persist();
  }
  function applyRestart(size) {
    cancelAsync();
    inbound = []; rematchAsked = false; guestClockAt = -1; clockBeats = 0;
    state = E.newGame({ size }); clock = E.newClock(size); history = []; mode = 'online'; lastTick = performance.now();
    buildBoard();
    $('coach-action').disabled = false;
    paint(); resetCoach(); normalStatus(); persist();
    status('新的一局开始 · ' + (online?.role === 1 ? '你执蓝方先行' : '对方执蓝方先行'));
  }
  function netEvent(type, data) {
    switch (type) {
      case 'state': {
        netState = data;
        if (data === 'reconnecting') status('连接断开 · 正在自动重连…');
        if ($('room-dialog').open && !online && session?.active) {
          roomDialogNote('正在连接房间服务… 首次启动可能需要约一分钟，请稍候。');
        }
        paint(); normalStatus();
        return;
      }
      case 'room': {
        const names = Array.isArray(data.names) ? data.names : [];
        const peerName = names[3 - data.role - 1] || '';
        online = { role: data.role, code: data.code, token: data.token, server: session?.url || null, peerName, peerGone: Array.isArray(data.connected) ? !data.connected[2 - data.role] : !peerName };
        myName = names[data.role - 1] || myName;
        Net.rememberSeat(data.code, session.url, data.token);
        mode = 'online';
        if (data.resume) reconcile(data.resume);
        else {
          cancelAsync(); inbound = []; rematchAsked = false; guestClockAt = -1;
          state = E.newGame({ size: data.size }); clock = E.newClock(data.size); history = [];
          buildBoard();
          $('coach-action').disabled = false;
          paint(); resetCoach(); normalStatus();
        }
        if (data.phase === 'waiting' && data.role === 1) showRoomWaiting();
        else closeRoomDialog();
        status(data.phase === 'waiting' ? '房间已创建 · 复制邀请链接发给好友，等 TA 加入' : '已连接房间 ' + data.code + ' · ' + (online.role === 1 ? '你执蓝方先行' : '对方执蓝方，你执橙方'));
        persist();
        return;
      }
      case 'peer': {
        if (!online) return;
        online.peerGone = false;
        online.peerName = data.name || online.peerName;
        closeRoomDialog();
        status((data.name || '对方') + ' 已就位 · ' + (online.role === 1 ? '你执蓝方先行，点空格开局' : '对方执蓝方先行'));
        persist(); paint(); normalStatus();
        return;
      }
      case 'peer-left': {
        if (!online) return;
        online.peerGone = true;
        status(data.reason === 'left' ? '对方离开了房间 · 对局结束，可再来一局或离开' : '对方掉线了 · 等待重连');
        paint(); resetCoach(); persist();
        return;
      }
      case 'move': {
        if (mode !== 'online' || !online) return;
        if (data.role === online.role || state.winner || state.turn !== data.role || !E.legalMoves(state).includes(data.index)) {
          session?.sync();
          status('对局状态异常 · 正在重新同步');
          return;
        }
        queueInbound({ type: 'move', index: data.index });
        return;
      }
      case 'clock': {
        if (mode !== 'online' || !online || online.role !== 2) return;
        queueInbound({ type: 'clock', data });
        return;
      }
      case 'start': { // 访客请房主开始计时
        if (mode !== 'online' || online?.role !== 1) return;
        syncClock(); if (state.winner) return;
        if (!clock.started || clock.paused) {
          clock.started = true; clock.paused = false; lastTick = performance.now();
          if (session?.isOpen()) session.sendClock({ clock: { ...clock } });
          paint(); normalStatus(); persist();
        }
        return;
      }
      case 'resigned': {
        if (mode !== 'online' || !online) return;
        queueInbound({ type: 'resign', role: data.role });
        return;
      }
      case 'rematch-req': {
        if (mode !== 'online' || !session) return;
        pending = () => { session?.rematchOk(); };
        $('confirm-title').textContent = '对方想再来一局？';
        $('confirm-copy').textContent = '接受后重开同尺寸新棋局，房主仍执蓝方先行。';
        $('confirm-dialog').showModal();
        return;
      }
      case 'rematch-ack': {
        rematchAsked = false;
        if (session?.isOpen() && mode === 'online') session.restart(SIZE);
        return;
      }
      case 'restart': {
        if (mode !== 'online') return;
        applyRestart(data.size);
        return;
      }
      case 'resume': {
        reconcile(data);
        return;
      }
      case 'error': {
        $('room-actions').hidden = false;
        const text = { unavailable: '连接超时，请检查网络后重试，或联系房主确认联机服务已启动', notfound: '房间不存在或已过期，请让好友重新创建并发送邀请', full: '房间已满，或座位正在等待原玩家重连', ended: '这局棋已结束', busy: '对局进行中', badsize: '服务器拒绝了棋盘尺寸', limit: '服务器房间数已达上限', forbidden: '会话已失效，请重新创建或加入房间', badmsg: '消息被服务器拒绝' }[data.code] || '连接出现错误';
        $('room-create').disabled = false;
        $('room-join').disabled = false;
        if ($('room-dialog').open) roomDialogNote(text, { error: true });
        else status(text);
        if (['notfound', 'full', 'badsize', 'limit', 'forbidden'].includes(data.code)) session?.giveUp();
        return;
      }
      default: return; // pong 等心跳消息
    }
  }

  $('board-size').onchange = () => { const size = Number($('board-size').value); $('board-size').value = String(SIZE); if (Number.isInteger(size) && size >= 5 && size <= 10 && size !== SIZE) askNew(mode, size); };
  $('clock-button').onclick = () => {
    if (busy || tutorial >= 0 || state.winner) return;
    if (mode === 'online' && online?.role === 2) { if (session?.isOpen()) { session.sendStart(); status('已请房主开始计时'); } return; }
    syncClock(); if (state.winner) return;
    if (!clock.started || clock.paused) {
      clock.started = true; clock.paused = false; lastTick = performance.now();
      if (mode === 'online' && session?.isOpen()) session.sendClock({ clock: { ...clock } }); // 访客同步看到开始
      paint(); normalStatus(); persist(); scheduleAI();
    }
    else { pauseMatch(); normalStatus(); }
  };
  $('exit-tutorial').onclick = exitTutorial;
  $('mode-ai').onclick = () => { if (mode !== 'ai') askNew('ai'); };
  $('mode-local').onclick = () => { if (mode !== 'local') askNew('local'); };
  $('mode-online').onclick = () => { if (mode === 'online') { openRoomDialog(); return; } askNew('online'); };
  $('restart-button').onclick = () => { if (mode === 'online') return; askNew(mode); };
  $('resign-button').onclick = () => {
    if (mode !== 'online' || state.winner || !session?.isOpen() || !online || online.peerGone) return;
    pending = () => { session?.resign(); };
    $('confirm-title').textContent = '认输这一局？';
    $('confirm-copy').textContent = '认输后对方获胜；对局结束后可以再来一局。';
    $('confirm-dialog').showModal();
  };
  $('leave-room-button').onclick = () => {
    if (mode !== 'online') return;
    if (session && online && !online.peerGone && !state.winner) {
      pending = leaveToMenu;
      $('confirm-title').textContent = '离开在线房间？';
      $('confirm-copy').textContent = '对方会收到你离开的通知；离开后回到单机人机模式。';
      $('confirm-dialog').showModal();
    } else leaveToMenu();
  };
  $('invite-button').onclick = openRoomDialog;
  $('room-dialog').addEventListener('close', () => { if (!online) { session?.giveUp(); session = null; } });
  $('room-code').addEventListener('keydown', event => { if (event.key === 'Enter') $('room-join').click(); });
  $('room-create').onclick = () => {
    if (!Net) return;
    myName = Net.clampName($('net-name').value);
    Net.rememberName(myName);
    const url = Net.normalizeUrl($('net-server').value) || Net.defaultServerUrl();
    if (!url) { roomDialogNote('联机服务尚未配置。请使用房主发来的邀请链接，或联系网站维护者启用联机服务。', { error: true }); return; }
    Net.rememberServer($('net-server').value.trim());
    roomDialogNote('正在创建房间… 首次连接可能需要约一分钟。');
    $('room-create').disabled = true; $('room-join').disabled = true;
    startOnlineSession(url, s => s.create({ size: SIZE, name: myName }));
  };
  $('room-join').onclick = () => {
    if (!Net) return;
    const code = $('room-code').value.trim().toUpperCase();
    if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/.test(code)) { roomDialogNote('房间码是 5 位：数字与大写字母（不含 0/1/I/L/O）。', { error: true }); return; }
    myName = Net.clampName($('net-name').value);
    Net.rememberName(myName);
    const url = Net.normalizeUrl($('net-server').value) || Net.defaultServerUrl();
    if (!url) { roomDialogNote('联机服务尚未配置。请使用好友发来的完整邀请链接。', { error: true }); return; }
    Net.rememberServer($('net-server').value.trim());
    roomDialogNote('正在加入房间 ' + code + ' …');
    $('room-create').disabled = true; $('room-join').disabled = true;
    const token = Net.seatToken(code, url) || (!invitation && online?.code === code && online.server === url ? online.token : null);
    startOnlineSession(url, s => s.join({ code, name: myName, token }));
  };
  $('confirm-cancel').onclick = () => { pending = null; $('confirm-dialog').close(); };
  $('confirm-ok').onclick = () => { const action = pending; pending = null; $('confirm-dialog').close(); action?.(); };
  $('confirm-dialog').addEventListener('cancel', () => { pending = null; });
  $('help-button').onclick = () => { pauseMatch(); $('rules-dialog').showModal(); };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
  $('replay-tutorial').onclick = () => { $('rules-dialog').close(); startTutorial(); };
  $('coach-action').onclick = () => {
    if (tutorial >= 0) { if (tutorialDone) tutorial === 3 ? exitTutorial() : loadLesson(tutorial + 1); }
    else if (state.winner) {
      if (mode === 'online') { if (session && online && !online.peerGone) requestRematch(); else leaveToMenu(); }
      else askNew(mode);
    }
    else startTutorial();
  };
  $('motion-button').onclick = () => { quick = !quick; paint(); persist(); };
  $('undo-button').onclick = () => {
    if (busy || !history.length || tutorial >= 0 || state.resultReason === 'time' || mode === 'online') return;
    syncClock(); if (state.resultReason === 'time') return;
    cancelAsync();
    state = history.pop();
    if (mode === 'ai' && state.turn === 2 && history.length) state = history.pop();
    paint(); persist(); resetCoach(); normalStatus(); scheduleAI();
  };
  function dismissWelcome(learn) {
    $('welcome-dialog').close(); write(SEEN, '1');
    if (learn) startTutorial(); else scheduleAI();
  }
  $('welcome-learn').onclick = () => dismissWelcome(true);
  $('welcome-play').onclick = () => dismissWelcome(false);
  $('welcome-skip').onclick = () => dismissWelcome(false);
  $('welcome-dialog').addEventListener('cancel', () => { write(SEEN, '1'); scheduleAI(); });
  window.addEventListener('pagehide', () => { pauseMatch(); persist(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseMatch(); else lastTick = performance.now(); });
  setInterval(syncClock, 200);
  paint(); resetCoach(); normalStatus();
  if (restored) persist();
  if (restored && !state.winner && !clock.paused) status('已恢复上次棋局 · ' + (mode === 'ai' ? '轮到' + (state.turn === 1 ? '你' : '电脑') : (state.turn === 1 ? '蓝方' : '橙方') + '落子'));
  if (!invitation && !read(SEEN) && !restored) $('welcome-dialog').showModal();
  else scheduleAI();
  // 存档里带在线房间：静默重连（token 恢复原座，服务器下发棋谱重放）。
  if (invitation) {
    cancelAsync();
    openRoomDialog();
    $('room-code').value = invitation.code;
    $('room-join').disabled = false;
    $('room-join').click();
  } else if (Net && restored && mode === 'online' && online && !state.winner) {
    const url = Net.normalizeUrl(online.server) || Net.defaultServerUrl();
    if (url) {
      status('正在重新连接房间 ' + online.code + ' …');
      session = new Net.Session({ url, onEvent: netEvent });
      session.join({ code: online.code, name: Net.rememberedName() || myName, token: online.token });
    } else status('在线对战需要服务器地址 · 点「在线对战」重新加入');
  }
})();

