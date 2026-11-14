/* TV Links service loader (runs on the TV inside TizenBrew, Node.js 4, ES5).
 * Downloads dist/core.js and runs it. POST /admin/reload on the core makes it fetch the latest core
 * again, so updates apply without restarting the TV.
 */
var vm = require('vm');
var https = require('https');
var CORE = 'https://cdn.jsdelivr.net/gh/titan902020/tv-links@main/dist/core.js';
var current = null;

function fetchText(url, cb) {
  https.get(url, function (res) {
    if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode)); }
    var b = '';
    res.setEncoding('utf8');
    res.on('data', function (c) { b += c; });
    res.on('end', function () { cb(null, b); });
  }).on('error', cb);
}

function run(code) {
  var mod = { exports: {} };
  var fn = vm.runInThisContext('(function (module, exports, require) {' + code + '\n})');
  fn(mod, mod.exports, require);
  current = mod.exports;
  current.start({ reload: load });
}

function load() {
  fetchText(CORE, function (err, code) {
    if (err) { setTimeout(load, 10000); return; }
    if (current && current.stop) current.stop(function () { try { run(code); } catch (e) { setTimeout(load, 10000); } });
    else { try { run(code); } catch (e) { setTimeout(load, 10000); } }
  });
}

load();
