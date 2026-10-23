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
function fixture({ state = E.newGame(), mode = 'local', history = [], rawSave, viewportWidth = 800, surfaceWidth = 800, scrollLeft = 0 } = {}) {
  const ids = new Map(), timers = [], events = {}, store = new Map();
  let resizeCallback;
  store.set(SAVE, rawSave === undefined ? JSON.stringify({version:1,state,mode,quick:false,history}) : rawSave);
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
  const context = vm.createContext({
    SplitChess:E,
    ResizeObserver:class {constructor(callback){resizeCallback=callback;} observe(){resizeCallback();}},
    document:{getElementById:get,createElement:()=>new El(),createElementNS:()=>new El(),querySelectorAll:()=>[],body:new El()},
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
  return {get,events,tick,until,resizeBoard(width){get('board-wrap').clientWidth=width;resizeCallback();},save:()=>JSON.parse(store.get(SAVE)),cell:i=>get('board').children[i]};
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
    f.cell(44).click();
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
  f.cell(44).click();
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


test('ten-by-ten board exposes all cells including the final row and column',async()=>{
  const f=fixture();
  assert.equal(E.BOARD_SIZE,10);
  assert.equal(f.get('board').children.length,100);
  assert.match(f.cell(99)['aria-label'],/第10行第10列/);
  f.cell(99).click(); await f.tick();
  assert.equal(f.save().state.size,10);
  assert.equal(f.save().state.cells[99].owner,1);
  assert.equal(f.save().state.cells[99].count,1);
});

test('legacy six-by-six match and undo history restore centered with two empty rings',()=>{
  const empty=E.newGame({size:6});
  const first=E.applyMove(empty,0).state;
  const second=E.applyMove(first,35).state;
  const f=fixture({state:second,history:[empty,first]});
  const saved=f.save();
  assert.equal(saved.state.size,10);
  assert.equal(saved.state.cells.length,100);
  assert.deepEqual(saved.state.cells[22],{owner:1,count:1});
  assert.deepEqual(saved.state.cells[77],{owner:2,count:1});
  assert.equal(saved.state.lastMove,77);
  assert.deepEqual(saved.state.moves,[1,1]);
  assert.equal(saved.state.turn,1);
  assert.equal(saved.state.ply,2);
  for(let row=0;row<10;row++) for(let col=0;col<10;col++) {
    if(row<2 || row>7 || col<2 || col>7) assert.deepEqual(saved.state.cells[row*10+col],{owner:0,count:0});
  }
  assert.ok(saved.history.every(s=>s.size===10 && s.cells.length===100));
  assert.deepEqual(saved.history[1].cells[22],{owner:1,count:1});
  assert.equal(saved.history[1].lastMove,22);
  f.get('undo-button').click();
  assert.equal(f.save().state.size,10);
  assert.equal(f.save().state.ply,1);
  assert.deepEqual(f.save().state.cells[22],{owner:1,count:1});
  assert.deepEqual(f.save().state.cells[77],{owner:0,count:0});
});


test('small-screen pan hint tracks available width and tutorial target is brought into view',()=>{
  const f=fixture({viewportWidth:280,surfaceWidth:480,scrollLeft:200});
  assert.equal(f.get('board-pan-note').hidden,false);
  f.get('coach-action').click();
  const wrap=f.get('board-wrap'), cellLeft=4*48;
  assert.ok(cellLeft>=wrap.scrollLeft);
  assert.ok(cellLeft+48<=wrap.scrollLeft+wrap.clientWidth);
  assert.ok(wrap.scrollLeft>=0 && wrap.scrollLeft<=200);
  f.resizeBoard(480);
  assert.equal(f.get('board-pan-note').hidden,true);
});

test('keyboard navigation reaches the last row and does not wrap across columns',()=>{
  const f=fixture();
  const arrow=key=>({key,preventDefault(){}});
  f.cell(89).listeners.keydown(arrow('ArrowDown'));
  assert.ok(f.cell(99).focused);
  f.cell(90).listeners.keydown(arrow('ArrowLeft'));
  assert.ok(!f.cell(89).focused);
  f.cell(9).listeners.keydown(arrow('ArrowRight'));
  assert.ok(!f.cell(10).focused);
});
