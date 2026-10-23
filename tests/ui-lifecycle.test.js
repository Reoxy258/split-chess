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
function fixture({ state = E.newGame(), mode = 'local', history = [], rawSave } = {}) {
  const ids = new Map(), timers = [], events = {}, store = new Map();
  store.set(SAVE, rawSave === undefined ? JSON.stringify({version:1,state,mode,quick:false,history}) : rawSave);
  store.set('split-chess.learned.v1', '1');
  class El {
    constructor() {
      this.children = []; this.listeners = {}; this.dataset = {}; this.style = {};
      this.classList = { toggle(){}, add(){} };
    }
    append(v) { this.children.push(v); }
    replaceChildren() { this.children = []; }
    setAttribute(k,v) { this[k] = v; }
    addEventListener(k,v) { this.listeners[k] = v; }
    scrollIntoView() {}
    focus() {}
    showModal() { this.open = true; }
    close() { this.open = false; }
    animate() {}
    click() { if (!this.disabled) (this.onclick || this.listeners.click)?.(); }
  }
  const get = id => { if (!ids.has(id)) ids.set(id, new El()); return ids.get(id); };
  const context = vm.createContext({
    SplitChess:E,
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
  return {get,events,tick,until,save:()=>JSON.parse(store.get(SAVE)),cell:i=>get('board').children[i]};
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
    f.cell(14).click();
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
  f.cell(14).click();
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
