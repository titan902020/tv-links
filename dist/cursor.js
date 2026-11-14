/* TV Links: cursor injected by TizenBrew into every page and frame.
 * Top frame: draws the cursor, receives phone events from the TV service (SSE on 127.0.0.1:8781)
 * and forwards clicks/scrolls into child frames with postMessage. Child frames act on those messages,
 * so players inside iframes can be clicked too.
 */
(function () {
  var isTop = window.top === window;
  if (isTop ? window.__tvlHandle : window.__tvLinksFrame) return;
  if (!isTop) window.__tvLinksFrame = true;
  var SVC = 'http://127.0.0.1:8781';
  var focused = null;

  function elAt(x, y) { return document.elementFromPoint(x, y); }

  function fire(el, x, y) {
    var o = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (e) {}
    el.dispatchEvent(new MouseEvent('mouseup', o));
    if (el.click) el.click(); else el.dispatchEvent(new MouseEvent('click', o));
  }

  function frameOffset(fr) {
    var r = fr.getBoundingClientRect();
    var cs = getComputedStyle(fr);
    return { x: r.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0),
             y: r.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0) };
  }

  function clickAt(x, y, hide) {
    if (hide) hide(true);
    var el = elAt(x, y);
    if (hide) hide(false);
    if (!el) return;
    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      var o = frameOffset(el);
      try { el.contentWindow.postMessage({ tvl: 'click', x: x - o.x, y: y - o.y }, '*'); } catch (e) {}
      return;
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable) { el.focus(); focused = el; }
    else focused = null;
    if (el.tagName === 'VIDEO') { if (el.paused) el.play(); else el.pause(); return; }
    fire(el, x, y);
  }

  function scrollAt(x, y, dy) {
    var el = elAt(x, y);
    if (el && (el.tagName === 'IFRAME' || el.tagName === 'FRAME')) {
      var o = frameOffset(el);
      try { el.contentWindow.postMessage({ tvl: 'scroll', x: x - o.x, y: y - o.y, dy: dy }, '*'); } catch (e) {}
      return;
    }
    while (el && el !== document.body && el !== document.documentElement) {
      var cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2) { el.scrollTop += dy; return; }
      el = el.parentElement;
    }
    window.scrollBy(0, dy);
  }

  function typeText(t) {
    var el = focused || document.activeElement;
    if (!el || el === document.body) return false;
    if ('value' in el) {
      var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      var v = el.value + t;
      if (setter && setter.set) setter.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) { document.execCommand('insertText', false, t); return true; }
    return false;
  }

  function backspace() {
    var el = focused || document.activeElement;
    if (el && 'value' in el && el.value) {
      el.value = el.value.slice(0, -1);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function enter() {
    var el = focused || document.activeElement;
    if (!el || el === document.body) return false;
    var o = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keypress', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
    if (el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
    return true;
  }

  function media(cmd, v) {
    var vids = document.querySelectorAll('video,audio');
    for (var i = 0; i < vids.length; i++) {
      var m = vids[i];
      if (cmd === 'play') { if (m.paused) m.play(); else m.pause(); }
      else if (cmd === 'vol') m.volume = Math.max(0, Math.min(1, m.volume + v));
      else if (cmd === 'seek') m.currentTime = Math.max(0, m.currentTime + v);
      else if (cmd === 'full') {
        var f = m.requestFullscreen || m.webkitRequestFullscreen || m.webkitEnterFullscreen;
        if (f) try { f.call(m); } catch (e) {}
      }
    }
  }

  // Fullscreen: real fullscreen of the largest video/iframe; if the TV refuses, stretch it over the page.
  var fake = null;
  function biggest() {
    var best = null, area = 0, els = document.querySelectorAll('video,iframe,embed,object');
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect(), a = r.width * r.height;
      if (a > area && r.width > 100 && r.height > 60) { area = a; best = els[i]; }
    }
    return best;
  }
  function stretch(el) {
    fake = { el: el, css: el.style.cssText, html: document.documentElement.style.overflow };
    el.style.cssText += ';position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;' +
      'max-width:none!important;max-height:none!important;z-index:2147483646!important;background:#000!important;margin:0!important;border:0!important';
    document.documentElement.style.overflow = 'hidden';
  }
  // The TV app already fills the screen, so "fullscreen" = stretch the player over the page.
  // Real fullscreen would hide our cursor (only the fullscreen element is drawn).
  function unstretch() { if (fake) { fake.el.style.cssText = fake.css; document.documentElement.style.overflow = fake.html; fake = null; } }
  function toggleFull() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document); return;
    }
    if (fake) { unstretch(); return; }
    var el = biggest(); if (el) stretch(el);
  }
  if (isTop) {
    // If the site's own player button goes real fullscreen, switch to the stretched view so the cursor stays visible.
    var onFs = function () {
      var fe = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fe) return;
      var target = fe === document.documentElement || fe === document.body ? biggest() : fe;
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      if (target && !fake) setTimeout(function () { stretch(target); }, 50);
    };
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
  }

  function broadcast(msg) {
    var fr = document.querySelectorAll('iframe,frame');
    for (var i = 0; i < fr.length; i++) { try { fr[i].contentWindow.postMessage(msg, '*'); } catch (e) {} }
  }

  // Messages from the parent frame (child frames only act on these).
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object' || !d.tvl) return;
    if (d.tvl === 'click') clickAt(d.x, d.y);
    else if (d.tvl === 'scroll') scrollAt(d.x, d.y, d.dy);
    else if (d.tvl === 'text') { if (!typeText(d.v)) broadcast(d); }
    else if (d.tvl === 'bs') { backspace(); broadcast(d); }
    else if (d.tvl === 'enter') { if (!enter()) broadcast(d); }
    else if (d.tvl === 'media') { media(d.cmd, d.v); broadcast(d); }
  });

  if (!isTop) return;

  // ---------- top frame: cursor + connection to the TV service ----------
  var x = innerWidth / 2, y = innerHeight / 2, shown = false, hideTimer = null;
  var c = document.createElement('div');
  c.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:28px;height:36px;pointer-events:none;' +
    'will-change:transform;display:none;background:no-repeat center/contain url("data:image/svg+xml,' +
    encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 36"><path d="M2 2v28l7-7 5 11 5-2-5-11h10z" fill="#fff" stroke="#000" stroke-width="2"/></svg>') + '")';
  var toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;z-index:2147483647;right:24px;bottom:24px;padding:14px 20px;border-radius:12px;' +
    'background:rgba(0,0,0,.8);color:#fff;font:22px sans-serif;pointer-events:none;display:none';
  function attach() { var b = document.body || document.documentElement; b.appendChild(c); b.appendChild(toast); }
  if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
  // Sites like Google focus their search box on load, which pops up the TV keyboard. Undo that once.
  setTimeout(function () {
    var a = document.activeElement;
    if (a && a !== document.body && /^(INPUT|TEXTAREA)$/.test(a.tagName)) a.blur();
  }, 800);

  var pend = false;
  function draw() {
    if (pend) return; pend = true;
    requestAnimationFrame(function () { pend = false; c.style.transform = 'translate(' + (x - 2) + 'px,' + (y - 2) + 'px)'; });
  }
  function show() {
    if (!shown) { c.style.display = 'block'; shown = true; }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { c.style.display = 'none'; shown = false; }, 8000);
  }
  function hide(h) { c.style.visibility = h ? 'hidden' : 'visible'; }
  function say(t, ms) {
    toast.textContent = t; toast.style.display = 'block';
    clearTimeout(say.t); say.t = setTimeout(function () { toast.style.display = 'none'; }, ms || 3000);
  }

  function handle(ev) {
    if (ev.t === 'm') {
      x = Math.max(0, Math.min(innerWidth - 4, x + ev.dx));
      y = Math.max(0, Math.min(innerHeight - 4, y + ev.dy));
      show(); draw();
    } else if (ev.t === 'c') { show(); clickAt(x, y, hide); }
    else if (ev.t === 's') scrollAt(x, y, ev.dy);
    else if (ev.t === 'x') { if (!typeText(ev.v)) broadcast({ tvl: 'text', v: ev.v }); }
    else if (ev.t === 'bs') { backspace(); broadcast({ tvl: 'bs' }); }
    else if (ev.t === 'e') { if (!enter()) broadcast({ tvl: 'enter' }); }
    else if (ev.t === 'b') history.back();
    else if (ev.t === 'f') history.forward();
    else if (ev.t === 'r') location.reload();
    else if (ev.t === 'go') { say('Открываю…'); location.href = ev.u; }
    else if (ev.t === 'media' && ev.cmd === 'full') toggleFull();
    else if (ev.t === 'media') { media(ev.cmd, ev.v); broadcast({ tvl: 'media', cmd: ev.cmd, v: ev.v }); }
    else if (ev.t === 'hello') say('Телефон: ' + ev.addr, 6000);
  }

  // The TV service calls this directly through DevTools (no network from the page, so site CSP does not matter).
  var lastViaCdp = 0;
  window.__tvlHandle = function (ev) { lastViaCdp = Date.now(); handle(ev); };
  window.__tvlVer = 4;

  var es, retry = 1000;
  function connect() {
    try { es = new EventSource(SVC + '/stream?u=' + encodeURIComponent(location.href)); } catch (e) { return; }
    es.onopen = function () { retry = 1000; };
    es.onmessage = function (m) { try { handle(JSON.parse(m.data)); } catch (e) {} };
    es.onerror = function () { es.close(); setTimeout(connect, retry); retry = Math.min(retry * 2, 10000); };
  }
  connect();
})();
