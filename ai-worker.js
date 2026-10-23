'use strict';
importScripts('engine.js');
self.onmessage = event => {
  try { self.postMessage({ index: SplitChess.chooseMove(event.data) }); }
  catch (error) { self.postMessage({ error: error.message }); }
};
