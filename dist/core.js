/* TV Links core: loaded by service.js on the TV (Node.js 4, ES5 only). Exports start(opts) / stop(cb).
 * Phone opens http://<TV IP>:8781/ for the touchpad. Pages on the TV listen on /stream (SSE)
 * and receive the phone's events.
 */
var http = require('http');
var os = require('os');
var PORT = 8781;
var clients = [];
var timers = [];

function tvAddr() {
  var ifs = os.networkInterfaces();
  for (var n in ifs) {
    for (var i = 0; i < ifs[n].length; i++) {
      var a = ifs[n][i];
      if (a.family === 'IPv4' && !a.internal) return a.address + ':' + PORT;
    }
  }
  return '?:' + PORT;
}

// ---------- DevTools connection to the page (works on sites whose CSP blocks our SSE) ----------
var net = require('net');
var fs = require('fs');
var crypto = require('crypto');
var cdp = null, cdpId = 0, cdpBusy = false;

function listeningPorts() {
  var ports = [];
  ['/proc/net/tcp', '/proc/net/tcp6'].forEach(function (f) {
    var txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { return; }
    txt.split('\n').slice(1).forEach(function (l) {
      var p = l.trim().split(/\s+/);
      if (p.length < 4 || p[3] !== '0A') return;
      var port = parseInt(p[1].split(':')[1], 16);
      if (port && port !== PORT && port !== 26101 && ports.indexOf(port) < 0) ports.push(port);
    });
  });
  return ports;
}

function tvIp() { return tvAddr().split(':')[0]; }

function getJson(host, port, path, cb) {
  var done = false;
  var req = http.get({ host: host, port: port, path: path, headers: { Host: host + ':' + port } }, function (res) {
    var b = '';
    res.on('data', function (c) { b += c; });
    res.on('end', function () { if (done) return; done = true; try { cb(null, JSON.parse(b)); } catch (e) { cb(e); } });
  });
  req.setTimeout(800, function () { req.abort(); });
  req.on('error', function (e) { if (!done) { done = true; cb(e); } });
}

function findPage(cb) {
  var ports = listeningPorts(), hosts = ['127.0.0.1', tvIp()], jobs = [], i = 0;
  ports.forEach(function (p) { hosts.forEach(function (h) { jobs.push([h, p]); }); });
  (function next() {
    if (i >= jobs.length) return cb(null);
    var job = jobs[i++];
    getJson(job[0], job[1], '/json/list', function (err, list) {
      if (!err && list && list.length) {
        for (var k = 0; k < list.length; k++) {
          if (list[k].webSocketDebuggerUrl && (!list[k].type || list[k].type === 'page')) return cb(list[k].webSocketDebuggerUrl);
        }
      }
      next();
    });
  })();
}

function wsConnect(url, onOpen, onClose) {
  var m = /^ws:\/\/([^:\/]+):(\d+)(\/.*)$/.exec(url);
  if (!m) return onClose();
  var sock = net.connect(+m[2], m[1]);
  var key = crypto.randomBytes(16).toString('base64');
  var buf = new Buffer(0), open = false, closed = false;
  function close() { if (closed) return; closed = true; try { sock.destroy(); } catch (e) {} onClose(); }
  sock.on('connect', function () {
    sock.write('GET ' + m[3] + ' HTTP/1.1\r\nHost: ' + m[1] + ':' + m[2] + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  sock.on('data', function (d) {
    buf = Buffer.concat([buf, d]);
    if (!open) {
      var idx = buf.toString('binary').indexOf('\r\n\r\n');
      if (idx < 0) return;
      if (buf.toString('utf8', 0, idx).indexOf(' 101') < 0) return close();
      buf = buf.slice(idx + 4); open = true;
      onOpen(function send(text) {
        var payload = new Buffer(text, 'utf8'), len = payload.length, head;
        if (len < 126) { head = new Buffer(2); head[1] = 0x80 | len; }
        else if (len < 65536) { head = new Buffer(4); head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
        else { head = new Buffer(10); head[1] = 0x80 | 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
        head[0] = 0x81;
        var mask = crypto.randomBytes(4);
        for (var i = 0; i < len; i++) payload[i] ^= mask[i % 4];
        try { sock.write(Buffer.concat([head, mask, payload])); } catch (e) { close(); }
      });
    }
    // Discard incoming frames (we never need the replies); answer close frames.
    while (buf.length >= 2) {
      var op = buf[0] & 0x0f, ln = buf[1] & 0x7f, off = 2;
      if (ln === 126) { if (buf.length < 4) return; ln = buf.readUInt16BE(2); off = 4; }
      else if (ln === 127) { if (buf.length < 10) return; ln = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + ln) return;
      buf = buf.slice(off + ln);
      if (op === 8) return close();
    }
  });
  sock.on('error', close);
  sock.on('close', close);
}

var cursorCode = null;
function fetchCursor(cb) {
  if (cursorCode) return cb(cursorCode);
  require('https').get('https://cdn.jsdelivr.net/gh/titan902020/tv-links@main/dist/cursor.js', function (res) {
    var b = ''; res.setEncoding('utf8');
    res.on('data', function (c) { b += c; });
    res.on('end', function () { if (res.statusCode === 200) cursorCode = b; cb(cursorCode); });
  }).on('error', function () { cb(null); });
}

function ensureCdp() {
  if (cdp || cdpBusy) return;
  cdpBusy = true;
  findPage(function (url) {
    if (!url) { cdpBusy = false; return; }
    wsConnect(url, function (send) {
      cdp = send; cdpBusy = false;
      send(JSON.stringify({ id: ++cdpId, method: 'Page.setBypassCSP', params: { enabled: true } }));
      // Inject the cursor ourselves too, into the page's main world and every future document.
      fetchCursor(function (code) {
        if (!code || cdp !== send) return;
        send(JSON.stringify({ id: ++cdpId, method: 'Page.addScriptToEvaluateOnNewDocument', params: { source: code } }));
        send(JSON.stringify({ id: ++cdpId, method: 'Runtime.evaluate', params: { expression: code } }));
      });
    }, function () { cdp = null; cdpBusy = false; });
  });
}
timers.push(setInterval(ensureCdp, 3000));
// Re-inject after navigations: cursor.js does nothing if the page already has it.
timers.push(setInterval(function () {
  if (cdp && cursorCode) cdp(JSON.stringify({ id: ++cdpId, method: 'Runtime.evaluate', params: { expression: cursorCode } }));
}, 2000));

function emit(ev) {
  if (cdp) {
    cdp(JSON.stringify({ id: ++cdpId, method: 'Runtime.evaluate', params: {
      expression: 'window.__tvlHandle&&window.__tvlHandle(' + JSON.stringify(ev) + ')' } }));
    return;
  }
  var line = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (var i = clients.length - 1; i >= 0; i--) {
    try { clients[i].write(line); } catch (e) { clients.splice(i, 1); }
  }
}

timers.push(setInterval(function () {
  for (var i = clients.length - 1; i >= 0; i--) {
    try { clients[i].write(': ping\n\n'); } catch (e) { clients.splice(i, 1); }
  }
}, 15000));

function normalize(t) {
  t = String(t || '').trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (t.indexOf(' ') < 0 && t.indexOf('.') > 0) return 'https://' + t;
  return 'https://www.google.com/search?q=' + encodeURIComponent(t);
}

function clamp(v, a, b) { v = parseInt(v, 10) || 0; return Math.max(a, Math.min(b, v)); }

function api(name, d) {
  if (name === 'move') emit({ t: 'm', dx: clamp(d.dx, -400, 400), dy: clamp(d.dy, -400, 400) });
  else if (name === 'click') emit({ t: 'c' });
  else if (name === 'scroll') emit({ t: 's', dy: clamp(d.dy, -3000, 3000) });
  else if (name === 'text') emit({ t: 'x', v: String(d.t || '').slice(0, 500) });
  else if (name === 'bs') emit({ t: 'bs' });
  else if (name === 'enter') emit({ t: 'e' });
  else if (name === 'back') emit({ t: 'b' });
  else if (name === 'forward') emit({ t: 'f' });
  else if (name === 'reload') emit({ t: 'r' });
  else if (name === 'open') { var u = normalize(d.url); if (!u) return false; emit({ t: 'go', u: u }); }
  else if (name === 'media') emit({ t: 'media', cmd: String(d.cmd), v: Number(d.v) || 0 });
  else return false;
  return true;
}

var PAD = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">',
  '<meta name="apple-mobile-web-app-capable" content="yes"><title>TV Links</title><style>',
  '*{box-sizing:border-box;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}',
  'body{font-family:-apple-system,sans-serif;margin:0;padding:12px;background:#111;color:#eee}',
  '#pad{height:44vh;border-radius:18px;background:#1e1e1e;border:1px solid #333;touch-action:none;display:flex;',
  'align-items:center;justify-content:center;color:#666;font-size:15px;text-align:center}',
  '.row{display:flex;gap:8px;margin-top:8px}.row>*{flex:1}',
  'button{padding:14px 0;font-size:17px;border-radius:12px;border:0;background:#2b2b2b;color:#fff}',
  'button:active{background:#2a7cff}button.p{background:#2a7cff}',
  'input{flex:3;padding:12px;font-size:17px;border-radius:12px;border:0;-webkit-user-select:text;user-select:text}',
  '#st{color:#888;font-size:13px;height:16px;margin-top:6px}</style></head><body>',
  '<div class="row" style="margin-top:0"><input id="u" placeholder="ссылка или поиск"><button id="ub" class="p">Открыть</button></div>',
  '<div id="st"></div>',
  '<div id="pad">Водите пальцем — курсор<br>Касание — клик<br>Два пальца — прокрутка</div>',
  '<div class="row"><button data-a="back">← Назад</button><button data-a="reload">⟳</button><button data-a="forward">Вперёд →</button></div>',
  '<div class="row"><button data-m="play">⏯</button><button data-m="seek" data-v="-10">−10с</button><button data-m="seek" data-v="10">+10с</button><button data-m="full">⛶</button></div>',
  '<div class="row"><button data-m="vol" data-v="-0.1">🔉</button><button data-m="vol" data-v="0.1">🔊</button><button data-s="-600">▲</button><button data-s="600">▼</button></div>',
  '<div class="row"><input id="t" placeholder="текст в поле на ТВ"><button id="tb">Ввести</button><button data-a="bs">⌫</button><button data-a="enter">⏎</button></div>',
  '<script>',
  'var st=document.getElementById("st");',
  'function api(p,b){fetch("/api/"+p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})})',
  '.then(function(r){st.textContent=r.ok?"":"ошибка "+r.status;}).catch(function(){st.textContent="нет связи с ТВ";});}',
  'document.querySelectorAll("[data-a]").forEach(function(b){b.onclick=function(){api(b.dataset.a);};});',
  'document.querySelectorAll("[data-m]").forEach(function(b){b.onclick=function(){api("media",{cmd:b.dataset.m,v:+(b.dataset.v||0)});};});',
  'document.querySelectorAll("[data-s]").forEach(function(b){b.onclick=function(){api("scroll",{dy:+b.dataset.s});};});',
  'function op(){var v=document.getElementById("u").value;if(v){api("open",{url:v});document.getElementById("u").value="";st.textContent="открываю…";}}',
  'document.getElementById("ub").onclick=op;document.getElementById("u").onkeydown=function(e){if(e.key==="Enter")op();};',
  'function tx(){var v=document.getElementById("t").value;if(v){api("text",{t:v});document.getElementById("t").value="";}}',
  'document.getElementById("tb").onclick=tx;document.getElementById("t").onkeydown=function(e){if(e.key==="Enter"){tx();api("enter");}};',
  'var pad=document.getElementById("pad"),lx=0,ly=0,ax=0,ay=0,moved=0,t0=0,two=false,sy=0,acc=0,SPEED=1.8;',
  'pad.addEventListener("touchstart",function(e){e.preventDefault();var t=e.touches[0];lx=t.clientX;ly=t.clientY;moved=0;t0=Date.now();',
  'two=e.touches.length>1;if(two){sy=e.touches[0].clientY;acc=0;}},{passive:false});',
  'pad.addEventListener("touchmove",function(e){e.preventDefault();if(e.touches.length>1){two=true;var y=e.touches[0].clientY;acc+=y-sy;sy=y;',
  'if(Math.abs(acc)>15){api("scroll",{dy:Math.round(-acc*4)});acc=0;}return;}',
  'var t=e.touches[0];ax+=(t.clientX-lx)*SPEED;ay+=(t.clientY-ly)*SPEED;moved+=Math.abs(t.clientX-lx)+Math.abs(t.clientY-ly);lx=t.clientX;ly=t.clientY;},{passive:false});',
  'pad.addEventListener("touchend",function(e){e.preventDefault();if(!two&&moved<8&&Date.now()-t0<300)api("click");if(e.touches.length===0)two=false;},{passive:false});',
  'setInterval(function(){var dx=Math.round(ax),dy=Math.round(ay);if(dx||dy){ax-=dx;ay-=dy;api("move",{dx:dx,dy:dy});}},35);',
  '</script></body></html>'
].join('\n');

function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

var server = http.createServer(function (req, res) {
  var path = req.url.split('?')[0];
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (req.method === 'GET' && (path === '/' || path === '/pad')) return send(res, 200, PAD);
  if (req.method === 'GET' && path === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(': hi\n\n');
    clients.push(res);
    req.on('close', function () { var i = clients.indexOf(res); if (i >= 0) clients.splice(i, 1); });
    res.write('data: ' + JSON.stringify({ t: 'hello', addr: 'http://' + tvAddr() + '/' }) + '\n\n');
    return;
  }
  if (req.method === 'GET' && path === '/status') {
    return send(res, 200, JSON.stringify({ ok: true, version: module.exports.version, pages: clients.length, cdp: !!cdp, addr: tvAddr(),
      ports: listeningPorts() }), 'application/json');
  }
  if (req.method === 'POST' && path === '/admin/reload') {
    send(res, 202, 'reloading');
    if (opts.reload) setTimeout(opts.reload, 100);
    return;
  }
  if (req.method === 'POST' && path.indexOf('/api/') === 0) {
    var body = '';
    req.on('data', function (ch) { body += ch; if (body.length > 8192) req.destroy(); });
    req.on('end', function () {
      var d = {};
      try { d = JSON.parse(body || '{}'); } catch (e) { return send(res, 400, 'bad json'); }
      send(res, api(path.slice(5), d) ? 204 : 400, '');
    });
    return;
  }
  send(res, 404, 'not found');
});

var opts = {};
server.on('error', function (e) { console.log('tv-links service error: ' + e.message); });

module.exports = {
  version: '0.1.4',
  start: function (o) { opts = o || {}; server.listen(PORT, '0.0.0.0'); ensureCdp(); },
  stop: function (cb) {
    timers.forEach(clearInterval);
    clients.forEach(function (c) { try { c.end(); } catch (e) {} });
    clients = [];
    server.close(function () { cb && cb(); });
    setTimeout(function () { cb && cb(); cb = null; }, 1500);
  }
};
