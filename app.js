/* UI lifecycle. Only completed, stable turns are persisted. */
(() => {
  'use strict';
  const E = SplitChess, $ = id => document.getElementById(id);
  let SIZE = E.BOARD_SIZE, TRAINING_CELL = 0;
  const KEY = 'split-chess.save.v1', SEEN = 'split-chess.learned.v1';
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };
  let state = E.newGame(), mode = 'ai', history = [], busy = false, thinking = false, epoch = 0, worker = null;
  let quick = matchMedia('(prefers-reduced-motion: reduce)').matches, tutorial = -1, tutorialDone = false, beforeTutorial = null, pending = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const buttons = [];
  let restored = false, clock = E.newClock(), lastTick = performance.now(), lastSave = lastTick;
  try {
    const saved = JSON.parse(read(KEY));
    if (saved && [1, 2].includes(saved.version) && saved.state?.size >= 5 && saved.state.size <= 10 && E.validateState(saved.state) && ['ai', 'local'].includes(saved.mode)) {
      state = E.copy(saved.state);
      clock = saved.version === 2 && E.validateClock(saved.clock, state.size) ? { ...saved.clock, paused: saved.clock.started } : E.newClock(state.size); mode = saved.mode; quick = typeof saved.quick === 'boolean' ? saved.quick : quick;
      history = Array.isArray(saved.history) ? saved.history.filter(s => E.validateState(s) && s.size === state.size).map(E.copy).slice(-60) : [];
      restored = true;
    }
  } catch { /* Unavailable or damaged storage starts a fresh match. */ }
  function persist() {
    if (tutorial >= 0) return;
    const ok = write(KEY, JSON.stringify({ version: 2, state, mode, quick, clock, history: history.slice(-60) }));
    $('save-note').textContent = ok ? '棋局已自动保存' : '当前浏览器无法保存';
  }

  function clockBlocked() {
    return busy || tutorial >= 0 || document.hidden || ['welcome-dialog', 'rules-dialog', 'confirm-dialog'].some(id => $(id).open);
  }
  function renderClock() {
    const format = value => { const seconds = Math.ceil(value / 1000); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); };
    $('match-time').textContent = format(clock.remaining);
    $('turn-time').textContent = Math.ceil(clock.turnRemaining / 1000) + '秒';
    $('turn-time-label').textContent = (state.turn === 1 ? '蓝方' : '橙方') + '本手';
    $('clock-phase').textContent = clock.overtime ? '加时第 ' + clock.overtime + ' 轮' : '整局剩余';
    $('clock-bar').classList.toggle('urgent', clock.started && !state.winner && !clock.paused && clock.turnRemaining <= 5000);
    $('clock-note').textContent = tutorial >= 0 ? '教程不计时' : state.winner ? '对局结束' : !clock.started ? '首次落子或点击开始计时' : clock.paused ? '已暂停 · 点击继续对局' : busy ? '连锁结算中 · 计时暂停' : '到时比点数，同分加时1分钟';
    $('clock-button').textContent = !clock.started ? '开始计时' : clock.paused ? '继续对局' : '暂停';
    $('clock-button').disabled = busy || tutorial >= 0 || !!state.winner;
    const limits = E.timeControl(SIZE);
    $('time-plan').textContent = '整局 ' + limits.match / 60000 + ' 分钟 · 每手 ' + limits.turn / 1000 + ' 秒；超时跳过本回合。';
  }
  function syncClock() {
    const now = performance.now(), elapsed = Math.max(0, now - lastTick); lastTick = now;
    if (!clockBlocked()) {
      const result = E.advanceClock(state, clock, elapsed);
      state = result.state; clock = result.clock;
      if (result.events.length) {
        cancelAsync(); paint(); resetCoach(); normalStatus();
        if (result.events.includes('overtime') && !state.winner) status('双方点数相同，加时一分钟 · 第 ' + clock.overtime + ' 轮加时');
        else if (result.events.includes('turn') && !state.winner) status((state.turn === 1 ? '橙方' : '蓝方') + '超时，跳过本回合 · 轮到' + (state.turn === 1 ? '蓝方' : '橙方'));
        persist(); scheduleAI();
      }
    }
    renderClock();
    if (!busy && tutorial < 0 && clock.started && now - lastSave >= 1000) { lastSave = now; persist(); }
  }
  function pauseMatch() {
    syncClock();
    if (clock.started && !state.winner) clock.paused = true;
    if (thinking) cancelAsync();
    lastTick = performance.now(); paint(); persist();
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
    const locked = busy || thinking || state.winner || (tutorial < 0 && clock.paused) || (tutorial >= 0 && tutorialDone);
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
    $('name-1').textContent = mode === 'ai' ? '你 · 蓝方' : '蓝方';
    $('name-2').textContent = mode === 'ai' ? '电脑 · 橙方' : '橙方';
    $('mode-label').textContent = tutorial >= 0 ? '互动教程' : mode === 'ai' ? '人机对战' : '同机双人';
    $('move-number').textContent = tutorial >= 0 ? '第 ' + (tutorial + 1) + ' / 4 课' : '第 ' + (state.ply + (state.winner ? 0 : 1)) + ' 手';
    $('mode-ai').classList.toggle('selected', mode === 'ai');
    $('mode-local').classList.toggle('selected', mode === 'local');
    $('mode-ai').setAttribute('aria-pressed', String(mode === 'ai'));
    $('mode-local').setAttribute('aria-pressed', String(mode === 'local'));
    $('mode-description').textContent = mode === 'ai' ? '你执蓝方先手，电脑执橙方。' : '两人共用屏幕，蓝方先手，轮流落子。';
    $('undo-button').disabled = !history.length || busy || tutorial >= 0 || state.resultReason === 'time';
    $('motion-button').textContent = '连锁动画：' + (quick ? '快速' : '标准');
    $('motion-button').setAttribute('aria-pressed', String(quick));
    $('exit-tutorial').hidden = tutorial < 0;
    $('board-size').disabled = tutorial >= 0;
    document.body.classList.toggle('tutorial', tutorial >= 0);
    document.body.classList.toggle('result', !!state.winner && tutorial < 0);
    renderClock();
  }
  function status(text) { $('status').textContent = text; }
  function normalStatus() {
    if (state.winner) status((mode === 'ai' ? state.winner === 1 ? '你赢了！' : '电脑赢下了这一局。' : (state.winner === 1 ? '蓝方' : '橙方') + '获胜！') + (state.resultReason === 'time' ? ' 时间到，点数 ' + E.totals(state).points.join(' : ') : ' 对方棋子已全部清空'));
    else if (clock.paused && tutorial < 0) status('棋局已暂停 · 点击继续对局恢复计时');
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
  async function play(index) {
    const expectedEpoch = epoch, expectedTurn = state.turn;
    if (tutorial < 0) { syncClock(); if (clock.paused || state.winner || epoch !== expectedEpoch || state.turn !== expectedTurn) return; clock.started = true; }
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
      status('本手分裂 ' + result.splits + ' 次' + (result.captured ? '，夺取 ' + result.captured + ' 格' : '') + ' · ' + (mode === 'ai' && state.turn === 1 ? '轮到你了' : mode === 'ai' ? '轮到电脑' : (state.turn === 1 ? '蓝方' : '橙方') + '落子'));
    }
    scheduleAI();
  }
  function onCell(i) {
    const expectedTurn = state.turn, expectedEpoch = epoch;
    if (tutorial < 0) { syncClock(); if (clock.paused || state.turn !== expectedTurn || epoch !== expectedEpoch) return; }
    if (busy || thinking || state.winner || (tutorial >= 0 && tutorialDone)) return;
    if (tutorial >= 0 && i !== TRAINING_CELL) { status('点蓝色描边的格子，试试这一课的动作'); return; }
    if (mode === 'ai' && state.turn === 2 && tutorial < 0) return;
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
        worker = new Worker('ai-worker.js?v=1.1.0');
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
    if (!state.ply && !clock.started && !busy && tutorial < 0) { startNew(nextMode, size); return; }
    pauseMatch();
    pending = () => startNew(nextMode, size);
    $('confirm-title').textContent = size !== SIZE ? '切换为 ' + size + ' × ' + size + ' 新棋局？' : tutorial >= 0 ? '退出教程，开始新棋局？' : nextMode !== mode ? '切换模式，开始新棋局？' : '重新开始这一局？';
    $('confirm-copy').textContent = tutorial >= 0 ? '选择保留当前棋局，可以留在教程中。' : '当前棋局会被替换。选择保留可留下当前进度，计时保持暂停。';
    $('confirm-dialog').showModal();
  }
  $('board-size').onchange = () => { const size = Number($('board-size').value); $('board-size').value = String(SIZE); if (Number.isInteger(size) && size >= 5 && size <= 10 && size !== SIZE) askNew(mode, size); };
  $('clock-button').onclick = () => {
    if (busy || tutorial >= 0 || state.winner) return;
    syncClock(); if (state.winner) return;
    if (!clock.started || clock.paused) { clock.started = true; clock.paused = false; lastTick = performance.now(); paint(); normalStatus(); persist(); scheduleAI(); }
    else { pauseMatch(); normalStatus(); }
  };
  $('exit-tutorial').onclick = exitTutorial;
  $('mode-ai').onclick = () => { if (mode !== 'ai') askNew('ai'); };
  $('mode-local').onclick = () => { if (mode !== 'local') askNew('local'); };
  $('restart-button').onclick = () => askNew(mode);
  $('confirm-cancel').onclick = () => { pending = null; $('confirm-dialog').close(); };
  $('confirm-ok').onclick = () => { const action = pending; pending = null; $('confirm-dialog').close(); action?.(); };
  $('confirm-dialog').addEventListener('cancel', () => { pending = null; });
  $('help-button').onclick = () => { pauseMatch(); $('rules-dialog').showModal(); };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close());
  $('replay-tutorial').onclick = () => { $('rules-dialog').close(); startTutorial(); };
  $('coach-action').onclick = () => {
    if (tutorial >= 0) { if (tutorialDone) tutorial === 3 ? exitTutorial() : loadLesson(tutorial + 1); }
    else if (state.winner) askNew(mode);
    else startTutorial();
  };
  $('motion-button').onclick = () => { quick = !quick; paint(); persist(); };
  $('undo-button').onclick = () => {
    if (busy || !history.length || tutorial >= 0 || state.resultReason === 'time') return;
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
  if (!read(SEEN) && !restored) $('welcome-dialog').showModal();
  else scheduleAI();
})();
