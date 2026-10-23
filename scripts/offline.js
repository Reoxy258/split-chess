'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
// Cache-busted online assets still become fully inline in the offline artifact.
html = html.replace(/((?:href|src)="(?:style\.css|app\.js))\?[^"]*"/g, '$1"');
html = html.replace('<link rel="stylesheet" href="style.css">', '<style>' + fs.readFileSync(path.join(root, 'style.css'), 'utf8') + '</style>');
for (const file of ['engine.js', 'app.js']) html = html.replace('<script src="' + file + '" defer></script>', '<script>' + fs.readFileSync(path.join(root, file), 'utf8').replace(/<\/script/gi, '<\\/script') + '</script>');
// Inline scripts need a ready DOM; keep script execution after the document body.
const scripts = [...html.matchAll(/<script>[\s\S]*?<\/script>/g)].map(m => m[0]);
html = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace('</body>', scripts.join('\n') + '\n</body>');
const destination = path.resolve(root, '..', '分裂棋.html');
fs.writeFileSync(destination, html);
console.log(destination);
