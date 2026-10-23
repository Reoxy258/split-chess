'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../engine.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const SAVE = 'split-chess.save.v1';

// A minimal DOM and controlled timers exercise the UI lifecycle without a browser.
// Browser visual and pointer testing remains a separate acceptance step.
function fixture({ state = E.newGame(), mode = 'local', history = [], rawSave, viewportWidth = 800, surfaceWidth = 800, scrollLeft = 0, clock } = {}) {
  const ids = new Map(), timers = [], events = {}, store = new Map();
  let resizeCallback, now = 0;
  const intervals = [], documentEvents = {};
  store.set(SAVE, rawSave === undefined ? JSON.stringify({version:clock ? 2 : 1,state,mode,quick:false,history,clock}) : rawSave);
  store.set('split-chess.learned.v1', '1');
  class El {
    constructor() {
      this.children = []; this.listeners = {}; this.dataset = {}; this.style = { setProperty(key,value) { this[key] = value; } };
      this.classList = { toggle(){}, add(){} };
    }
    append(v) { this.children.push(v); }
    replaceChildren() { this.children = []; }
    setAttribute(k,v) { this[k] = v; }
    addEventListener(k,v) { this.listeners[k] = v; }
    scrollIntoView() {}
    scrollTo(options) { this.scrollLeft = options.left || 0; this.scrollTop = options.top || 0; }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    animate() {}
    click() { if (!this.disabled) (this.onclick || this.listeners.click)?.(); }
  }
  const get = id => { if (!ids.has(id)) ids.set(id, new El()); return ids.get(id); };
  Object.assign(get('board-wrap'), {clientWidth:viewportWidth,scrollWidth:surfaceWidth,scrollLeft});
  const doc = {hidden:false,addEventListener:(key,fn)=>documentEvents[key]=fn,getElementById:get,createElement:()=>new El(),createElementNS:()=>new El(),querySelectorAll:()=>[],body:new El()};
  const context = vm.createContext({
    SplitChess:E,
    ResizeObserver:class {constructor(callback){resizeCallback=callback;} observe(){resizeCallback();}},
    document:doc,
    performance:{now:()=>now},
    setInterval:fn=>intervals.push(fn),
    localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},
    matchMedia:()=>({matches:false}),
    setTimeout:(fn,delay)=>timers.push({fn,delay}),
    window:{addEventListener:(k,v)=>events[k]=v},
    location:{protocol:'file:'}
  });
  vm.runInContext(source, context);
  async function tick() {
    const timer = timers.shift();
    if (timer) timer.fn();
    for (let j = 0; j < 20; j++) await Promise.resolve();
  }
  async function until(predicate) {
    for (let i=0;i<100 && !predicate();i++) await tick();
    assert.ok(predicate(), 'UI should reach the expected settled state');
  }
  return {get,events,tick,until,advance(ms,fire=true){now+=ms;if(fire)intervals.forEach(fn=>fn());},visibility(hidden){doc.hidden=hidden;documentEvents.visibilitychange();},resizeBoard(width){get('board-wrap').clientWidth=width;resizeCallback();},save:()=>JSON.parse(store.get(SAVE)),cell:i=>get('board').children[i]};
}

test('pending animation blocks repeated input and does not persist an uncompleted undo entry', async()=>{
  const f = fixture();
  f.cell(0).click();
  assert.ok(f.get('board').children.every(b=>b.disabled));
  f.cell(0).listeners.click(); // Direct dispatch also reaches the explicit busy guard.
  f.events.pagehide();
  assert.equal(f.save().state.ply,0);
  assert.equal(f.save().history.length,0);
  f.get('motion-button').click();
  assert.equal(f.save().history.length,0);
  await f.tick();
  assert.equal(f.save().state.ply,1);
  assert.equal(f.save().state.cells[0].count,1);
  assert.equal(f.save().history.length,1);
});

test('all four interactive lessons complete and returning restores the untouched match', async()=>{
  const state = E.applyMove(E.newGame(),0).state;
  const f = fixture({state,history:[E.newGame()]});
  f.get('coach-action').click();
  assert.equal(f.get('mode-label').textContent,'互动教程');
  f.cell(0).click();
  assert.match(f.get('status').textContent,/蓝色描边/);
  assert.ok(f.get('coach-action').disabled);
  const expected = [/落子成功/,/原格清空/,/成为三点/,/连续分裂/];
  for(let lesson=0;lesson<4;lesson++) {
    f.cell(24).click();
    await f.until(()=>!f.get('coach-action').disabled);
    assert.match(f.get('status').textContent,expected[lesson]);
    assert.ok(f.get('board').children.every(b=>b.disabled));
    f.get('coach-action').click();
  }
  assert.deepEqual(f.save().state,state);
  assert.equal(f.save().history.length,1);
  assert.equal(f.get('mode-label').textContent,'同机双人');
});

test('opening and leaving the tutorial cancels a pending move without a phantom undo', async()=>{
  const f=fixture();
  f.cell(0).click();
  f.get('coach-action').click();
  f.cell(24).click();
  f.get('exit-tutorial').click();
  await f.tick(); await f.tick();
  assert.equal(f.save().state.ply,0);
  assert.equal(f.save().history.length,0);
  assert.ok(f.get('exit-tutorial').hidden);
  assert.equal(f.get('mode-label').textContent,'同机双人');
});

test('restarting during AI thinking ignores its old scheduled callback', async()=>{
  const f=fixture({mode:'ai'});
  f.cell(0).click(); await f.tick();
  assert.match(f.get('status').textContent,/电脑正在思考/);
  assert.ok(f.get('board').children.every(b=>b.disabled));
  f.get('restart-button').click();
  assert.ok(f.get('confirm-dialog').open);
  f.get('confirm-ok').click(); await f.tick();
  assert.equal(f.save().state.ply,0);
  assert.deepEqual(E.totals(f.save().state).points,[0,0]);
  assert.equal(f.save().history.length,0);
});

test('undo while AI is thinking cancels the reply and restores the human turn', async()=>{
  const f=fixture({mode:'ai'});
  f.cell(0).click(); await f.tick();
  f.get('undo-button').click(); await f.tick();
  assert.equal(f.save().state.ply,0);
  assert.equal(f.save().state.turn,1);
  assert.equal(f.save().history.length,0);
  assert.match(f.get('status').textContent,/第一颗棋子/);
});

test('a restored AI turn resumes once and the next undo removes both completed moves', async()=>{
  const state=E.applyMove(E.newGame(),0).state;
  const f=fixture({state,mode:'ai',history:[E.newGame()]});
  assert.match(f.get('status').textContent,/电脑正在思考/);
  await f.tick(); await f.tick();
  assert.equal(f.save().state.ply,2);
  assert.equal(f.save().state.turn,1);
  assert.equal(f.save().history.length,2);
  f.get('undo-button').click();
  assert.equal(f.save().state.ply,0);
  assert.equal(f.save().history.length,0);
});

test('damaged JSON storage starts a usable fresh match',async()=>{
  const f=fixture({rawSave:'{damaged'});
  f.cell(0).click(); await f.tick();
  assert.equal(f.save().state.ply,1);
  assert.equal(f.save().state.cells[0].owner,1);
});


test('default seven-by-seven board exposes the final row and column',async()=>{
  const f=fixture();
  assert.equal(E.BOARD_SIZE,7);
  assert.equal(f.get('board').children.length,49);
  assert.match(f.cell(48)['aria-label'],/第7行第7列/);
  f.cell(48).click(); await f.tick();
  assert.equal(f.save().state.size,7);
  assert.equal(f.save().state.cells[48].owner,1);
  assert.equal(f.save().state.cells[48].count,1);
});

test('small-screen pan hint tracks available width and tutorial target is brought into view',()=>{
  const f=fixture({viewportWidth:280,surfaceWidth:480,scrollLeft:200});
  assert.equal(f.get('board-pan-note').hidden,false);
  f.get('coach-action').click();
  const wrap=f.get('board-wrap'), cellWidth=480/7, cellLeft=3*cellWidth;
  assert.ok(cellLeft>=wrap.scrollLeft);
  assert.ok(cellLeft+cellWidth<=wrap.scrollLeft+wrap.clientWidth);
  assert.ok(wrap.scrollLeft>=0 && wrap.scrollLeft<=200);
  f.resizeBoard(480);
  assert.equal(f.get('board-pan-note').hidden,true);
});

test('keyboard navigation reaches the last row and does not wrap across columns',()=>{
  const f=fixture();
  const arrow=key=>({key,preventDefault(){}});
  f.cell(41).listeners.keydown(arrow('ArrowDown'));
  assert.ok(f.cell(48).focused);
  f.cell(42).listeners.keydown(arrow('ArrowLeft'));
  assert.ok(!f.cell(41).focused);
  f.cell(6).listeners.keydown(arrow('ArrowRight'));
  assert.ok(!f.cell(7).focused);
});


function runningClock(size=7, remaining=100000, turnRemaining=10000) {
  return {...E.newClock(size),remaining,turnRemaining,started:true,paused:false};
}
function resume(f) { f.get('clock-button').click(); }
function selectSize(f,size) { f.get('board-size').value=String(size);f.get('board-size').onchange(); }

test('legacy six-by-six state and undo history retain their original coordinates',()=>{
  const empty=E.newGame({size:6}),first=E.applyMove(empty,0).state,second=E.applyMove(first,35).state;
  const f=fixture({state:second,history:[empty,first]});
  assert.equal(f.save().version,2);
  assert.equal(f.save().state.size,6);
  assert.equal(f.get('board').children.length,36);
  assert.deepEqual(f.save().state.cells[35],{owner:2,count:1});
  assert.ok(f.save().history.every(s=>s.size===6));
  f.get('undo-button').click();
  assert.equal(f.save().state.ply,1);
  assert.deepEqual(f.save().state.cells[0],{owner:1,count:1});
  assert.deepEqual(f.save().state.cells[35],{owner:0,count:0});
});

test('all selectable sizes rebuild cells, SVG coordinates and their clock limits',()=>{
  const f=fixture();
  const plans={5:[180000,15000],6:[240000,18000],7:[300000,20000],8:[360000,22000],9:[480000,25000],10:[600000,30000]};
  for(const size of [5,6,7,8,9,10]) {
    selectSize(f,size);
    assert.equal(f.get('board').children.length,size*size);
    assert.equal(f.get('flights').viewBox,`0 0 ${size*100} ${size*100}`);
    assert.equal(f.get('board-surface').style.minWidth,`${size*46}px`);
    assert.deepEqual([f.save().clock.remaining,f.save().clock.turnRemaining],plans[size]);
    assert.equal(f.save().clock.started,false);
  }
});

test('size switch cancellation preserves the match and confirmation resets it',async()=>{
  const f=fixture();f.cell(0).click();await f.tick();
  selectSize(f,5);
  assert.ok(f.get('confirm-dialog').open);
  assert.equal(f.get('board-size').value,'7');
  f.get('confirm-cancel').click();
  assert.equal(f.save().state.size,7);
  assert.equal(f.save().state.ply,1);
  selectSize(f,5);f.get('confirm-ok').click();
  assert.equal(f.save().state.size,5);
  assert.equal(f.save().state.ply,0);
  assert.equal(f.save().clock.remaining,180000);
  assert.equal(f.save().history.length,0);
});

test('restored running clock is paused until explicit resume and pause blocks elapsed time',()=>{
  const f=fixture({clock:runningClock()});
  assert.equal(f.save().clock.paused,true);
  f.advance(5000);
  assert.equal(f.save().clock.remaining,100000);
  resume(f);f.advance(1000);
  assert.equal(f.save().clock.remaining,99000);
  f.get('clock-button').click();f.advance(9000);
  assert.equal(f.save().clock.remaining,99000);
  assert.ok(f.get('board').children.every(b=>b.disabled));
});

test('turn deadline skips once and does not place a late click for the next player',async()=>{
  const f=fixture({clock:runningClock(7,100000,1000)});resume(f);
  f.advance(1000,false); // No interval: onCell itself must notice this deadline.
  f.cell(0).click();await f.tick();
  assert.equal(f.save().state.turn,2);
  assert.equal(f.save().state.skipped,1);
  assert.equal(f.save().state.cells[0].count,0);
  assert.equal(f.save().history.length,0);
});

test('a stale AI callback crossing the deadline cannot place for the human',async()=>{
  const state=E.applyMove(E.newGame(),0).state;
  const f=fixture({state,mode:'ai',clock:runningClock(7,100000,1000)});resume(f);
  f.advance(1000,false);await f.tick();await f.tick();
  assert.equal(f.save().state.turn,1);
  assert.equal(f.save().state.skipped,1);
  assert.equal(E.totals(f.save().state).points.reduce((a,b)=>a+b),1);
});

test('match deadline declares the point leader and equal points enter overtime',()=>{
  const state=E.applyMove(E.newGame(),0).state;
  const leader=fixture({state,clock:runningClock(7,1000,10000)});resume(leader);leader.advance(1000);
  assert.equal(leader.save().state.winner,1);
  assert.equal(leader.save().state.resultReason,'time');
  assert.ok(leader.get('undo-button').disabled);
  const tie=fixture({clock:runningClock(7,1000,10000)});resume(tie);tie.advance(1000);
  assert.equal(tie.save().clock.overtime,1);
  assert.equal(tie.save().clock.remaining,60000);
  assert.equal(tie.save().state.winner,0);
  assert.match(tie.get('status').textContent,/加时一分钟/);
});

test('animation and tutorial time do not consume the match clock',async()=>{
  const f=fixture({clock:runningClock()});resume(f);
  f.cell(0).click();f.advance(5000);await f.tick();
  assert.equal(f.save().clock.remaining,100000);
  f.get('coach-action').click();f.advance(10000);
  f.get('exit-tutorial').click();
  assert.equal(f.save().clock.remaining,100000);
  assert.equal(f.save().clock.paused,true);
});

test('hidden document and pagehide save a paused clock that restores without charging offline time',()=>{
  const f=fixture({clock:runningClock()});resume(f);f.advance(1000);
  f.visibility(true);f.advance(9000);f.visibility(false);
  assert.equal(f.save().clock.paused,true);
  assert.equal(f.save().clock.remaining,99000);
  resume(f);f.events.pagehide();
  const restored=fixture({rawSave:JSON.stringify(f.save())});restored.advance(60000);
  assert.equal(restored.save().clock.paused,true);
  assert.equal(restored.save().clock.remaining,99000);
});
