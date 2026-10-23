'use strict';
importScripts('engine.js?v=1.1.0');
self.onmessage = event => {
  try { self.postMessage({ index: SplitChess.chooseMove(event.data) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
