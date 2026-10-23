'use strict';
importScripts('engine.js?v=1.0.2');
self.onmessage = event => {
  try { self.postMessage({ index: SplitChess.chooseMove(event.data) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
